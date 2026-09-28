const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';
const configured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY && SUPABASE_SERVICE_ROLE_KEY);
const adminDb = configured
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

const ADMIN_ONLY_KEYS = new Set([
  'climateGameConfig_v1',
  'climateGameAdminCommands_v1',
  'climateGameAdminRemovedPlayers_v1',
  'climateGameAdminPlayers_v1',
  'climateGameLive_v1',
]);
const PRIVATE_KEYS = new Set([
  'climateGameAdminCommands_v1',
  'climateGameAdminRemovedPlayers_v1',
  'climateGameAdminPlayers_v1',
  'climateGameLive_v1',
]);

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
}

function isAdmin(req) {
  return Boolean(ADMIN_API_KEY && req.headers['x-admin-key'] === ADMIN_API_KEY);
}

function requireAdmin(req, res) {
  if (isAdmin(req)) return true;
  send(res, 401, { message: 'Admin authentication required' });
  return false;
}

async function playerFor(req, res) {
  const authorization = String(req.headers.authorization || '');
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) {
    send(res, 401, { message: 'Sign in to continue.' });
    return null;
  }
  const { data, error } = await adminDb.auth.getUser(token);
  if (error || !data.user) {
    send(res, 401, { message: 'Your session expired. Please sign in again.' });
    return null;
  }
  return data.user;
}

async function optionalPlayerId(req) {
  const token = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return null;
  const { data, error } = await adminDb.auth.getUser(token);
  return error || !data.user ? null : data.user.id;
}

function publicPlayer(row, periods = {}) {
  return {
    id: row.id,
    name: row.display_name || 'Eco Player',
    username: '',
    score: Number(row.score) || 0,
    dailyScore: Number(periods.daily_score) || 0,
    weeklyScore: Number(periods.weekly_score) || 0,
    leaderboardOptIn: Boolean(row.leaderboard_opt_in),
    level: Number(row.level) || 1,
    bestLevel: Number(row.best_level) || 1,
    gamesPlayed: Number(row.games_played) || 0,
    referrals: 0,
    status: row.status || 'active',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActive: row.updated_at ? Date.parse(row.updated_at) : 0,
  };
}

async function getPeriods(playerId) {
  const { data, error } = await adminDb.rpc('player_period_scores', { p_player_id: playerId });
  if (error) throw error;
  return data?.[0] || { daily_score: 0, weekly_score: 0 };
}

async function getOrCreatePlayer(user) {
  const displayName = String(user.user_metadata?.display_name || user.email?.split('@')[0] || 'Eco Player').trim().slice(0, 24) || 'Eco Player';
  const { error: upsertError } = await adminDb.from('players').upsert({
    id: user.id,
    display_name: displayName,
    leaderboard_opt_in: Boolean(user.user_metadata?.leaderboard_opt_in),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'id', ignoreDuplicates: true });
  if (upsertError) throw upsertError;
  const { data, error } = await adminDb.from('players')
    .select('id,display_name,score,level,best_level,games_played,status,leaderboard_opt_in,created_at,updated_at')
    .eq('id', user.id).single();
  if (error) throw error;
  return data;
}

async function getConfigValue(key) {
  const { data, error } = await adminDb.from('kv_store').select('value').eq('key', key).maybeSingle();
  if (error) throw error;
  return data?.value ?? null;
}

async function putConfigValue(key, value) {
  const { error } = await adminDb.from('kv_store').upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw error;
}

async function getAdminPlayers() {
  const { data, error } = await adminDb.rpc('admin_player_list');
  if (error) throw error;
  return (data || []).map(row => publicPlayer({
    ...row,
    id: row.player_id,
  }, row));
}

async function getPublicPlayers() {
  const { data, error } = await adminDb.rpc('public_leaderboard', { p_period: 'alltime', p_limit: 100 });
  if (error) throw error;
  return (data || []).map(row => ({
    name: row.display_name || 'Eco Player',
    score: Number(row.period_score) || 0,
    dailyScore: Number(row.daily_score) || 0,
    weeklyScore: Number(row.weekly_score) || 0,
    level: Number(row.level) || 1,
  }));
}

