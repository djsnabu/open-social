import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createApp } from '../server/app.js';
import { passwordHash, randomToken, digest, vault } from '../server/security.js';
import { createMeta, ProviderError } from '../server/meta.js';
import { toInstant, wallTime } from '../public/time.js';

const password = 'test-password-only';
const hash = await passwordHash(password);
async function fixture(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'open-social-test-'));
  let calls = 0;
  const meta = {
    authorizationUrl: state => `https://www.facebook.com/oauth?state=${state}`,
    discover: async () => [{ provider: 'facebook', remote_id: '123', name: 'Test page', token: 'PRIVATE_TEST_TOKEN' }],
    health: async () => true,
    publish: async () => { calls++; return { id: '123_456', url: 'https://www.facebook.com/123_456' }; },
    reconcile: async () => ({ id: '123_456', url: 'https://www.facebook.com/123_456' }),
    ...overrides.meta,
  };
  const config = { origin: 'http://localhost', dataDir: dir, appKey: 'ab'.repeat(32), passwordHash: hash,
    metaAppId: '123', metaSecret: 'TEST_SECRET', metaVersion: 'v24.0', publishingEnabled: true, ...overrides.config };
  const app = await createApp(config, { meta });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  config.origin = `http://127.0.0.1:${app.server.address().port}`;
  let cookie;
  async function request(path, { method = 'GET', data, headers = {}, token, raw, anonymous = false } = {}) {
    const res = await fetch(`${config.origin}${path.startsWith('/auth') || path.startsWith('/media/') ? path : `/api/v1${path}`}`, {
      method, redirect: 'manual', headers: { Origin: config.origin, ...(!anonymous && cookie ? { Cookie: cookie } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: raw || (data === undefined ? undefined : JSON.stringify(data)),
    });
    if (res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, data: type.includes('json') ? await res.json() : await res.text(), headers: res.headers };
  }
  assert.equal((await request('/login', { method: 'POST', data: { password } })).status, 200);
  app.db.prepare('INSERT INTO channels(id,provider,remote_id,name,secret) VALUES(?,?,?,?,?)').run('channel-1', 'facebook', '123', 'Test page', app.secrets.encrypt('PRIVATE_TEST_TOKEN'));
  async function create(text = 'A test post', options = {}) {
    return request('/posts', { method: 'POST', data: { channel_id: 'channel-1', text, timezone: 'Europe/Helsinki', ...options.data }, headers: { 'Idempotency-Key': randomToken(), ...options.headers }, ...options });
  }
  async function mutate(p, action, data = {}, key = randomToken()) {
    return request(`/posts/${p.id}${action ? `/${action}` : ''}`, { method: action ? 'POST' : 'PATCH', data: { version: p.version, ...data }, headers: { 'Idempotency-Key': key } });
  }
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); app.db.close(); await rm(dir, { recursive: true, force: true }); });
  return { ...app, request, create, mutate, get calls() { return calls; } };
}

test('authentication, CSRF, scoped keys and token redaction', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/posts', { anonymous: true })).status, 401);
  assert.equal((await f.request('/keys', { method: 'POST', data: {}, headers: { Origin: 'https://evil.example' } })).status, 403);
  const key = (await f.request('/keys', { method: 'POST', data: { name: 'Read only', scopes: ['posts:read'] } })).data;
  assert.equal((await f.request('/posts', { token: key.token })).status, 200);
  assert.equal((await f.request('/posts', { method: 'POST', token: key.token, data: {} })).status, 403);
  assert.equal((await f.request('/channels/connect', { method: 'POST', token: key.token, data: {} })).status, 403);
  assert.ok(!JSON.stringify((await f.request('/channels')).data).includes('PRIVATE_TEST_TOKEN'));
  assert.ok(!f.db.prepare('SELECT secret FROM channels').get().secret.includes('PRIVATE_TEST_TOKEN'));
  await f.request(`/keys/${key.id}`, { method: 'DELETE' });
  assert.equal((await f.request('/posts', { token: key.token })).status, 401);
  await f.request('/logout', { method: 'POST', data: {} });
  assert.equal((await f.request('/posts')).status, 401);
});

