const fs = require('fs');
const path = require('path');
const multiplayer = require('./multiplayer');

// On Vercel the deployed project folder is read-only outside /tmp, and /tmp
// is ephemeral (wiped on cold start, not shared across instances). This lets
// the API keep working instead of crashing, but it means data WILL be lost
// periodically until this is swapped for a real database (Vercel KV/Postgres,
// Supabase, Upstash Redis, etc). Do not treat this as durable production storage.
const DATA_DIR = process.env.VERCEL
  ? path.join('/tmp', 'climate-game-data')
  : path.join(process.cwd(), 'data');
const STATE_FILE = path.join(DATA_DIR, 'game-state.json');

// ---- Admin auth -----------------------------------------------------------
// Every admin-only route/key requires this header. Set ADMIN_API_KEY in your
// Vercel project's Environment Variables (and in .env.local for local dev).
// It doubles as the admin dashboard's login password.
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
  if (!ADMIN_API_KEY) return false; // fail closed if not configured
  const provided = req.headers['x-admin-key'];
  return typeof provided === 'string' && provided === ADMIN_API_KEY;
}

function requireAdmin(req, res) {
  if (isAuthorizedAdmin(req)) return true;
  jsonResponse(res, 401, { message: 'Admin authentication required' });
  return false;
}

// Strip any secret fields before returning config publicly, in case old
// synced data still has admin passwords embedded in it.
function redactConfig(value) {
  if (!value || typeof value !== 'object') return value;
  // Only return fields the public game needs; never expose admin accounts,
  // moderation data, contacts, or arbitrary values stored in the config blob.
  return {
    difficulty: value.difficulty,
    items: value.items,
    branding: value.branding,
    events: value.events,
    toggles: value.toggles ? { maintenance: !!value.toggles.maintenance, leaderboard: !!value.toggles.leaderboard } : undefined,
  };
}

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
    return {
      ...defaultState,
      ...parsed,
      config: { ...defaultState.config, ...(parsed.config || {}) },
      kv: parsed.kv || {},
    };
  } catch (error) {
    return JSON.parse(JSON.stringify(defaultState));
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
    username: username ? (username.startsWith('@') ? username : `@${username}`) : '',
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
  if (method === 'phone') return compare(player.contactPhone);
  if (method === 'email') return compare(player.contactEmail);

  return compare(player.username) || compare(player.contactTelegram) || compare(player.contactEmail) || compare(player.contactPhone);
}

