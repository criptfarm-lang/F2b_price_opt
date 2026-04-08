const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const zlib = require('zlib');

const PORT = process.env.PORT || 3000;
const DATA_DIR = (() => {
  const d = process.env.DATA_DIR || '/app/data';
  try { if (!fs.existsSync(d)) fs.mkdirSync(d, {recursive:true}); return d; } catch { return __dirname; }
})();
const DATA_FILE = path.join(DATA_DIR, 'pricelist-data.json');
let MS_TOKEN = process.env.MOYSKLAD_TOKEN || '';

// ─── helpers ──────────────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
}
function sendJSON(res, data, status=200) {
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8'});
  res.end(JSON.stringify(data));
}
function sendErr(res, msg, status=400) { sendJSON(res, {error:msg}, status); }
function readBody(req) {
  return new Promise((ok,fail) => {
    let b='';
    req.on('data', c => { b+=c; if(b.length>50e6) req.destroy(); });
    req.on('end', () => { try{ok(JSON.parse(b||'{}'))}catch{ok({})} });
    req.on('error', fail);
  });
}
function loadData() {
  try { if(fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE,'utf8')); } catch{}
  return {company:{},links:[],categories:[]};
}
function saveData(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d,null,2),'utf8'); }

// ─── МойСклад API ─────────────────────────────────────────────
function msGet(endpoint) {
  return new Promise((ok, fail) => {
    if (!MS_TOKEN) { fail(new Error('MOYSKLAD_TOKEN не задан')); return; }
    const opts = {
      hostname: 'api.moysklad.ru',
      path: '/api/remap/1.2' + endpoint,
      headers: {
        'Authorization': 'Bearer ' + MS_TOKEN,
        'Accept-Encoding': 'gzip',
        'Content-Type': 'application/json'
      }
    };
    https.get(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const buf = Buffer.concat(chunks);
          const raw = res.headers['content-encoding'] === 'gzip'
            ? zlib.gunzipSync(buf).toString('utf8')
            : buf.toString('utf8');
          const data = JSON.parse(raw);
          if (res.statusCode !== 200) fail(new Error(data.errors?.[0]?.error || 'HTTP ' + res.statusCode));
          else ok(data);
        } catch(e) { fail(e); }
      });
    }).on('error', fail);
  });
}

function msPrice(v) { return (v || v===0) ? Math.round(v/100) : null; }

