window.GAME_CONFIG = window.GAME_CONFIG || {};
window.GAME_CONFIG.supabaseUrl = window.GAME_CONFIG.supabaseUrl || (window.__ENV__ && window.__ENV__.SUPABASE_URL) || '';
window.GAME_CONFIG.supabaseAnonKey = window.GAME_CONFIG.supabaseAnonKey || (window.__ENV__ && window.__ENV__.SUPABASE_ANON_KEY) || '';
window.GAME_CONFIG.verifyTelegramUrl = window.GAME_CONFIG.verifyTelegramUrl || (window.__ENV__ && window.__ENV__.VERIFY_TELEGRAM_URL) || 'https://YOUR-PROJECT.functions.supabase.co/verify-telegram';
window.GAME_CONFIG.botUsername = window.GAME_CONFIG.botUsername || (window.__ENV__ && window.__ENV__.BOT_USERNAME) || 'ClimateGameBot';
window.GAME_CONFIG.apiBaseUrl = window.GAME_CONFIG.apiBaseUrl || (window.__ENV__ && window.__ENV__.API_BASE_URL) || (
  window.location && (window.location.protocol === 'http:' || window.location.protocol === 'https:')
    ? window.location.origin
    : ''
);

window.SUPABASE_URL = window.GAME_CONFIG.supabaseUrl;
window.SUPABASE_ANON_KEY = window.GAME_CONFIG.supabaseAnonKey;
window.VERIFY_TELEGRAM_URL = window.GAME_CONFIG.verifyTelegramUrl;
window.API_BASE_URL = window.GAME_CONFIG.apiBaseUrl || '';