async function patchAdminPlayers(players) {
  if (!Array.isArray(players)) return;
  const submitted = players.slice(0, 500);
  for (const player of submitted) {
    if (!player?.id) continue;
    let resetScore = null;
    if (Number.isFinite(Number(player.score))) {
      const { data: current, error: currentError } = await adminDb.from('players').select('score').eq('id', String(player.id)).maybeSingle();
      if (currentError) throw currentError;
      if (current && Number(player.score) < Number(current.score)) {
        resetScore = Math.max(0, Math.floor(Number(player.score)));
        const { error: deleteError } = await adminDb.from('score_events').delete().eq('player_id', String(player.id));
        if (deleteError) throw deleteError;
        const { error: runError } = await adminDb.from('game_runs')
          .update({ finished_at: new Date().toISOString(), delta: 0, result: 'failed' })
          .eq('player_id', String(player.id)).is('finished_at', null);
        if (runError) throw runError;
      }
    }
    const update = {};
    if (typeof player.name === 'string') update.display_name = player.name.trim().slice(0, 24) || 'Eco Player';
    if (typeof player.status === 'string' && ['active', 'banned'].includes(player.status)) update.status = player.status;
    if (resetScore !== null) update.score = resetScore;
    if (Number.isFinite(Number(player.level))) update.level = Math.max(1, Math.floor(Number(player.level)));
    update.updated_at = new Date().toISOString();
    const { error } = await adminDb.from('players').update(update).eq('id', String(player.id));
    if (error) throw error;
  }
  const retainedIds = new Set(submitted.map(player => String(player?.id || '')).filter(Boolean));
  const { data: existingPlayers, error: listError } = await adminDb.from('players').select('id').limit(500);
  if (listError) throw listError;
  const removedIds = (existingPlayers || []).map(player => player.id).filter(id => !retainedIds.has(id));
  if (removedIds.length) {
    const { error: banError } = await adminDb.from('players').update({ status: 'banned', updated_at: new Date().toISOString() }).in('id', removedIds);
    if (banError) throw banError;
  }
}

async function handleKv(req, res, key, method) {
  if (!ADMIN_ONLY_KEYS.has(key) && key !== 'climateGameConfig_v1') {
    send(res, 404, { message: 'Storage key not found' });
    return;
  }
  if (PRIVATE_KEYS.has(key) && !requireAdmin(req, res)) return;
  if (method === 'GET') {
    let value;
    if (key === 'climateGameAdminPlayers_v1' || key === 'climateGameLive_v1') {
      value = await getAdminPlayers();
    } else {
      value = await getConfigValue(key);
    }
    if (key === 'climateGameConfig_v1' && value) {
      const { admins, ...safe } = value;
      value = safe;
    }
    send(res, 200, { key, value });
    return;
  }
  if (method === 'POST') {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    if (!body || typeof body !== 'object' || !Object.hasOwn(body, 'value')) {
      send(res, 400, { message: 'Expected a value field.' });
      return;
    }
    if (key === 'climateGameAdminPlayers_v1') {
      await patchAdminPlayers(body.value);
      send(res, 200, { key, value: await getAdminPlayers() });
      return;
    }
    await putConfigValue(key, body.value);
    send(res, 200, { key, value: body.value });
    return;
  }
  if (method === 'DELETE') {
    if (!requireAdmin(req, res)) return;
    if (key === 'climateGameAdminPlayers_v1' || key === 'climateGameLive_v1') {
      send(res, 405, { message: 'Player records cannot be deleted through this endpoint.' });
      return;
    }
    const { error } = await adminDb.from('kv_store').delete().eq('key', key);
    if (error) throw error;
    send(res, 200, { key, deleted: true });
    return;
  }
  send(res, 405, { message: 'Method not allowed' });
}

