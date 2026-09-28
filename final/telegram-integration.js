/*
  telegram-integration.js
  ------------------------
  Loads the Telegram Web App SDK, expands the mini app to full height,
  and exchanges Telegram's signed initData for a real Supabase session
  (via the verify-telegram Edge Function) so this player's writes are
  authenticated instead of anonymous/spoofable.

  Include AFTER storage-bridge.js and BEFORE the game's own <script>.
  Falls back to a random local id when not running inside Telegram
  (e.g. testing in a normal browser), so the game still works standalone.
*/
(function () {
  const VERIFY_FN_URL = window.VERIFY_TELEGRAM_URL || 'https://YOUR-PROJECT.functions.supabase.co/verify-telegram';

  function loadTelegramSdk() {
    return new Promise((resolve) => {
      if (window.Telegram && window.Telegram.WebApp) return resolve(window.Telegram.WebApp);
      const s = document.createElement('script');
      s.src = 'https://telegram.org/js/telegram-web-app.js';
      s.onload = () => resolve(window.Telegram && window.Telegram.WebApp);
      s.onerror = () => resolve(null);
      document.head.appendChild(s);
    });
  }

  async function establishTelegramSession(initData) {
    const res = await fetch(VERIFY_FN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData }),
    });
    if (!res.ok) throw new Error('Telegram verification failed');
    const { player, token_hash } = await res.json();

    window.StorageBridge.onReady(async () => {
      const sb = window.StorageBridge.getClient();
      if (token_hash) {
        await sb.auth.verifyOtp({ token_hash, type: 'magiclink' });
      }
      window.TelegramPlayer = player; // { id, telegram_id, name, username }
      window.dispatchEvent(new CustomEvent('telegram-player-ready', { detail: player }));
    });
  }

  async function init() {
    const tg = await loadTelegramSdk();
    if (tg) {
      tg.ready();
      tg.expand();
      try { tg.setHeaderColor && tg.setHeaderColor('secondary_bg_color'); } catch (e) {}

      if (tg.initData) {
        try {
          await establishTelegramSession(tg.initData);
        } catch (e) {
          console.error('[telegram-integration] session setup failed', e);
        }
      }
    } else {
      // Not inside Telegram (plain web/testing) — no-op, game keeps using
      // its existing device-local profile flow.
      window.dispatchEvent(new CustomEvent('telegram-player-ready', { detail: null }));
    }
  }

  init();
})();
