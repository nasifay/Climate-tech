const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

if (!process.env.VERCEL) {
  require('dotenv').config({ path: path.join(__dirname, '.env.local') });
}

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT_DIR = __dirname;
const multiplayer = require('./api/multiplayer');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const STATE_FILE = path.join(DATA_DIR, 'game-state.json');

// ---- Admin auth -----------------------------------------------------------
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';
const ADMIN_ONLY_KV_KEYS = new Set([
  'climateGameConfig_v1',
  'climateGameAdminCommands_v1',
  'climateGameAdminRemovedPlayers_v1',
  'climateGameAdminPlayers_v1',
  'climateGameLive_v1',
]);
const PRIVATE_KV_KEYS = new Set([
  'climateGameAdminCommands_v1',
  'climateGameAdminRemovedPlayers_v1',
  'climateGameAdminPlayers_v1',
  'climateGameLive_v1',
]);
const ALLOWED_KV_KEYS = new Set(['climateGameConfig_v1', ...ADMIN_ONLY_KV_KEYS]);
function isAuthorizedAdmin(req) {
  if (!ADMIN_API_KEY) return false;
  return req.get('x-admin-key') === ADMIN_API_KEY;
}
function requireAdmin(req, res, next) {
  if (isAuthorizedAdmin(req)) return next();
  return res.status(401).json({ message: 'Admin authentication required' });
}
function redactConfig(value) {
  if (!value || typeof value !== 'object') return value;
  return {
    difficulty: value.difficulty,
    items: value.items,
    branding: value.branding,
    events: value.events,
    toggles: value.toggles ? { maintenance: !!value.toggles.maintenance, leaderboard: !!value.toggles.leaderboard } : undefined,
  };
}

// ---- CORS -------------------------------------------------------------
// Only reflects an origin if it's explicitly allow-listed via the
// ALLOWED_ORIGINS env var (comma-separated). No env var set = same-origin
// requests only, which is what this app needs since the game and API are
// served from the same host.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
const corsOptions = {
  origin(origin, callback) {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    return callback(null, false);
  },
  credentials: true,
};

const defaultState = {
  config: {
    gameName: 'Climate Game',
    maintenanceMode: false,
    referralMode: 'telegram',
    botUsername: 'ClimateGameBot',
    lastUpdated: new Date().toISOString(),
  },
  players: [],
  live: [],
  adminPlayers: [],
  adminCommands: [],
  removedPlayers: [],
  kv: {},
};

function ensureStorage() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STATE_FILE)) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(defaultState, null, 2));
  }
}

function readState() {
  ensureStorage();
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...defaultState, ...parsed, config: { ...defaultState.config, ...(parsed.config || {}) }, kv: parsed.kv || {} };
  } catch (error) {
    return structuredClone(defaultState);
  }
}

function writeState(nextState) {
  ensureStorage();
  fs.writeFileSync(STATE_FILE, JSON.stringify(nextState, null, 2));
  return nextState;
}

