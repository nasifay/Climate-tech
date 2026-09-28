const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'public-anon-key-for-test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-only-test-key';
process.env.ADMIN_API_KEY = 'test-only-admin-key';
const handler = require('../api/index.js');

async function request(url) {
  const req = Readable.from([]);
  req.method = 'GET';
  req.url = url;
  req.headers = {};
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(value = '') { this.body = value; },
  };
  await handler(req, res);
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

test('multiplayer public config exposes only the browser-safe Supabase settings', async () => {
  const response = await request('/api/public-config');
  assert.equal(response.status, 200);
  assert.equal(response.body.multiplayerEnabled, true);
  assert.equal(response.body.supabaseUrl, process.env.SUPABASE_URL);
  assert.equal(response.body.supabaseAnonKey, process.env.SUPABASE_ANON_KEY);
  assert.equal(Object.hasOwn(response.body, 'supabaseServiceRoleKey'), false);
});

test('multiplayer health endpoint signals database-backed competition', async () => {
  const response = await request('/api/health');
  assert.equal(response.status, 200);
  assert.equal(response.body.multiplayerEnabled, true);
});
