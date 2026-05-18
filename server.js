/**
 * MMP Planning — Serveur Node.js
 * Compatible Render.com (hébergement gratuit)
 * Pas de dépendances externes — Node.js pur
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const PORT = process.env.PORT || 3000;

// Sur Render, les fichiers locaux sont effacés à chaque redémarrage
// On utilise le dossier /tmp pour le stockage en mémoire + fichiers temporaires
// Les données persistantes sont stockées en mémoire + sauvegardées sur disque si possible
const IS_RENDER = !!process.env.RENDER;
const DATA_DIR  = IS_RENDER ? '/tmp/mmp-data' : path.join(__dirname, 'data');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Store en mémoire (source de vérité) ──
const store = {
  ofs:      {},
  settings: {},
  calendar: {},
  history:  {},
  backups:  {},
  presence: {},
};

// Fichiers de persistance
const FILES = {};
Object.keys(store).forEach(k => { FILES[k] = path.join(DATA_DIR, k + '.json'); });

// Charger depuis disque au démarrage
Object.keys(store).forEach(k => {
  try {
    if (fs.existsSync(FILES[k])) {
      store[k] = JSON.parse(fs.readFileSync(FILES[k], 'utf8') || '{}');
    }
  } catch(e) { console.warn('Erreur chargement', k, e.message); }
});

// Sauvegarder sur disque (debounced)
const saveTimers = {};
function saveToDisk(key) {
  clearTimeout(saveTimers[key]);
  saveTimers[key] = setTimeout(() => {
    try { fs.writeFileSync(FILES[key], JSON.stringify(store[key], null, 2)); }
    catch(e) { console.warn('Erreur écriture', key, e.message); }
  }, 500);
}

// ── SSE clients ──
const sseClients = new Set();

function broadcast(type, data) {
  const msg = `data: ${JSON.stringify({ type, data })}\n\n`;
  const dead = [];
  sseClients.forEach(res => {
    try { res.write(msg); }
    catch(e) { dead.push(res); }
  });
  dead.forEach(r => sseClients.delete(r));
}

// ── Nettoyage présence (> 90s) ──
setInterval(() => {
  const now = Date.now();
  let changed = false;
  Object.keys(store.presence).forEach(sid => {
    if (now - (store.presence[sid].lastSeen || 0) > 90000) {
      delete store.presence[sid]; changed = true;
    }
  });
  if (changed) { saveToDisk('presence'); broadcast('presence', store.presence); }
}, 30000);

// ── CORS ──
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── Lire body ──
function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch(e) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

// ── Servir l'app HTML ──
const APP_FILE = path.join(__dirname, 'app', 'index.html');
let appHtml = null;
function getAppHtml() {
  if (!appHtml) {
    try { appHtml = fs.readFileSync(APP_FILE, 'utf8'); }
    catch(e) { return null; }
  }
  return appHtml;
}

// ── Serveur ──
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);
  const pathname = url.pathname;

  setCORS(res);

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Servir l'app ──
  if (pathname === '/' || pathname === '/index.html') {
    const html = getAppHtml();
    if (!html) {
      res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h2>⚠️ App non trouvée</h2><p>Placez le fichier <b>index.html</b> dans le dossier <b>app/</b></p>`);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache' });
    res.end(html);
    return;
  }

  // ── Status / ping (utilisé par Render pour keep-alive) ──
  if (pathname === '/status' || pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok', version: '8.0',
      ofCount: Object.keys(store.ofs).length,
      clients: sseClients.size,
      uptime: Math.round(process.uptime()) + 's',
      env: IS_RENDER ? 'render' : 'local',
    }));
    return;
  }

  // ── SSE ──
  if (pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 5000\n\n');
    // Envoyer état initial
    res.write(`data: ${JSON.stringify({ type: 'init', data: {
      ofs:      store.ofs,
      settings: store.settings,
      calendar: store.calendar,
      history:  store.history,
      presence: store.presence,
    }})}\n\n`);
    sseClients.add(res);
    // Heartbeat toutes les 20s pour garder la connexion vivante
    const hb = setInterval(() => {
      try { res.write(': heartbeat\n\n'); }
      catch(e) { clearInterval(hb); sseClients.delete(res); }
    }, 20000);
    req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
    return;
  }

  // ── API REST ──
  const apiMatch = pathname.match(/^\/api\/([a-z]+)\/?(.*)$/);
  if (apiMatch) {
    const resource = apiMatch[1];
    const sub      = apiMatch[2] || '';

    if (!store[resource]) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Resource inconnue: ' + resource }));
      return;
    }

    // GET
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(store[resource]));
      return;
    }

    // POST
    if (req.method === 'POST') {
      const body = await readBody(req);

      // Présence : heartbeat d'une session
      if (resource === 'presence' && sub) {
        store.presence[sub] = { ...body, lastSeen: Date.now() };
        saveToDisk('presence');
        broadcast('presence', store.presence);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // Historique : ajouter une entrée
      if (resource === 'history') {
        const id = 'h_' + Date.now() + '_' + Math.random().toString(36).slice(2,6);
        store.history[id] = { ...body, ts: Date.now() };
        // Garder 200 entrées max
        const entries = Object.entries(store.history).sort((a,b)=>(b[1].ts||0)-(a[1].ts||0));
        if (entries.length > 200) {
          store.history = Object.fromEntries(entries.slice(0,200));
        }
        saveToDisk('history');
        broadcast('history', store.history);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id }));
        return;
      }

      // Backups : ajouter un snapshot
      if (resource === 'backups') {
        const id = body.id || ('b_' + Date.now());
        store.backups[id] = body;
        // Garder 30 snapshots max
        const sorted = Object.entries(store.backups).sort((a,b)=>(b[1].ts||0)-(a[1].ts||0));
        if (sorted.length > 30) store.backups = Object.fromEntries(sorted.slice(0,30));
        saveToDisk('backups');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // Ressource normale : remplacer tout
      store[resource] = body;
      saveToDisk(resource);
      broadcast(resource, body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // DELETE
    if (req.method === 'DELETE' && resource === 'presence' && sub) {
      delete store.presence[sub];
      saveToDisk('presence');
      broadcast('presence', store.presence);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  const ip = Object.values(os.networkInterfaces())
    .flat().find(i => i?.family==='IPv4' && !i.internal)?.address || 'localhost';
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║         MMP Planning — Serveur démarré           ║');
  console.log('╠══════════════════════════════════════════════════╣');
  if (IS_RENDER) {
    console.log('║  Hébergement : Render.com                        ║');
    console.log(`║  Port        : ${PORT}                                ║`);
  } else {
    console.log(`║  Local  : http://localhost:${PORT}                  ║`);
    console.log(`║  Réseau : http://${ip}:${PORT}                ║`);
  }
  console.log(`║  Clients SSE : 0                                 ║`);
  console.log('╚══════════════════════════════════════════════════╝\n');
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} déjà utilisé.`);
  } else {
    console.error('Erreur serveur:', err);
  }
  process.exit(1);
});
