/*
  storage-bridge.js
  ------------------
  Makes the existing game/admin code's localStorage.getItem/setItem calls
  transparently sync across every player and every device via Supabase,
  instead of staying trapped in one browser.

  HOW IT WORKS
  - The game & admin dashboard already share a set of well-known keys
    (climateGameAdminPlayers_v1, climateGameLive_v1, climateGameConfig_v1,
    climateGameAdminCommands_v1, climateGameAdminRemovedPlayers_v1).
  - We keep those keys' behaviour: getItem/setItem stay synchronous from
    the app's point of view, backed by an in-memory mirror.
  - On load, the mirror is hydrated from Supabase's kv_store table.
  - Player state stays local until a server-backed account system is
    configured. Shared admin state is synced only with the admin key.
  - Everything else (unsynced/local-only keys) falls through to real
    localStorage untouched.

  SETUP: fill in SUPABASE_URL / SUPABASE_ANON_KEY below, include this
  script BEFORE server-connection.js and the game/admin's own <script>.
*/
(function () {
  const SUPABASE_URL = window.SUPABASE_URL || '';
  const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY || '';
  const API_BASE_URL = (window.API_BASE_URL || (window.GAME_CONFIG && window.GAME_CONFIG.apiBaseUrl) || (window.location && window.location.origin) || 'http://localhost:3000').replace(/\/$/, '');

  const SYNCED_KEYS = [
    'climateGameAdminPlayers_v1',
    'climateGameLive_v1',
    'climateGameConfig_v1',
    'climateGameAdminCommands_v1',
    'climateGameAdminRemovedPlayers_v1',
  ];

  // Writes to these keys require an admin session (see admin-dashboard.html's
  // login, which stores the key under ADMIN_KEY_STORAGE_NAME — a plain,
  // non-synced localStorage entry so it never leaves this device).
  const ADMIN_ONLY_KEYS = new Set([
    'climateGameConfig_v1',
    'climateGameAdminCommands_v1',
    'climateGameAdminRemovedPlayers_v1',
    'climateGameAdminPlayers_v1',
    'climateGameLive_v1',
  ]);
  const ADMIN_KEY_STORAGE_NAME = 'climateGameAdminKey_v1';

  const realGet = Storage.prototype.getItem.bind(localStorage);
  const realSet = Storage.prototype.setItem.bind(localStorage);
  const realRemove = Storage.prototype.removeItem.bind(localStorage);

  const mirror = new Map();
  let sb = null;
  let ready = false;
  const readyQueue = [];
  // The legacy Supabase KV path allowed anonymous writes to shared player
  // state. Keep this bridge on the hardened API until per-player storage is
  // implemented and the database policies have been migrated.
  const useServerFallback = true;

  function loadSupabaseSdk() {
    return new Promise((resolve, reject) => {
      if (window.supabase) return resolve(window.supabase);
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js';
      s.onload = () => resolve(window.supabase);
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  function adminHeaders() {
    const key = realGet(ADMIN_KEY_STORAGE_NAME);
    return key ? { 'x-admin-key': key } : {};
  }

  async function serverFetchJson(url, options = {}) {
    const res = await fetch(url, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    const text = await res.text();
    try {
      return { ok: res.ok, data: text ? JSON.parse(text) : null, status: res.status, responseText: text };
    } catch (e) {
      return { ok: res.ok, data: text, status: res.status, responseText: text };
    }
  }

  async function initServerSync() {
    // Fetch all synced keys in parallel instead of one-by-one — this was
    // taking 5 sequential round trips before the game could safely trust
    // the roster/config it just loaded, which widened the race window on
    // first paint (see climate-game-preview.html's init for the other half
    // of that fix).
    await Promise.all(SYNCED_KEYS.map(async (key) => {
      const localValue = realGet(key);
      if (localValue !== null) mirror.set(key, localValue);
      if (key !== 'climateGameConfig_v1' && ADMIN_ONLY_KEYS.has(key) && !realGet(ADMIN_KEY_STORAGE_NAME)) return;
      try {
        const result = await serverFetchJson(`${API_BASE_URL}/api/kv/${encodeURIComponent(key)}`, {
          headers: ADMIN_ONLY_KEYS.has(key) ? adminHeaders() : {},
        });
        if (result.ok && result.data && result.data.value !== undefined && result.data.value !== null) {
          const value = JSON.stringify(result.data.value);
          mirror.set(key, value);
          realSet(key, value);
          window.dispatchEvent(new StorageEvent('storage', { key, newValue: value }));
        }
      } catch (e) {
        console.warn('[storage-bridge] failed to load server key', key, e);
      }
    }));

    ready = true;
    readyQueue.splice(0).forEach(fn => fn());
    window.dispatchEvent(new Event('storage-bridge-ready'));
  }

  async function initSupabaseSync() {
    const lib = await loadSupabaseSdk();
    sb = lib.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
    window.__supabase = sb; // exposed for telegram-integration.js / app code

    const { data, error } = await sb.from('kv_store').select('key,value');
    if (!error && data) {
      data.forEach(row => mirror.set(row.key, JSON.stringify(row.value)));
    }

    sb.channel('kv_store_changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'kv_store' }, (payload) => {
        const row = payload.new;
        if (!row) return;
        mirror.set(row.key, JSON.stringify(row.value));
        window.dispatchEvent(new StorageEvent('storage', { key: row.key, newValue: JSON.stringify(row.value) }));
      })
      .subscribe();

    ready = true;
    readyQueue.splice(0).forEach(fn => fn());
    window.dispatchEvent(new Event('storage-bridge-ready'));
  }

  async function init() {
    try {
      const result = await serverFetchJson(`${API_BASE_URL}/api/public-config`);
      const config = result.data;
      if (result.ok && config?.multiplayerEnabled && config.supabaseUrl && config.supabaseAnonKey) {
        const lib = await loadSupabaseSdk();
        sb = lib.createClient(config.supabaseUrl, config.supabaseAnonKey, {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
        });
        window.__supabase = sb;
      }
    } catch (e) {
      console.warn('[storage-bridge] authentication service config unavailable', e);
    }
    await initServerSync();
  }

  async function pushToServer(key, value) {
    if (!realGet(ADMIN_KEY_STORAGE_NAME)) return;
    if (useServerFallback) {
      let parsed;
      try { parsed = value == null ? null : JSON.parse(value); } catch (e) { parsed = value; }
      const result = await serverFetchJson(`${API_BASE_URL}/api/kv/${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: ADMIN_ONLY_KEYS.has(key) ? adminHeaders() : {},
        body: JSON.stringify({ value: parsed }),
      });
      if (!result.ok) {
        console.warn('[storage-bridge] server sync failed', key, result.responseText);
      }
      return;
    }

    return;
  }

  Storage.prototype.getItem = function (key) {
    if (SYNCED_KEYS.includes(key)) {
      return mirror.has(key) ? mirror.get(key) : null;
    }
    return realGet(key);
  };

  Storage.prototype.setItem = function (key, value) {
    if (SYNCED_KEYS.includes(key)) {
      mirror.set(key, value);
      realSet(key, value);
      if (ADMIN_ONLY_KEYS.has(key) && realGet(ADMIN_KEY_STORAGE_NAME)) pushToServer(key, value);
      return;
    }
    return realSet(key, value);
  };

  Storage.prototype.removeItem = function (key) {
    if (SYNCED_KEYS.includes(key)) {
      mirror.delete(key);
      realRemove(key);
      if (ADMIN_ONLY_KEYS.has(key) && realGet(ADMIN_KEY_STORAGE_NAME) && useServerFallback) {
        fetch(`${API_BASE_URL}/api/kv/${encodeURIComponent(key)}`, {
          method: 'DELETE',
          headers: ADMIN_ONLY_KEYS.has(key) ? adminHeaders() : {},
        }).catch(() => {});
        return;
      }
      return;
    }
    return realRemove(key);
  };

  window.StorageBridge = {
    ready: () => ready,
    onReady: (fn) => { ready ? fn() : readyQueue.push(fn); },
    getClient: () => sb || window.__supabase || null,
    refresh: initServerSync,
  };

  init();
})();