function jsonResponse(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  if (multiplayer.isConfigured()) {
    return multiplayer.handle(req, res);
  }
  const url = new URL(req.url || '/', 'https://example.com');
  const pathname = url.pathname;
  const method = (req.method || 'GET').toUpperCase();
  const parts = pathname.split('/').filter(Boolean);

  if (pathname === '/api/public-config' && method === 'GET') {
    jsonResponse(res, 200, { supabaseUrl: '', supabaseAnonKey: '', multiplayerEnabled: false });
    return;
  }

  if (pathname === '/api/health') {
    jsonResponse(res, 200, { ok: true, time: new Date().toISOString(), mode: 'local-preview', competitionEnabled: false, multiplayerEnabled: false });
    return;
  }

  if (pathname === '/api/config') {
    const state = readState();
    if (method === 'GET') {
      jsonResponse(res, 200, redactConfig(state.config));
      return;
    }
    if (method === 'PATCH') {
      if (!requireAdmin(req, res)) return;
      const body = await readBody(req);
      state.config = { ...state.config, ...(body || {}) };
      writeState(state);
      jsonResponse(res, 200, redactConfig(state.config));
      return;
    }
  }

  if (pathname === '/api/admin/login') {
    if (method === 'POST') {
      const body = await readBody(req);
      const password = String((body && body.password) || '');
      if (ADMIN_API_KEY && password === ADMIN_API_KEY) {
        jsonResponse(res, 200, { ok: true, key: ADMIN_API_KEY });
      } else {
        jsonResponse(res, 401, { ok: false, message: 'Invalid admin password' });
      }
      return;
    }
  }

  if (pathname === '/api/players') {
    // Public roster reads are disabled until verified accounts and a safe
    // public profile projection are backed by durable storage.
    jsonResponse(res, 200, []);
    return;
  }

  if (pathname === '/api/live') {
    jsonResponse(res, 200, []);
    return;
  }

  if (pathname === '/api/account' || pathname.startsWith('/api/game/')) {
    jsonResponse(res, 503, { code: 'DATABASE_NOT_CONFIGURED', message: 'Multiplayer accounts are not configured yet.' });
    return;
  }

  if (pathname === '/api/admin/players') {
    if (!requireAdmin(req, res)) return;
    if (method === 'GET') {
      jsonResponse(res, 200, readState().players);
      return;
    }
  }

  if (pathname === '/api/admin/commands') {
    if (!requireAdmin(req, res)) return;
    const state = readState();
    if (method === 'GET') {
      jsonResponse(res, 200, state.adminCommands);
      return;
    }
    if (method === 'POST') {
      const body = await readBody(req);
      const command = { id: `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, ...body, createdAt: new Date().toISOString() };
      state.adminCommands.push(command);
      writeState(state);
      jsonResponse(res, 201, command);
      return;
    }
  }

  if (parts[0] === 'api' && parts[1] === 'kv' && parts[2]) {
    const key = decodeURIComponent(parts[2]);
    if (!ALLOWED_KV_KEYS.has(key)) {
      jsonResponse(res, 404, { message: 'Storage key not found' });
      return;
    }
    const state = readState();
    const isAdminKey = ADMIN_ONLY_KV_KEYS.has(key);
    if (method === 'GET') {
      if (PRIVATE_KV_KEYS.has(key) && !requireAdmin(req, res)) return;
      const value = key === 'climateGameConfig_v1' ? redactConfig(state.kv[key] ?? null) : (state.kv[key] ?? null);
      jsonResponse(res, 200, { key, value });
      return;
    }
    if (method === 'POST') {
      if (!isAdminKey || !requireAdmin(req, res)) return;
      const body = await readBody(req);
      const value = body && Object.prototype.hasOwnProperty.call(body, 'value') ? body.value : body;
      state.kv[key] = value;
      writeState(state);
      jsonResponse(res, 200, { key, value: state.kv[key] });
      return;
    }
    if (method === 'DELETE') {
      if (!isAdminKey || !requireAdmin(req, res)) return;
      delete state.kv[key];
      writeState(state);
      jsonResponse(res, 200, { key, deleted: true });
      return;
    }
  }

  if (pathname === '/api/leaderboard') {
    // Do not publish client-supplied scores as a competition. This remains
    // disabled until identity, scoring, and persistence are server-verified.
    jsonResponse(res, 200, {
      period: String(url.searchParams.get('period') || 'daily').toLowerCase(),
      competitionEnabled: false,
      leaderboard: [],
      rows: [],
      total: 0,
    });
    return;
  }

  if (pathname === '/api/register') {
    jsonResponse(res, 503, { code: 'COMPETITION_DISABLED', message: 'Verified player accounts are not configured yet.' });
    return;
  }

  if (parts[0] === 'api' && parts[1] === 'profile' && parts[2]) {
    jsonResponse(res, 503, { code: 'COMPETITION_DISABLED', message: 'Verified player accounts are not configured yet.' });
    return;
  }

  if (parts[0] === 'api' && parts[1] === 'live' && parts[2]) {
    jsonResponse(res, 503, { code: 'COMPETITION_DISABLED', message: 'Verified player accounts are not configured yet.' });
    return;
  }

  if (pathname === '/api/admin/players' && method === 'PUT') {
    if (!requireAdmin(req, res)) return;
    const state = readState();
    const body = await readBody(req);
    state.players = Array.isArray(body) ? body.map((player) => normalizePlayer(player)) : [];
    state.live = [...state.players];
    writeState(state);
    jsonResponse(res, 200, state.players);
    return;
  }

  jsonResponse(res, 404, { message: 'API route not found' });
};
