const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;

// Постоянное хранилище (Railway Volume)
const DATA_DIR = (() => {
  const d = process.env.DATA_DIR || '/app/data';
  try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); return d; } catch { return __dirname; }
})();
const DATA_FILE = path.join(DATA_DIR, 'pricelist-data.json');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
try { if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true }); } catch {}

let MS_TOKEN = process.env.MOYSKLAD_TOKEN || '';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
}
function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
function err(res, msg, status = 400) { json(res, { error: msg }, status); }

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      try { resolve(JSON.parse(buf.toString())); } catch { resolve(buf); }
    });
    req.on('error', reject);
  });
}

function loadData() {
  try { if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch {}
  return { company: {}, links: [], categories: [] };
}
function saveData(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2), 'utf8'); }

// МойСклад API
function msGet(endpoint) {
  return new Promise((resolve, reject) => {
    if (!MS_TOKEN) { reject(new Error('MOYSKLAD_TOKEN не задан')); return; }
    const opts = {
      hostname: 'api.moysklad.ru',
      path: `/api/remap/1.2${endpoint}`,
      headers: { 'Authorization': `Bearer ${MS_TOKEN}`, 'Content-Type': 'application/json' }
    };
    https.get(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          const data = JSON.parse(body);
          if (res.statusCode !== 200) reject(new Error(data.errors?.[0]?.error || `HTTP ${res.statusCode}`));
          else resolve(data);
        } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function msPrice(val) { return (!val && val !== 0) ? null : Math.round(val / 100); }

function parseProduct(p) {
  let price = null;
  if (p.salePrices?.length > 0) {
    const sp = p.salePrices.find(x => x.priceType?.name?.toLowerCase().includes('опт'))
            || p.salePrices.find(x => x.priceType?.name?.toLowerCase().includes('продаж'))
            || p.salePrices[0];
    price = msPrice(sp?.value);
  }
  return { id: p.id, name: p.name, code: p.code || p.article || '', price, unit: p.uom?.name || 'кг', description: p.description || '' };
}

async function findProduct(code) {
  const q = encodeURIComponent(code);
  for (const filter of [`code=${q}`, `article=${q}`, `name~${q}`]) {
    try {
      const d = await msGet(`/entity/product?filter=${filter}&limit=5&expand=uom`);
      if (d.rows?.length) return parseProduct(d.rows[0]);
    } catch {}
  }
  throw new Error('Товар не найден');
}

// ─── UPLOAD IMAGE ─────────────────────────────────────────────
function parseMultipart(body, boundary) {
  const images = [];
  const boundaryBuf = Buffer.from('--' + boundary);
  let start = 0;
  while (true) {
    const idx = body.indexOf(boundaryBuf, start);
    if (idx === -1) break;
    const next = body.indexOf(boundaryBuf, idx + boundaryBuf.length);
    if (next === -1) break;
    const part = body.slice(idx + boundaryBuf.length, next);
    // Find header/body separator
    const sep = part.indexOf(Buffer.from('\r\n\r\n'));
    if (sep === -1) { start = next; continue; }
    const header = part.slice(0, sep).toString();
    const fileData = part.slice(sep + 4, part.length - 2); // remove trailing \r\n
    if (header.includes('filename') && fileData.length > 0) {
      const extMatch = header.match(/filename="[^"]*\.(\w+)"/i);
      const ext = extMatch ? extMatch[1].toLowerCase() : 'jpg';
      const fname = Date.now() + '_' + Math.random().toString(36).slice(2) + '.' + ext;
      const fpath = path.join(UPLOADS_DIR, fname);
      fs.writeFileSync(fpath, fileData);
      images.push('/uploads/' + fname);
    }
    start = next;
  }
  return images;
}

// ─── STATIC ───────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript',
  '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp'
};

function serveStatic(res, fp) {
  try {
    const content = fs.readFileSync(fp);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
    res.end(content);
  } catch { res.writeHead(404); res.end('Not found'); }
}

// ─── ROUTER ───────────────────────────────────────────────────
async function router(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const { pathname, query } = url.parse(req.url, true);

  // Serve uploaded images
  if (pathname.startsWith('/uploads/')) {
    const fname = path.basename(pathname);
    return serveStatic(res, path.join(UPLOADS_DIR, fname));
  }

  if (pathname === '/api/pricelist' && req.method === 'GET') return json(res, loadData());

  if (pathname === '/api/pricelist' && req.method === 'POST') {
    const body = await readBody(req);
    // Strip large base64 images, keep only /uploads/ paths
    if (body.categories) {
      body.categories.forEach(cat => {
        cat.products?.forEach(p => {
          if (p.images) {
            p.images = p.images.filter(img => !img.startsWith('data:'));
          }
        });
      });
    }
    saveData(body);
    return json(res, { ok: true });
  }

  // Upload image
  if (pathname === '/api/upload' && req.method === 'POST') {
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) return err(res, 'No boundary');
    const chunks = [];
    await new Promise(r => { req.on('data', c => chunks.push(c)); req.on('end', r); });
    const body = Buffer.concat(chunks);
    const images = parseMultipart(body, boundaryMatch[1]);
    return json(res, { images });
  }

  if (pathname === '/api/moysklad/product' && req.method === 'GET') {
    if (!MS_TOKEN) return err(res, 'MOYSKLAD_TOKEN не задан');
    try { return json(res, await findProduct(query.code || '')); }
    catch(e) { return err(res, e.message, 404); }
  }

  if (pathname === '/api/moysklad/sync' && req.method === 'POST') {
    if (!MS_TOKEN) return err(res, 'MOYSKLAD_TOKEN не задан');
    const data = loadData();
    let updated = 0;
    for (const cat of data.categories || []) {
      for (const p of cat.products || []) {
        try {
          const u = await findProduct(p.code);
          p.price = u.price; p.name = u.name; p.unit = u.unit;
          updated++;
        } catch {}
      }
    }
    saveData(data);
    return json(res, { ok: true, updated });
  }

  if (pathname === '/api/moysklad/test' && req.method === 'POST') {
    const body = await readBody(req);
    const saved = MS_TOKEN;
    if (body.token) MS_TOKEN = body.token;
    try {
      const d = await msGet('/entity/employee?limit=1');
      if (d.rows) {
        const cfg = loadData(); cfg._msToken = MS_TOKEN; saveData(cfg);
        return json(res, { ok: true, account: d.rows[0]?.fullName || d.rows[0]?.name });
      }
      throw new Error('Нет данных');
    } catch(e) { MS_TOKEN = saved; return err(res, e.message, 401); }
  }

  if (pathname === '/' || pathname === '/index.html') return serveStatic(res, path.join(__dirname, 'index.html'));
  if (pathname === '/admin' || pathname === '/admin.html') return serveStatic(res, path.join(__dirname, 'admin.html'));

  res.writeHead(404); res.end('Not found');
}

const saved = loadData();
if (!MS_TOKEN && saved._msToken) MS_TOKEN = saved._msToken;

http.createServer(async (req, res) => {
  try { await router(req, res); }
  catch(e) { console.error(e); if (!res.headersSent) { res.writeHead(500); res.end('Internal error'); } }
}).listen(PORT, () => {
  console.log(`🐟 http://localhost:${PORT}`);
  if (!MS_TOKEN) console.warn('⚠️  MOYSKLAD_TOKEN не задан!');
});