test('OAuth state is session-bound, single use and candidates hide tokens', async t => {
  const f = await fixture(t);
  const start = await f.request('/channels/connect', { method: 'POST', data: {} });
  const state = new URL(start.data.url).searchParams.get('state');
  const bad = await f.request('/auth/meta/callback?code=fake&state=wrong');
  assert.match(bad.headers.get('location'), /invalid_oauth_state/);
  const good = await f.request(`/auth/meta/callback?code=fake&state=${state}`);
  assert.match(good.headers.get('location'), /connected=choose/);
  const candidates = await f.request('/channels/candidates');
  assert.equal(candidates.data[0].remote_id, '123');
  assert.ok(!JSON.stringify(candidates.data).includes('PRIVATE_TEST_TOKEN'));
  assert.equal((await f.request('/channels/select', { method: 'POST', data: { provider: 'facebook', remote_id: 'NOT_A_CANDIDATE' } })).status, 400);
  assert.equal((await f.request('/channels/select', { method: 'POST', data: { provider: 'facebook', remote_id: '123' } })).status, 200);
  const replay = await f.request(`/auth/meta/callback?code=fake&state=${state}`);
  assert.match(replay.headers.get('location'), /invalid_oauth_state/);
});

test('durable idempotency prevents duplicate drafts and publications', async t => {
  const f = await fixture(t);
  const key = randomToken();
  const data = { channel_id: 'channel-1', text: 'Same request', timezone: 'UTC' };
  const make = data => f.request('/posts', { method: 'POST', data, headers: { 'Idempotency-Key': key } });
  const first = await make(data), replay = await make(data);
  assert.equal(first.status, 201); assert.deepEqual(replay.data, first.data);
  assert.equal((await make({ ...data, text: 'Different request' })).status, 409);
  const pubKey = randomToken();
  const queued = await f.mutate(first.data, 'publish', {}, pubKey);
  assert.equal(queued.data.state, 'scheduled');
  await Promise.all([f.scheduler.tick(), f.scheduler.tick()]);
  assert.equal(f.calls, 1);
  assert.equal((await f.mutate(first.data, 'publish', {}, pubKey)).status, 200);
  await f.scheduler.tick(); assert.equal(f.calls, 1);
  const published = (await f.request(`/posts/${first.data.id}`)).data;
  assert.equal(published.state, 'published'); assert.equal(published.remote_id, '123_456');
  assert.equal((await f.mutate(published, 'publish')).status, 409);
});

test('editing a scheduled post unschedules it and rejects stale editors', async t => {
  const f = await fixture(t);
  const p = (await f.create()).data;
  const scheduled = await f.mutate(p, 'schedule', { scheduled_at: new Date(Date.now() + 3600000).toISOString() });
  assert.equal(scheduled.status, 200);
  await f.scheduler.tick(); assert.equal(f.calls, 0);
  assert.equal((await f.mutate(p, '', { text: 'Stale' })).status, 409);
  const edited = await f.mutate(scheduled.data, '', { text: 'Changed' });
  assert.equal(edited.data.state, 'draft'); assert.equal(edited.data.scheduled_at, null);
  assert.equal((await f.mutate(edited.data, 'schedule', { scheduled_at: '2099-02-30T12:00:00Z' })).status, 400);
  assert.equal((await f.mutate(edited.data, 'schedule', { scheduled_at: '2020-01-01T12:00:00Z' })).status, 400);
  assert.equal((await f.mutate(edited.data, 'schedule', { scheduled_at: '2099-01-01T12:00:00' })).status, 400);
});

