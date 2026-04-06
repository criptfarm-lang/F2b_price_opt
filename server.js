/**
 * Прайс-лист — Node.js Backend
 * Запуск: node server.js
 * Переменные окружения: MS_TOKEN (токен МойСклад)
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

// ─── CONFIG ───────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'pricelist-data.json');
let MS_TOKEN = process.env.MS_TOKEN || '';

// ─── CORS HEADERS ─────────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
}

// ─── JSON RESPONSE ────────────────────────────────────────────
function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function err(res, msg, status = 400) {
  json(res, { error: msg }, status);
}

// ─── READ BODY ────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 50e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

// ─── LOAD / SAVE PRICELIST DATA ───────────────────────────────
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
function msRequest(endpoint) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.moysklad.ru',
      path: `/api/remap/1.2${endpoint}`,
      headers: {
        'Authorization': `Bearer ${MS_TOKEN}`,
        'Accept': 'application/json;charset=utf-8',
        'Accept-Encoding': 'gzip'
      }
    };
    https.get(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString();
          const data = JSON.parse(body);
          if (res.statusCode !== 200) reject(new Error(data.errors?.[0]?.error || 'MS API error'));
          else resolve(data);
        } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// Convert МойСклад price from kopecks (min currency unit) to roubles
function msPrice(val) {
  if (!val && val !== 0) return null;
  return Math.round(val / 100);
}

// Extract unit of measurement name
function msUnit(product) {
  return product.uom?.meta?.href
    ? null // will fetch separately if needed
    : product.uom?.name || 'кг';
}

// Find product by code/article
async function findProductByCode(code) {
  // Try by code (артикул)
  const encoded = encodeURIComponent(code);
  const data = await msRequest(`/entity/product?filter=code=${encoded}&limit=5`);
  if (data.rows?.length > 0) return parseProduct(data.rows[0]);

  // Try by name
  const byName = await msRequest(`/entity/product?filter=name=${encoded}&limit=5`);
  if (byName.rows?.length > 0) return parseProduct(byName.rows[0]);

  // Try variants
  const variant = await msRequest(`/entity/variant?filter=code=${encoded}&limit=5`);
  if (variant.rows?.length > 0) return parseProduct(variant.rows[0]);

  throw new Error('Товар не найден');
}

function parseProduct(p) {
  // Find sale price (розничная цена)
  let price = null;
  if (p.salePrices?.length > 0) {
    // First price or "Цена продажи"
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

// Sync all products that are in categories
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

  // ── GET /api/pricelist ── return stored config with MойСклад prices
  if (pathname === '/api/pricelist' && req.method === 'GET') {
    const data = loadData();
    return json(res, data);
  }

  // ── POST /api/pricelist ── save config
  if (pathname === '/api/pricelist' && req.method === 'POST') {
    const body = await readBody(req);
    saveData(body);
    return json(res, { ok: true });
  }

  // ── GET /api/moysklad/product?code=XXX ── lookup single product
  if (pathname === '/api/moysklad/product' && req.method === 'GET') {
    if (!MS_TOKEN) return err(res, 'MS_TOKEN не настроен. Добавьте токен в настройках.');
    try {
      const product = await findProductByCode(query.code || '');
      return json(res, product);
    } catch(e) { return err(res, e.message, 404); }
  }

  // ── POST /api/moysklad/sync ── sync prices for all products in config
  if (pathname === '/api/moysklad/sync' && req.method === 'POST') {
    if (!MS_TOKEN) return err(res, 'MS_TOKEN не настроен');
    const data = loadData();
    try {
      const updated = await syncProducts(data.categories);
      // Update prices in stored data
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

  // ── POST /api/moysklad/test ── test token
  if (pathname === '/api/moysklad/test' && req.method === 'POST') {
    const body = await readBody(req);
    const tokenToTest = body.token || MS_TOKEN;
    const savedToken = MS_TOKEN;
    MS_TOKEN = tokenToTest;
    try {
      const data = await msRequest('/entity/employee?limit=1');
      if (data.rows) {
        // Save token to env / data
        MS_TOKEN = tokenToTest;
        const config = loadData();
        config._msToken = tokenToTest;
        saveData(config);
        return json(res, { ok: true, account: data.rows[0]?.name });
      }
      throw new Error('Invalid response');
    } catch(e) {
      MS_TOKEN = savedToken;
      return err(res, e.message, 401);
    }
  }

  // ── Static files ──
  if (pathname === '/' || pathname === '/index.html') return serveStatic(res, path.join(__dirname, 'index.html'));
  if (pathname === '/admin' || pathname === '/admin.html') return serveStatic(res, path.join(__dirname, 'admin.html'));

  res.writeHead(404); res.end('Not found');
}

// ─── START ────────────────────────────────────────────────────
// Load saved token if exists
const savedData = loadData();
if (savedData._msToken && !MS_TOKEN) MS_TOKEN = savedData._msToken;

http.createServer(async (req, res) => {
  try { await router(req, res); }
  catch(e) { console.error(e); if (!res.headersSent) { res.writeHead(500); res.end('Internal error'); } }
}).listen(PORT, () => {
  console.log(`\n🐟 Прайс-лист запущен: http://localhost:${PORT}`);
  console.log(`📋 Прайс:   http://localhost:${PORT}/`);
  console.log(`⚙️  Админка: http://localhost:${PORT}/admin\n`);
  if (!MS_TOKEN) console.warn('⚠️  MS_TOKEN не задан. Добавьте токен в админке или переменной окружения.');
});