async function handle(req, res) {
  const url = new URL(req.url || '/', 'https://example.com');
  const pathname = url.pathname;
  const method = String(req.method || 'GET').toUpperCase();
  try {
    if (pathname === '/api/public-config' && method === 'GET') {
      send(res, 200, {
        supabaseUrl: SUPABASE_URL,
        supabaseAnonKey: SUPABASE_ANON_KEY,
        multiplayerEnabled: configured,
      });
      return;
    }
    if (pathname === '/api/health' && method === 'GET') {
      send(res, 200, { ok: true, multiplayerEnabled: configured, time: new Date().toISOString() });
      return;
    }
    if (!configured) {
      send(res, 503, { code: 'DATABASE_NOT_CONFIGURED', message: 'Multiplayer storage is not configured.' });
      return;
    }
    if (pathname === '/api/admin/login' && method === 'POST') {
      const body = await readBody(req);
      if (ADMIN_API_KEY && String(body?.password || '') === ADMIN_API_KEY) {
        send(res, 200, { ok: true, key: ADMIN_API_KEY });
      } else {
        send(res, 401, { ok: false, message: 'Invalid admin password' });
      }
      return;
    }
    if (pathname === '/api/config' && method === 'GET') {
      const config = await getConfigValue('climateGameConfig_v1');
      send(res, 200, config ? { difficulty: config.difficulty, items: config.items, branding: config.branding, events: config.events, toggles: config.toggles } : {});
      return;
    }
    if (pathname === '/api/account' && (method === 'GET' || method === 'PATCH')) {
      const user = await playerFor(req, res);
      if (!user) return;
      if (method === 'PATCH') {
        const body = await readBody(req);
        const update = { updated_at: new Date().toISOString() };
        if (Object.hasOwn(body || {}, 'name')) {
          const displayName = String(body?.name || '').trim().slice(0, 24);
          if (displayName.length < 2) {
            send(res, 400, { message: 'Display name must be at least 2 characters.' });
            return;
          }
          update.display_name = displayName;
        }
        if (Object.hasOwn(body || {}, 'leaderboardOptIn')) update.leaderboard_opt_in = Boolean(body.leaderboardOptIn);
        if (Object.keys(update).length > 1) {
          const { error } = await adminDb.from('players').update(update).eq('id', user.id);
          if (error) throw error;
        }
      }
      const player = await getOrCreatePlayer(user);
      if (player.status !== 'active') {
        send(res, 403, { message: 'This player account is not active. Contact the game administrator.' });
        return;
      }
      const periods = await getPeriods(user.id);
      send(res, 200, publicPlayer(player, periods));
      return;
    }
    if (pathname === '/api/account' && method === 'DELETE') {
      const user = await playerFor(req, res);
      if (!user) return;
      const { error: playerDeleteError } = await adminDb.from('players').delete().eq('id', user.id);
      if (playerDeleteError) throw playerDeleteError;
      const { error: authDeleteError } = await adminDb.auth.admin.deleteUser(user.id);
      if (authDeleteError) throw authDeleteError;
      send(res, 200, { deleted: true });
      return;
    }
    if (pathname === '/api/game/start' && method === 'POST') {
      const user = await playerFor(req, res);
      if (!user) return;
      const body = await readBody(req);
      const level = Math.min(100, Math.max(1, Math.floor(Number(body?.level) || 1)));
      const { data, error } = await adminDb.rpc('start_game_run', { p_player_id: user.id, p_level: level });
      if (error) throw error;
      send(res, 201, { runId: data, playerId: user.id });
      return;
    }
    if (pathname === '/api/game/finish' && method === 'POST') {
      const user = await playerFor(req, res);
      if (!user) return;
      const body = await readBody(req);
      const runId = String(body?.runId || '');
      const delta = Number(body?.delta);
      const level = Math.floor(Number(body?.level));
      const elapsedSeconds = Number(body?.elapsedSeconds);
      const result = String(body?.result || 'failed');
      if (!/^[0-9a-f-]{36}$/i.test(runId) || !Number.isInteger(delta) || delta < -100000 || delta > 100075 || !Number.isInteger(level) || level < 1 || level > 100 || !Number.isFinite(elapsedSeconds) || elapsedSeconds < 0 || !['completed', 'failed'].includes(result)) {
        send(res, 400, { message: 'Invalid game result.' });
        return;
      }
      const { data, error } = await adminDb.rpc('finish_game_run', {
        p_run_id: runId,
        p_player_id: user.id,
        p_delta: delta,
        p_level: level,
        p_elapsed_seconds: Math.min(3600, Math.ceil(elapsedSeconds)),
        p_result: result,
      });
      if (error) {
        send(res, 400, { message: error.message });
        return;
      }
      send(res, 200, data);
      return;
    }
    if (pathname === '/api/leaderboard' && method === 'GET') {
      const period = ['daily', 'weekly', 'alltime'].includes(String(url.searchParams.get('period') || '').toLowerCase())
        ? String(url.searchParams.get('period') || 'daily').toLowerCase() : 'daily';
      const { data, error } = await adminDb.rpc('public_leaderboard', { p_period: period, p_limit: 50 });
      if (error) throw error;
      const currentPlayerId = await optionalPlayerId(req);
      const rows = (data || []).map(row => ({
        name: row.display_name || 'Eco Player',
        score: Number(row.period_score) || 0,
        dailyScore: Number(row.daily_score) || 0,
        weeklyScore: Number(row.weekly_score) || 0,
        level: Number(row.level) || 1,
        me: Boolean(currentPlayerId && row.player_id === currentPlayerId),
      }));
      send(res, 200, { period, competitionEnabled: true, leaderboard: rows, rows, total: rows.length });
      return;
    }
    if (pathname === '/api/players' && method === 'GET') {
      send(res, 200, await getPublicPlayers());
      return;
    }
    if (pathname === '/api/live' && method === 'GET') {
      send(res, 200, await getPublicPlayers());
      return;
    }
    if (pathname === '/api/admin/players' && method === 'GET') {
      if (!requireAdmin(req, res)) return;
      send(res, 200, await getAdminPlayers());
      return;
    }
    if (pathname.startsWith('/api/kv/')) {
      const key = decodeURIComponent(pathname.slice('/api/kv/'.length));
      await handleKv(req, res, key, method);
      return;
    }
    send(res, 404, { message: 'API route not found' });
  } catch (error) {
    console.error('[multiplayer-api]', pathname, error);
    send(res, 500, { message: 'The multiplayer service encountered an error.' });
  }
}

module.exports = { isConfigured: () => configured, handle };
