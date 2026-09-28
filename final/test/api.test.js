const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

// Use a disposable key so these tests never depend on deployment secrets.
process.env.ADMIN_API_KEY = 'test-only-admin-key';
const handler = require('../api/index.js');

async function request(method, url, body, headers = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Readable.from(chunks);
  req.method = method;
  req.url = url;
  req.headers = headers;

  const responseHeaders = {};
  const res = {
    statusCode: 200,
    setHeader(name, value) { responseHeaders[name.toLowerCase()] = value; },
    end(value = '') { this.body = value; },
  };

  await handler(req, res);
  return {
    status: res.statusCode,
    headers: responseHeaders,
    body: res.body ? JSON.parse(res.body) : null,
  };
}

test('health identifies preview mode and keeps competition disabled', async () => {
  const response = await request('GET', '/api/health');
  assert.equal(response.status, 200);
  assert.equal(response.body.competitionEnabled, false);
  assert.equal(response.body.mode, 'local-preview');
});

test('public configuration does not advertise multiplayer without database credentials', async () => {
  const response = await request('GET', '/api/public-config');
  assert.equal(response.status, 200);
  assert.equal(response.body.multiplayerEnabled, false);
  assert.equal(response.body.supabaseServiceRoleKey, undefined);
});

test('account and game-run APIs clearly fail closed until a database is configured', async (t) => {
  for (const url of ['/api/account', '/api/game/start']) {
    await t.test(url, async () => {
      const response = await request(url.endsWith('start') ? 'POST' : 'GET', url, {});
      assert.equal(response.status, 503);
      assert.equal(response.body.code, 'DATABASE_NOT_CONFIGURED');
    });
  }
});

test('public leaderboard is empty and contains no player contact data', async () => {
  const response = await request('GET', '/api/leaderboard?period=daily');
  assert.equal(response.status, 200);
  assert.equal(response.body.competitionEnabled, false);
  assert.deepEqual(response.body.leaderboard, []);
  assert.equal(Object.hasOwn(response.body, 'contactTelegram'), false);
});

test('public account and score writes are rejected', async (t) => {
  const attempts = [
    ['POST', '/api/register', { id: 'attacker', score: 999999 }],
    ['PATCH', '/api/profile/victim', { score: 999999 }],
    ['POST', '/api/live/victim', { score: 999999 }],
  ];

  for (const [method, url, body] of attempts) {
    await t.test(`${method} ${url}`, async () => {
      const response = await request(method, url, body);
      assert.equal(response.status, 503);
      assert.equal(response.body.code, 'COMPETITION_DISABLED');
    });
  }
});

test('public clients cannot read private KV keys or write shared state', async (t) => {
  await t.test('private roster read', async () => {
    const response = await request('GET', '/api/kv/climateGameAdminPlayers_v1');
    assert.equal(response.status, 401);
  });

  await t.test('unknown key read', async () => {
    const response = await request('GET', '/api/kv/arbitrary');
    assert.equal(response.status, 404);
  });

  await t.test('shared state write', async () => {
    const response = await request('POST', '/api/kv/climateGameLive_v1', { value: [{ id: 'attacker', score: 999999 }] });
    assert.equal(response.status, 401);
  });
});
