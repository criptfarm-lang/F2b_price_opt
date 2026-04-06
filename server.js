/**
 * Прайс-лист — Node.js Backend
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'pricelist-data.json');
let MS_TOKEN = process.env.MS_TOKEN || '';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function err(res, msg, status = 400) {
  json(res, { error: msg }, status);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 50e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {}
  return { company: {}, links: [], categories: [] };
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ─── MOYSKLAD API ─────────────────────────────────────────────
// МойСклад HEX-токены передаются как Bearer
function msRequest(endpoint) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.moysklad.ru',
      path: `/api/remap/1.2${endpoint}`,
      headers: {
        'Authorization': `Bearer ${MS_TOKEN}`,
        'Accept': 'application/json;charset=utf-8',
      }
    };
    https.get(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          const data = JSON.parse(body);
          if (res.statusCode !== 200) {
            const errMsg = data.errors?.[0]?.error || `HTTP ${res.statusCode}`;
            console.error(`MS API error [${res.statusCode}] ${endpoint}: ${errMsg}`);
            reject(new Error(errMsg));
          } else {
            resolve(data);
          }
        } catch(e) {
          reject(new Error('Ошибка парсинга ответа МойСклад'));
        }
      });
    }).on('error', reject);
  });
}

function msPrice(val) {
  if (!val && val !== 0) return null;
  return Math.round(val / 100);
}

// Поиск товара по коду, артикулу или названию
async function findProductByCode(code) {
  const encoded = encodeURIComponent(code);

  // 1. По полю "Код"
  try {
    const d = await msRequest(`/entity/product?filter=code=${encoded}&limit=5&expand=uom`);
    if (d.rows?.length > 0) return parseProduct(d.rows[0]);
  } catch(e) { console.log('search by code failed:', e.message); }

  // 2. По полю "Артикул"
  try {
    const d = await msRequest(`/entity/product?filter=article=${encoded}&limit=5&expand=uom`);
    if (d.rows?.length > 0) return parseProduct(d.rows[0]);
  } catch(e) { console.log('search by article failed:', e.message); }

  // 3. По названию
  try {
    const d = await msRequest(`/entity/product?filter=name=${encoded}&limit=5&expand=uom`);
    if (d.rows?.length > 0) return parseProduct(d.rows[0]);
  } catch(e) { console.log('search by name failed:', e.message); }

  // 4. Модификации (variant)
  try {
    const d = await msRequest(`/entity/variant?filter=code=${encoded}&limit=5&expand=uom`);
    if (d.rows?.length > 0) return parseProduct(d.rows[0]);
  } catch(e) { console.log('search variant failed:', e.message); }

  throw new Error('Товар не найден');
}

function parseProduct(p) {
  let price = null;
  if (p.salePrices?.length > 0) {
    const salePrice = p.salePrices.find(sp => sp.priceType?.name?.includes('продажи')) || p.salePrices[0];
    price = msPrice(salePrice?.value);
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

async function syncProducts(categories) {
  const codes = [];
  categories.forEach(cat => cat.products?.forEach(p => { if (p.code) codes.push(p.code); }));
  const updated = [];
  for (const code of codes) {
    try {
      const p = await findProductByCode(code);
      updated.push(p);
    } catch {}
  }
  return updated;
}

// ─── SERVE STATIC ─────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(res, filePath) {
  const ext = path.extname(filePath);
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
}

// ─── ROUTER ───────────────────────────────────────────────────
async function router(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const { pathname, query } = url.parse(req.url, true);

  if (pathname === '/api/pricelist' && req.method === 'GET') {
    return json(res, loadData());
  }

  if (pathname === '/api/pricelist' && req.method === 'POST') {
    const body = await readBody(req);
    saveData(body);
    return json(res, { ok: true });
  }

  if (pathname === '/api/moysklad/product' && req.method === 'GET') {
    if (!MS_TOKEN) return err(res, 'Токен не настроен. Введите токен в разделе API МойСклад.');
    try {
      const product = await findProductByCode(query.code || '');
      return json(res, product);
    } catch(e) { return err(res, e.message, 404); }
  }

  if (pathname === '/api/moysklad/sync' && req.method === 'POST') {
    if (!MS_TOKEN) return err(res, 'Токен не настроен');
    const data = loadData();
    try {
      const updated = await syncProducts(data.categories);
      data.categories.forEach(cat => {
        cat.products?.forEach(p => {
          const u = updated.find(up => up.code === p.code);
          if (u) { p.price = u.price; p.name = u.name; p.unit = u.unit; }
        });
      });
      saveData(data);
      return json(res, { ok: true, updated: updated.length, products: updated });
    } catch(e) { return err(res, e.message, 500); }
  }

  if (pathname === '/api/moysklad/test' && req.method === 'POST') {
    const body = await readBody(req);
    const tokenToTest = body.token || MS_TOKEN;
    const savedToken = MS_TOKEN;
    MS_TOKEN = tokenToTest;
    try {
      const data = await msRequest('/entity/employee?limit=1');
      if (data.rows) {
        MS_TOKEN = tokenToTest;
        const config = loadData();
        config._msToken = tokenToTest;
        saveData(config);
        return json(res, { ok: true, account: data.rows[0]?.name });
      }
      throw new Error('Неверный ответ от МойСклад');
    } catch(e) {
      MS_TOKEN = savedToken;
      return err(res, e.message, 401);
    }
  }

  // Static
  if (pathname === '/' || pathname === '/index.html') return serveStatic(res, path.join(__dirname, 'index.html'));
  if (pathname === '/admin' || pathname === '/admin.html') return serveStatic(res, path.join(__dirname, 'admin.html'));

  res.writeHead(404); res.end('Not found');
}

// ─── START ────────────────────────────────────────────────────
const savedData = loadData();
if (savedData._msToken && !MS_TOKEN) MS_TOKEN = savedData._msToken;

http.createServer(async (req, res) => {
  try { await router(req, res); }
  catch(e) { console.error(e); if (!res.headersSent) { res.writeHead(500); res.end('Internal error'); } }
}).listen(PORT, () => {
  console.log(`\n🐟 Прайс-лист: http://localhost:${PORT}`);
  console.log(`⚙️  Админка:   http://localhost:${PORT}/admin\n`);
  if (!MS_TOKEN) console.warn('⚠️  MS_TOKEN не задан');
});
