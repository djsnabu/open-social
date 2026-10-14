import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import sharp from 'sharp';
import { createApp } from '../server/app.js';
import { createMcpServer } from '../server/mcp.js';
import { digest, randomToken } from '../server/security.js';

const entrypoint = fileURLToPath(new URL('../server/mcp.js', import.meta.url));
async function connect(t, origin, token) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [entrypoint],
    env: { OPEN_SOCIAL_URL: origin, OPEN_SOCIAL_TOKEN: token }, stderr: 'pipe' });
  let stderr = '';
  transport.stderr.on('data', data => { stderr += data; });
  const client = new Client({ name: 'open-social-test', version: '1.0.0' });
  t.after(async () => { await client.close(); assert.ok(!stderr.includes(token)); });
  await client.connect(transport);
  return { client, async call(name, args = {}) {
    const response = await client.callTool({ name, arguments: args });
    return { ...response, data: JSON.parse(response.content[0].text) };
  } };
}
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'open-social-mcp-'));
  const config = { origin: 'http://localhost', dataDir: dir, appKey: 'ab'.repeat(32), publishingEnabled: false };
  const app = await createApp(config, { meta: {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  config.origin = `http://127.0.0.1:${app.server.address().port}`;
  const token = `os_${randomToken()}`;
  app.db.prepare('INSERT INTO api_keys VALUES(?,?,?,?,?)').run('mcp-key', 'MCP test', digest(token), JSON.stringify(['channels:read', 'posts:read', 'posts:write', 'media:write']), new Date().toISOString());
  app.db.prepare('INSERT INTO channels(id,provider,remote_id,name,secret) VALUES(?,?,?,?,?)').run('channel-1', 'facebook', '123', 'Test page', app.secrets.encrypt('PROVIDER_TOKEN_NOT_FOR_MCP'));
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); app.db.close(); await rm(dir, { recursive: true, force: true }); });
  return { ...app, ...await connect(t, config.origin, token), token };
}

test('MCP stdio discovers tools and prepares drafts through the real scoped API', async t => {
  const f = await fixture(t);
  const { tools } = await f.client.listTools();
  assert.equal(tools.length, 9);
  assert.ok(!tools.some(tool => /publish|schedule/.test(tool.name)));
  const status = await f.call('get_status');
  assert.equal(status.data.owner, false);
  assert.equal(status.data.publishingEnabled, false);
  const channels = await f.call('list_channels');
  assert.equal(channels.data[0].id, 'channel-1');
  assert.ok(!JSON.stringify(channels).includes('PROVIDER_TOKEN_NOT_FOR_MCP'));
  const image = await sharp({ create: { width: 400, height: 400, channels: 3, background: '#fff' } }).png().toBuffer();
  const media = await f.call('upload_image', { content_type: 'image/png', base64: image.toString('base64') });
  assert.equal(media.isError, false);
  const args = { channel_id: 'channel-1', text: 'MCP test draft', timezone: 'Europe/Helsinki', media_id: media.data.id, idempotency_key: 'draft-key-001' };
  const draft = await f.call('create_draft', args);
  const replay = await f.call('create_draft', args);
  assert.equal(draft.data.state, 'draft');
  assert.deepEqual(replay.data, draft.data);
  const conflict = await f.call('create_draft', { ...args, text: 'Different text' });
  assert.equal(conflict.isError, true);
  assert.equal(conflict.data.error.code, 'idempotency_conflict');
  const changed = await f.call('update_draft', { id: draft.data.id, version: 1, text: 'Edited', media_id: null, idempotency_key: 'update-key-001' });
  assert.equal(changed.data.version, 2);
  assert.equal(changed.data.media_id, null);
  const stale = await f.call('update_draft', { id: draft.data.id, version: 1, text: 'Stale', idempotency_key: 'update-key-002' });
  assert.equal(stale.isError, true);
  assert.equal(stale.data.error.code, 'version_conflict');
  assert.equal((await f.call('get_post', { id: draft.data.id })).data.text, 'Edited');
  assert.equal((await f.call('list_posts', { state: 'draft' })).data.total, 1);
  assert.equal((await f.call('list_posts', { state: 'draft', offset: 1 })).data.posts.length, 0);
  assert.deepEqual((await f.call('get_post_attempts', { id: draft.data.id })).data, []);
  assert.equal((await f.call('cancel_post', { id: draft.data.id, version: 2, idempotency_key: 'cancel-key-001' })).data.state, 'cancelled');
  const invalid = await f.client.callTool({ name: 'get_post', arguments: { id: '../keys' } });
  assert.equal(invalid.isError, true);
  const badImage = await f.client.callTool({ name: 'upload_image', arguments: { content_type: 'image/png', base64: 'file:///etc/passwd' } });
  assert.equal(badImage.isError, true);
  const largeImage = await f.call('upload_image', { content_type: 'image/png', base64: Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64') });
  assert.equal(largeImage.data.error.code, 'body_too_large');
  f.db.prepare('UPDATE api_keys SET scopes=?').run(JSON.stringify(['posts:read']));
  assert.equal((await f.call('create_draft', { ...args, idempotency_key: 'forbidden-key-001' })).data.error.code, 'forbidden');
  f.db.prepare('DELETE FROM api_keys').run();
  assert.equal((await f.call('list_posts')).data.error.code, 'unauthorized');
});

test('MCP refuses redirects instead of forwarding its bearer token', async t => {
  let leaked = false;
  const destination = createServer((req, res) => { leaked = Boolean(req.headers.authorization); res.end('{}'); });
  await new Promise(resolve => destination.listen(0, '127.0.0.1', resolve));
  const upstream = createServer((req, res) => { res.writeHead(307, { Location: `http://127.0.0.1:${destination.address().port}/` }); res.end(); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await Promise.all([new Promise(r => upstream.close(r)), new Promise(r => destination.close(r))]); });
  const f = await connect(t, `http://127.0.0.1:${upstream.address().port}`, `os_${randomToken()}`);
  const result = await f.call('get_status');
  assert.equal(result.isError, true);
  assert.equal(result.data.error.code, 'connection_failed');
  assert.equal(leaked, false);
});

test('MCP configuration rejects insecure remote origins and embedded credentials', () => {
  const token = `os_${randomToken()}`;
  for (const url of ['http://example.com', 'https://user:password@example.com', 'https://example.com/api', 'ftp://example.com']) {
    assert.throws(() => createMcpServer({ OPEN_SOCIAL_URL: url, OPEN_SOCIAL_TOKEN: token }));
  }
  assert.throws(() => createMcpServer({ OPEN_SOCIAL_URL: 'https://example.com' }));
});
