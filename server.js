const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'pricelist-data.json');

// Токен из переменной окружения MOYSKLAD_TOKEN (как в других ваших проектах)
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
    let body = '';
    req.on('data', c => { body += c; if (body.length > 50e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); } });
    req.on('error', reject);
  });
}
function loadData() {
  try { if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch {}
  return { company: {}, links: [], categories: [] };
}
function saveData(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2), 'utf8'); }

// МойСклад API — Bearer токен (как в moysklad.py)
function msGet(endpoint) {
  return new Promise((resolve, reject) => {
    if (!MS_TOKEN) { reject(new Error('MOYSKLAD_TOKEN не задан')); return; }
    const opts = {
      hostname: 'api.moysklad.ru',
      path: `/api/remap/1.2${endpoint}`,
      headers: {
        'Authorization': `Bearer ${MS_TOKEN}`,
        'Accept-Encoding': 'gzip',
        'Content-Type': 'application/json',
      }
    };
    const req = https.get(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          // Обработка gzip
          const buf = Buffer.concat(chunks);
          let body;
          if (res.headers['content-encoding'] === 'gzip') {
            const zlib = require('zlib');
            body = zlib.gunzipSync(buf).toString('utf8');
          } else {
            body = buf.toString('utf8');
          }
          const data = JSON.parse(body);
          if (res.statusCode !== 200) {
            reject(new Error(data.errors?.[0]?.error || `HTTP ${res.statusCode}`));
          } else {
            resolve(data);
          }
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
  });
}

function msPrice(val) {
  if (!val && val !== 0) return null;
  return Math.round(val / 100);
}

function parseProduct(p) {
  let price = null;
  if (p.salePrices?.length > 0) {
    const sp = p.salePrices.find(x => x.priceType?.name?.includes('продажи')) || p.salePrices[0];
    price = msPrice(sp?.value);
  }
  return {
    id: p.id,
    name: p.name,
    code: p.code || p.article || '',
    price,
    unit: p.uom?.name || 'кг',
    description: p.description || ''
  };
}

async function findProduct(code) {
  const q = encodeURIComponent(code);
  // По коду
  try { const d = await msGet(`/entity/product?filter=code=${q}&limit=5&expand=uom`); if (d.rows?.length) return parseProduct(d.rows[0]); } catch(e) { console.log('by code:', e.message); }
  // По артикулу
  try { const d = await msGet(`/entity/product?filter=article=${q}&limit=5&expand=uom`); if (d.rows?.length) return parseProduct(d.rows[0]); } catch(e) { console.log('by article:', e.message); }
  // По имени (как в moysklad.py — filter=name~query)
  try { const d = await msGet(`/entity/product?filter=name~${q}&limit=5&expand=uom`); if (d.rows?.length) return parseProduct(d.rows[0]); } catch(e) { console.log('by name:', e.message); }
  throw new Error('Товар не найден');
}

async function syncAll(categories) {
  const updated = [];
  for (const cat of categories) {
    for (const p of cat.products || []) {
      if (!p.code) continue;
      try { updated.push(await findProduct(p.code)); } catch {}
    }
  }
  return updated;
}

const MIME = { '.html':'text/html; charset=utf-8', '.js':'application/javascript', '.css':'text/css', '.json':'application/json', '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml', '.ico':'image/x-icon' };
function serveStatic(res, fp) {
  try { const c = fs.readFileSync(fp); res.writeHead(200, {'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream'}); res.end(c); }
  catch { res.writeHead(404); res.end('Not found'); }
}

async function router(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const { pathname, query } = url.parse(req.url, true);

  if (pathname === '/api/pricelist' && req.method === 'GET') return json(res, loadData());
  if (pathname === '/api/pricelist' && req.method === 'POST') { saveData(await readBody(req)); return json(res, {ok:true}); }

  if (pathname === '/api/moysklad/product' && req.method === 'GET') {
    if (!MS_TOKEN) return err(res, 'MOYSKLAD_TOKEN не задан в переменных окружения Railway');
    try { return json(res, await findProduct(query.code || '')); }
    catch(e) { return err(res, e.message, 404); }
  }

  if (pathname === '/api/moysklad/sync' && req.method === 'POST') {
    if (!MS_TOKEN) return err(res, 'MOYSKLAD_TOKEN не задан');
    const data = loadData();
    try {
      const updated = await syncAll(data.categories);
      data.categories.forEach(cat => cat.products?.forEach(p => {
        const u = updated.find(x => x.code === p.code);
        if (u) { p.price = u.price; p.name = u.name; p.unit = u.unit; }
      }));
      saveData(data);
      return json(res, {ok:true, updated: updated.length, products: updated});
    } catch(e) { return err(res, e.message, 500); }
  }

  if (pathname === '/api/moysklad/test' && req.method === 'POST') {
    const body = await readBody(req);
    const saved = MS_TOKEN;
    if (body.token) MS_TOKEN = body.token;
    try {
      const d = await msGet('/entity/employee?limit=1');
      if (d.rows) {
        const cfg = loadData(); cfg._msToken = MS_TOKEN; saveData(cfg);
        return json(res, {ok:true, account: d.rows[0]?.fullName || d.rows[0]?.name});
      }
      throw new Error('Нет данных');
    } catch(e) { MS_TOKEN = saved; return err(res, e.message, 401); }
  }

  if (pathname === '/' || pathname === '/index.html') return serveStatic(res, path.join(__dirname, 'index.html'));
  if (pathname === '/admin' || pathname === '/admin.html') return serveStatic(res, path.join(__dirname, 'admin.html'));
  res.writeHead(404); res.end('Not found');
}

// Загружаем сохранённый токен если нет env
const saved = loadData();
if (!MS_TOKEN && saved._msToken) MS_TOKEN = saved._msToken;

http.createServer(async (req, res) => {
  try { await router(req, res); }
  catch(e) { console.error(e); if (!res.headersSent) { res.writeHead(500); res.end('Internal error'); } }
}).listen(PORT, () => {
  console.log(`🐟 http://localhost:${PORT}`);
  if (!MS_TOKEN) console.warn('⚠️  MOYSKLAD_TOKEN не задан!');
  else console.log('✅ MOYSKLAD_TOKEN загружен');
});