function parseProduct(p) {
  let price = null;
  if (p.salePrices?.length) {
    const sp = p.salePrices.find(x => x.priceType?.name?.toLowerCase().includes('опт'))
            || p.salePrices.find(x => x.priceType?.name?.toLowerCase().includes('продаж'))
            || p.salePrices[0];
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

// Поиск товара — сначала ?search= (работает по коду, артикулу, названию)
async function findProduct(query) {
  const q = encodeURIComponent(query);

  // 1. Универсальный поиск — работает для всех товаров
  try {
    const d = await msGet('/entity/product?search=' + q + '&limit=10&expand=uom');
    if (d.rows?.length) return parseProduct(d.rows[0]);
  } catch(e) { console.log('search failed:', e.message); }

  // 2. Модификации
  try {
    const d = await msGet('/entity/variant?search=' + q + '&limit=10&expand=uom');
    if (d.rows?.length) return parseProduct(d.rows[0]);
  } catch(e) {}

  throw new Error('Товар не найден');
}

async function syncAll(categories) {
  const updated = [];
  for (const cat of categories) {
    for (const p of cat.products||[]) {
      if (!p.code) continue;
      try { updated.push(await findProduct(p.code)); } catch {}
    }
  }
  return updated;
}

// ─── PDF HTML page ───────────────────────────────────────────
function buildPDFHtml(data) {
  const co = data.company || {};
  const date = new Date().toLocaleDateString('ru-RU', {day:'numeric', month:'long', year:'numeric'});
  const phone = co.phone || '8-800-700-27-03';
  const address = co.address || 'Московская обл., Раменский р-н, п. Ильинский, ул. Пролетарская, д 49';

  let rows = '';
  (data.categories||[]).forEach(cat => {
    if (!cat.products?.length) return;
    rows += `<tr><td colspan="3" class="cat-hdr">${cat.name}</td></tr>`;
    cat.products.forEach((p, i) => {
      const price = p.price != null
        ? Number(p.price).toLocaleString('ru-RU') + ' ₽' + (p.unit ? ' / ' + p.unit : '')
        : 'По запросу';
      rows += `<tr class="${i%2===0?'even':'odd'}">
        <td class="td-n">${p.name}</td>
        <td class="td-c">${p.code||'—'}</td>
        <td class="td-p">${price}</td>
      </tr>`;
    });
  });

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Прайс-лист</title>
  <style>
    @page { margin: 12mm 14mm; size: A4; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, Helvetica, sans-serif; color: #1a2744; font-size: 10px; background: #f5f6f8; }
    .page { max-width: 800px; margin: 0 auto; background: #fff; padding: 20px 24px; }
    @media print { body { background: #fff; } .page { padding: 0; } }
    .hdr { border-bottom: 3px solid #F26522; padding-bottom: 8px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: flex-start; }
    .co-name { font-size: 15px; font-weight: 700; text-transform: uppercase; }
    .co-sub { font-size: 9px; color: #8898aa; margin-top: 1px; }
    .co-contacts { font-size: 9px; color: #555; margin-top: 4px; line-height: 1.6; }
    .date-blk { text-align: right; font-size: 9px; color: #555; }
    .date-blk b { font-size: 12px; color: #1a2744; display: block; }
    table { width: 100%; border-collapse: collapse; }
    th { padding: 4px 8px; font-size: 8px; text-transform: uppercase; letter-spacing: .04em; color: #8898aa; background: #f5f6f8; border-bottom: 1px solid #e2e6f0; }
    th:first-child { text-align: left; }
    th:not(:first-child) { text-align: right; }
    .cat-hdr { padding: 6px 8px 3px; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; background: #f0f2f7; border-bottom: 2px solid #F26522; color: #1a2744; }
    .td-n { padding: 4px 8px; border-bottom: 1px solid #f0f0f0; }
    .td-c { padding: 4px 8px; border-bottom: 1px solid #f0f0f0; text-align: right; color: #8898aa; width: 80px; white-space: nowrap; }
    .td-p { padding: 4px 8px; border-bottom: 1px solid #f0f0f0; text-align: right; font-weight: 700; width: 110px; white-space: nowrap; }
    .even { background: #fff; } .odd { background: #fafaf9; }
    .ftr { margin-top: 10px; padding-top: 6px; border-top: 1px solid #e2e6f0; display: flex; justify-content: space-between; font-size: 8px; color: #8898aa; }
  </style></head><body>
  <div class="page">
  <div class="hdr">
    <div>
      <div class="co-name">${co.name||'FISH TO BUSINESS'}</div>
      ${co.tagline?`<div class="co-sub">${co.tagline}</div>`:''}
      <div class="co-contacts">${phone}<br>${address}</div>
    </div>
    <div class="date-blk"><b>Прайс-лист</b>от ${date}</div>
  </div>
  <table>
    <thead><tr><th>Наименование</th><th>Артикул</th><th>Цена опт</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="ftr"><span>Все цены указаны с НДС</span><span>${co.name||'Fish to Business'} · ${date}</span></div>
  <script>window.onload=function(){window.print();}</script>
  </div>
  </body></html>`;
}

// ─── static ───────────────────────────────────────────────────
const MIME = {'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon'};
function serveFile(res, fp) {
  try {
    res.writeHead(200, {'Content-Type': MIME[path.extname(fp)]||'application/octet-stream'});
    res.end(fs.readFileSync(fp));
  } catch { res.writeHead(404); res.end('Not found'); }
}

// ─── router ───────────────────────────────────────────────────
async function router(req, res) {
  cors(res);
  if (req.method==='OPTIONS') { res.writeHead(204); res.end(); return; }
  const {pathname, query} = url.parse(req.url, true);

  if (pathname==='/api/pricelist' && req.method==='GET') {
    return sendJSON(res, loadData());
  }
  if (pathname==='/api/pricelist' && req.method==='POST') {
    saveData(await readBody(req));
    return sendJSON(res, {ok:true});
  }
  if (pathname==='/api/moysklad/product' && req.method==='GET') {
    if (!MS_TOKEN) return sendErr(res, 'MOYSKLAD_TOKEN не задан');
    try { return sendJSON(res, await findProduct(query.code||'')); }
    catch(e) { return sendErr(res, e.message, 404); }
  }
  if (pathname==='/api/moysklad/sync' && req.method==='POST') {
    if (!MS_TOKEN) return sendErr(res, 'MOYSKLAD_TOKEN не задан');
    const data = loadData();
    try {
      const updated = await syncAll(data.categories);
      data.categories.forEach(cat => cat.products?.forEach(p => {
        const u = updated.find(x => x.code===p.code);
        if (u) { p.price=u.price; p.name=u.name; p.unit=u.unit; }
      }));
      saveData(data);
      return sendJSON(res, {ok:true, updated:updated.length, products:updated});
    } catch(e) { return sendErr(res, e.message, 500); }
  }
  if (pathname==='/api/pdf' && req.method==='GET') {
    const data = loadData();
    const html = buildPDFHtml(data);
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
    res.end(html);
    return;
  }

  if (pathname==='/api/moysklad/test' && req.method==='POST') {
    const body = await readBody(req);
    const saved = MS_TOKEN;
    if (body.token) MS_TOKEN = body.token;
    try {
      const d = await msGet('/entity/employee?limit=1');
      const cfg = loadData(); cfg._msToken = MS_TOKEN; saveData(cfg);
      return sendJSON(res, {ok:true, account: d.rows?.[0]?.fullName||d.rows?.[0]?.name});
    } catch(e) { MS_TOKEN=saved; return sendErr(res, e.message, 401); }
  }

  if (pathname==='/' || pathname==='/index.html') return serveFile(res, path.join(__dirname,'index.html'));
  if (pathname==='/admin' || pathname==='/admin.html') return serveFile(res, path.join(__dirname,'admin.html'));
  res.writeHead(404); res.end('Not found');
}

// ─── start ────────────────────────────────────────────────────
const saved = loadData();
if (!MS_TOKEN && saved._msToken) MS_TOKEN = saved._msToken;

http.createServer(async (req,res) => {
  try { await router(req,res); }
  catch(e) { console.error(e); if(!res.headersSent){res.writeHead(500);res.end('Error');} }
}).listen(PORT, () => {
  console.log('🐟 http://localhost:' + PORT);
  console.log(MS_TOKEN ? '✅ токен загружен' : '⚠️  MOYSKLAD_TOKEN не задан');
});
