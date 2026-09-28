/*
  Climate Game server connection helper
  -------------------------------------
  This file defines a small wrapper around fetch() for the production
  backend you will deploy. It is intentionally generic so it can be used
  by both the preview game page and the admin dashboard.

  Replace API_BASE_URL with your real server URL before publishing.
  If the server is not available, the helper still exposes the same API
  methods so your app can gradually switch from localStorage to server.
*/
(function(){
  const DEFAULT_API_BASE = window.API_BASE_URL || (
    window.location && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
      ? 'http://localhost:3000'
      : ''
  );
  const API_BASE_URL = DEFAULT_API_BASE ? DEFAULT_API_BASE.replace(/\/$/, '') : '';

  function buildUrl(path){
    if(!path) return API_BASE_URL;
    return path.startsWith('http') ? path : API_BASE_URL + (path.startsWith('/') ? path : '/'+path);
  }

  function parseJson(response){
    return response.text().then(text => {
      try{ return text ? JSON.parse(text) : null; }catch(e){ return text; }
    });
  }

  async function apiRequest(path, method='GET', body=null, options={}){
    const url = buildUrl(path);
    const headers = Object.assign({ 'Accept': 'application/json' }, options.headers || {});
    const init = {
      method,
      credentials: options.credentials || 'include',
      headers,
    };
    if(body != null){
      if(body instanceof FormData){
        delete headers['Content-Type'];
        init.body = body;
      } else {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
    }
    const res = await fetch(url, init);
    const data = await parseJson(res);
    if(!res.ok){
      const error = new Error(data && data.message ? data.message : `API request failed (${res.status})`);
      error.status = res.status;
      error.response = data;
      throw error;
    }
    return data;
  }

  async function apiGet(path, options){ return apiRequest(path, 'GET', null, options); }
  async function apiPost(path, body, options){ return apiRequest(path, 'POST', body, options); }
  async function apiPatch(path, body, options){ return apiRequest(path, 'PATCH', body, options); }
  async function apiPut(path, body, options){ return apiRequest(path, 'PUT', body, options); }
  async function apiDelete(path, body, options){ return apiRequest(path, 'DELETE', body, options); }

  const serverConnection = {
    API_BASE_URL,
    buildUrl,
    apiGet,
    apiPost,
    apiPatch,
    apiPut,
    apiDelete,

    fetchConfig(){ return apiGet('/api/config'); },
    fetchLeaderboard(period){ return apiGet(`/api/leaderboard?period=${encodeURIComponent(period||'daily')}`); },
    fetchPlayers(){ return apiGet('/api/players'); },
    fetchLive(){ return apiGet('/api/live'); },
    fetchAdminPlayers(){ return apiGet('/api/admin/players'); },
    fetchAdminCommands(){ return apiGet('/api/admin/commands'); },
    registerPlayer(payload){ return apiPost('/api/register', payload); },
    updateProfile(playerId, payload){ return apiPatch(`/api/profile/${encodeURIComponent(playerId)}`, payload); },
    pushLiveState(playerId, payload){ return apiPost(`/api/live/${encodeURIComponent(playerId)}`, payload); },
    sendAdminCommand(payload){ return apiPost('/api/admin/commands', payload); },
    saveAdminPlayers(payload){ return apiPut('/api/admin/players', payload); },
    saveConfig(payload){ return apiPatch('/api/config', payload); },
  };

  window.GameServerConnection = serverConnection;
})();