function normalizePlayer(payload = {}) {
  const id = String(payload.id || payload.playerId || `player_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const username = payload.username || payload.contactTelegram || '';
  const telegram = (payload.contactTelegram || payload.telegramUsername || '').toString().replace(/^@/, '');
  const phone = (payload.contactPhone || '').toString().replace(/\s+/g, '');
  const email = (payload.contactEmail || '').toString().trim();

  return {
    id,
    name: payload.name || 'Player',
    username: username ? username.startsWith('@') ? username : `@${username}` : '',
    contactTelegram: telegram ? `@${telegram}` : '',
    contactPhone: phone,
    contactEmail: email,
    score: Number(payload.score || 0),
    dailyScore: Number(payload.dailyScore || 0),
    weeklyScore: Number(payload.weeklyScore || 0),
    level: Number(payload.level || 1),
    referrals: Number(payload.referrals || 0),
    status: payload.status || 'active',
    gamesPlayed: Number(payload.gamesPlayed || 0),
    bestLevel: Number(payload.bestLevel || payload.level || 1),
    updatedAt: new Date().toISOString(),
  };
}

function matchPlayerIdentity(player, method, value) {
  const v = String(value || '').trim().replace(/^@/, '').toLowerCase();
  if (!v) return false;

  const compare = (raw) => String(raw || '').trim().replace(/^@/, '').toLowerCase() === v;

  if (method === 'telegram') {
    return compare(player.contactTelegram) || compare(player.username) || compare(player.name) || compare(player.telegramUsername);
  }

  if (method === 'phone') {
    return compare(player.contactPhone);
  }

  if (method === 'email') {
    return compare(player.contactEmail);
  }

  return compare(player.username) || compare(player.contactTelegram) || compare(player.contactEmail) || compare(player.contactPhone);
}

app.use(cors(corsOptions));
app.use(express.json({ limit: '2mb' }));

app.all('/api/*', (req, res, next) => {
  if (!multiplayer.isConfigured()) return next();
  req.url = req.originalUrl;
  return multiplayer.handle(req, res);
});

app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), mode: 'local-preview', competitionEnabled: false, multiplayerEnabled: false });
});

app.get('/api/public-config', (req, res) => {
  res.json({ supabaseUrl: '', supabaseAnonKey: '', multiplayerEnabled: false });
});

app.get('/api/config', (req, res) => {
  const state = readState();
  res.json(redactConfig(state.config));
});

app.patch('/api/config', requireAdmin, (req, res) => {
  const state = readState();
  state.config = { ...state.config, ...(req.body || {}) };
  writeState(state);
  res.json(redactConfig(state.config));
});

app.post('/api/admin/login', (req, res) => {
  const password = String((req.body && req.body.password) || '');
  if (ADMIN_API_KEY && password === ADMIN_API_KEY) {
    res.json({ ok: true, key: ADMIN_API_KEY });
  } else {
    res.status(401).json({ ok: false, message: 'Invalid admin password' });
  }
});

app.get('/api/players', (req, res) => {
  res.json([]);
});

app.get('/api/live', (req, res) => {
  res.json([]);
});

app.all(['/api/account', '/api/game/*'], (req, res) => {
  res.status(503).json({ code: 'DATABASE_NOT_CONFIGURED', message: 'Multiplayer accounts are not configured yet.' });
});

app.get('/api/admin/players', requireAdmin, (req, res) => {
  const state = readState();
  res.json(state.players);
});

app.get('/api/admin/commands', requireAdmin, (req, res) => {
  const state = readState();
  res.json(state.adminCommands);
});

app.get('/api/kv/:key', (req, res) => {
  const key = req.params.key;
  if (!ALLOWED_KV_KEYS.has(key)) return res.status(404).json({ message: 'Storage key not found' });
  if (PRIVATE_KV_KEYS.has(key) && !isAuthorizedAdmin(req)) {
    return res.status(401).json({ message: 'Admin authentication required' });
  }
  const state = readState();
  const value = key === 'climateGameConfig_v1' ? redactConfig(state.kv[key] ?? null) : (state.kv[key] ?? null);
  res.json({ key, value });
});

app.post('/api/kv/:key', (req, res, next) => {
  if (!ALLOWED_KV_KEYS.has(req.params.key)) return res.status(404).json({ message: 'Storage key not found' });
  return requireAdmin(req, res, next);
}, (req, res) => {
  const state = readState();
  const key = req.params.key;
  state.kv[key] = req.body && Object.prototype.hasOwnProperty.call(req.body, 'value') ? req.body.value : req.body;
  writeState(state);
  res.json({ key, value: state.kv[key] });
});

app.delete('/api/kv/:key', (req, res, next) => {
  if (!ALLOWED_KV_KEYS.has(req.params.key)) return res.status(404).json({ message: 'Storage key not found' });
  return requireAdmin(req, res, next);
}, (req, res) => {
  const state = readState();
  delete state.kv[req.params.key];
  writeState(state);
  res.json({ key: req.params.key, deleted: true });
});

app.post('/api/register', (req, res) => {
  res.status(503).json({ code: 'COMPETITION_DISABLED', message: 'Verified player accounts are not configured yet.' });
});

app.patch('/api/profile/:playerId', (req, res) => {
  res.status(503).json({ code: 'COMPETITION_DISABLED', message: 'Verified player accounts are not configured yet.' });
});

app.post('/api/live/:playerId', (req, res) => {
  res.status(503).json({ code: 'COMPETITION_DISABLED', message: 'Verified player accounts are not configured yet.' });
});

app.post('/api/admin/commands', requireAdmin, (req, res) => {
  const state = readState();
  const command = { id: `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, ...req.body, createdAt: new Date().toISOString() };
  state.adminCommands.push(command);
  writeState(state);
  res.status(201).json(command);
});

app.put('/api/admin/players', requireAdmin, (req, res) => {
  const state = readState();
  state.players = Array.isArray(req.body) ? req.body.map((player) => normalizePlayer(player)) : [];
  state.live = [...state.players];
  writeState(state);
  res.json(state.players);
});

app.get('/api/leaderboard', (req, res) => {
  const period = String(req.query.period || 'daily').toLowerCase();
  res.json({
    period,
    competitionEnabled: false,
    rows: [],
    leaderboard: [],
    total: 0,
  });
});

// IMPORTANT: only ever serve an explicit allow-list of public assets here.
// The previous version used express.static(ROOT_DIR), which published the
// entire project folder over HTTP — including .env.local, .git/, schema.sql,
// and the live data/game-state.json database dump. Never widen this back to
// the whole root directory.
const PUBLIC_FILES = [
  'climate-game-preview.html',
  'admin-dashboard.html',
  'server-connection.js',
  'storage-bridge.js',
  'telegram-integration.js',
];
PUBLIC_FILES.forEach((file) => {
  app.get('/' + file, (req, res) => res.sendFile(path.join(ROOT_DIR, file)));
});
app.use('/scripts', express.static(path.join(ROOT_DIR, 'scripts')));

app.get('/', (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'climate-game-preview.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'admin-dashboard.html'));
});

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ message: 'API route not found' });
  }
  return res.status(404).send('Not found');
});

app.listen(PORT, () => {
  console.log(`Climate Game server is running on http://localhost:${PORT}`);
});