test('timeouts and interrupted workers never retry uncertain publication', async t => {
  const f = await fixture(t, { meta: { publish: async () => { throw new ProviderError('timeout', 'Unknown outcome', true); } } });
  const p = (await f.create()).data;
  await f.mutate(p, 'publish'); await f.scheduler.tick();
  const uncertain = (await f.request(`/posts/${p.id}`)).data;
  assert.equal(uncertain.state, 'uncertain');
  assert.equal((await f.mutate(uncertain, 'publish')).status, 409);
  assert.equal((await f.mutate(uncertain, '', { text: 'Another try' })).status, 409);
  const stale = (await f.create('Interrupted')).data;
  f.db.prepare("UPDATE posts SET state='publishing',claimed_at='2000-01-01T00:00:00Z' WHERE id=?").run(stale.id);
  await f.scheduler.tick(); assert.equal((await f.request(`/posts/${stale.id}`)).data.state, 'uncertain');
  const reconciled = await f.request(`/posts/${p.id}/reconcile`, { method: 'POST', data: { version: uncertain.version, remote_id: '123_456' } });
  assert.equal(reconciled.data.state, 'published');
});

test('definite provider rejection is retryable and marks expired connection', async t => {
  const f = await fixture(t, { meta: { publish: async () => { throw new ProviderError('reconnect_required', 'Reconnect'); } } });
  const p = (await f.create()).data;
  await f.mutate(p, 'publish'); await f.scheduler.tick();
  assert.equal((await f.request(`/posts/${p.id}`)).data.state, 'failed');
  assert.equal((await f.request('/channels')).data[0].status, 'reconnect_required');
});

test('disconnect cancels queued work without deleting content; disabled publishing is enforced', async t => {
  const f = await fixture(t);
  const p = (await f.create()).data;
  await f.mutate(p, 'publish');
  await f.request('/channels/channel-1', { method: 'DELETE' });
  await f.scheduler.tick(); assert.equal(f.calls, 0);
  assert.equal((await f.request(`/posts/${p.id}`)).data.state, 'draft');
  assert.equal(f.db.prepare('SELECT secret FROM channels').get().secret, '');
  const other = await fixture(t, { config: { publishingEnabled: false } });
  assert.equal((await other.mutate((await other.create()).data, 'publish')).data.error.code, 'publishing_disabled');
});

test('media is decoded, normalized, validated and cannot traverse paths', async t => {
  const f = await fixture(t);
  const image = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#fff' } }).png().toBuffer();
  const upload = await f.request('/media', { method: 'POST', raw: image, headers: { 'Content-Type': 'image/png' } });
  assert.equal(upload.status, 201); assert.equal(upload.data.width, 100);
  const bytes = await readFile(join(f.config.dataDir, 'media', `${upload.data.id}.jpg`));
  assert.equal((await sharp(bytes).metadata()).format, 'jpeg');
  assert.equal((await f.request('/media', { method: 'POST', raw: Buffer.from('<script>bad</script>'), headers: { 'Content-Type': 'image/png' } })).status, 400);
  f.db.prepare("UPDATE channels SET provider='instagram' WHERE id='channel-1'").run();
  assert.equal((await f.create()).data.error.code, 'image_required');
  const ig = await f.request('/posts', { method: 'POST', data: { channel_id: 'channel-1', text: 'Image caption', media_id: upload.data.id, timezone: 'UTC' }, headers: { 'Idempotency-Key': randomToken() } });
  assert.equal(ig.status, 201);
  assert.equal((await f.mutate(ig.data, 'publish')).data.error.code, 'public_media_required');
});

test('timezone conversion handles Finnish DST, gaps and overlaps', () => {
  assert.equal(toInstant('2026-10-14T12:00', 'Europe/Helsinki'), '2026-10-14T09:00:00.000Z');
  assert.equal(toInstant('2026-12-14T12:00', 'Europe/Helsinki'), '2026-12-14T10:00:00.000Z');
  assert.throws(() => toInstant('2026-03-29T03:30', 'Europe/Helsinki'), /ei ole olemassa/);
  assert.throws(() => toInstant('2026-10-25T03:30', 'Europe/Helsinki'), /kaksiselitteisen/);
  assert.throws(() => toInstant('2026-02-30T12:00', 'UTC'));
  assert.equal(wallTime(toInstant('2026-10-14T12:00', 'Asia/Kathmandu'), 'Asia/Kathmandu'), '2026-10-14T12:00');
});

test('authenticated encryption rejects tampering and wrong key', () => {
  const v = vault('ab'.repeat(32)), encrypted = v.encrypt('token');
  assert.equal(v.decrypt(encrypted), 'token');
  assert.throws(() => vault('cd'.repeat(32)).decrypt(encrypted));
  assert.throws(() => vault('bad'));
});

test('queue and idempotency survive another process opening the same database', async t => {
  const f = await fixture(t);
  const p = (await f.create('Durable queue')).data;
  const key = randomToken();
  const queued = await f.mutate(p, 'publish', {}, key);
  let secondCalls = 0;
  const second = await createApp(f.config, { meta: { publish: async () => { secondCalls++; return { id: '123_999', url: null }; } } });
  try {
    assert.equal(second.db.prepare('SELECT state FROM posts WHERE id=?').get(p.id).state, 'scheduled');
    assert.equal(second.db.prepare('SELECT key FROM requests WHERE key=?').get(key).key, key);
    await Promise.all([f.scheduler.tick(), second.scheduler.tick()]);
    assert.equal(f.calls + secondCalls, 1);
    assert.equal(second.db.prepare('SELECT state FROM posts WHERE id=?').get(p.id).state, 'published');
    assert.equal((await f.mutate(p, 'publish', {}, key)).data.version, queued.data.version);
  } finally { second.db.close(); }
});

test('oversized JSON returns a structured 413 and private uploads require authentication', async t => {
  const f = await fixture(t);
  const large = await f.request('/posts', { method: 'POST', data: { text: 'x'.repeat(70000) } });
  assert.equal(large.status, 413); assert.equal(large.data.error.code, 'body_too_large');
  const image = await sharp({ create: { width: 400, height: 400, channels: 3, background: '#fff' } }).png().toBuffer();
  const upload = await f.request('/media', { method: 'POST', raw: image, headers: { 'Content-Type': 'image/png' } });
  assert.equal((await f.request(`/media/${upload.data.id}.jpg`, { anonymous: true })).status, 401);
  assert.equal((await f.request(`/media/${upload.data.id}.jpg`)).status, 200);
});

test('Meta adapter uses bearer auth, does not leak provider messages, and persists Instagram container before publish', async () => {
  const config = { origin: 'https://social.example', metaVersion: 'v24.0', metaSecret: 'secret', metaAppId: '123' };
  const calls = [], saved = [];
  const responses = [{ id: '456' }, { status_code: 'FINISHED' }, { id: '789' }, { permalink: 'https://www.instagram.com/p/test/' }];
  const meta = createMeta(config, async (url, options) => {
    calls.push({ url, options });
    if (url.pathname.endsWith('media_publish')) assert.deepEqual(saved, ['456']);
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    assert.ok(!url.href.includes('test-token'));
    return Response.json(responses.shift());
  });
  const result = await meta.publish({ text: 'caption' }, { provider: 'instagram', remote_id: '123' }, 'test-token', 'https://social.example/image.jpg', id => saved.push(id));
  assert.equal(result.id, '789'); assert.equal(calls.length, 4);
  const rejected = createMeta(config, async () => Response.json({ error: { code: 190, message: 'SECRET MUST NOT LEAK' } }, { status: 400 }));
  await assert.rejects(rejected.health({ remote_id: '123' }, 'token'), error => error.code === 'reconnect_required' && !error.message.includes('SECRET'));
  const ambiguous = createMeta(config, async () => { throw new Error('Network failed'); });
  await assert.rejects(ambiguous.publish({ text: 'test' }, { provider: 'facebook', remote_id: '123' }, 'token', null), error => error.uncertain === true);
});
