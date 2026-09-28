import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store.js';
import { createHttpServer } from '../src/server.js';
import { createConnectServer, approvalPreview, approveAction } from '../src/cli.js';
import { receiveWebhook, validWebhookSignature, webhookChallenge } from '../src/webhooks.js';
import type { Config, Connection } from '../src/types.js';

const config: Config = {
  product: 'facebook_login', apiVersion: 'v26.0', appId: '100', appSecret: 'test-secret-never-production',
  encryptionKey: Buffer.alloc(32, 7), databasePath: ':memory:', redirectUri: 'http://127.0.0.1:8787/oauth/callback',
  httpHost: '127.0.0.1', httpPort: 8788, httpBearerToken: 'test-only-bearer-token-01234567890123456789',
  webhookVerifyToken: 'test-verification-secret', facebookPageId: '200',
};
const connection: Connection = {
  product: 'facebook_login', accountId: '300', pageId: '200', accessToken: 'NEVER_PRINT_ME',
  appId: '100', permissions: ['instagram_basic', 'pages_show_list', 'pages_read_engagement'],
  issuedAt: Date.now(), expiresAt: Date.now() + 86_400_000, connectedAt: Date.now(),
};
function storeWithAccount() { const store = new Store(':memory:', config.encryptionKey); store.saveConnection(connection); return store; }
const signature = (raw: Buffer) => `sha256=${createHmac('sha256', config.appSecret).update(raw).digest('hex')}`;
function messageBody(timestamp = Date.now(), recipient = '300', extra: Record<string, unknown> = {}) {
  return Buffer.from(JSON.stringify({ object: 'instagram', entry: [{ id: '300', messaging: [{
    sender: { id: '400' }, recipient: { id: recipient }, timestamp, message: { mid: 'message-1', text: 'Hello', ...extra },
  }] }] }));
}
async function listening(server: Server) {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return (server.address() as AddressInfo).port;
}
async function close(server: Server) {
  const closed = new Promise<void>(resolve => server.close(() => resolve()));
  server.closeAllConnections();
  await closed;
}
function send(port: number, path: string, method = 'GET', headers: Record<string, string> = {}, body?: string | Buffer) {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { Host: '127.0.0.1:8788', ...headers } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk as Buffer));
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('webhook HMAC validates raw bytes and rejects altered bodies and malformed signatures', () => {
  const raw = messageBody();
  assert.equal(validWebhookSignature(raw, signature(raw), config.appSecret), true);
  assert.equal(validWebhookSignature(Buffer.concat([raw, Buffer.from(' ')]), signature(raw), config.appSecret), false);
  assert.equal(validWebhookSignature(raw, 'sha256=zz', config.appSecret), false);
  assert.equal(validWebhookSignature(raw, undefined, config.appSecret), false);
});

test('webhook challenge requires correct token and subscribe mode', () => {
  assert.equal(webhookChallenge(new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': config.webhookVerifyToken!, 'hub.challenge': '1234' }), config), '1234');
  assert.throws(() => webhookChallenge(new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '1234' }), config), /verification failed/);
});

test('Facebook Page messages cannot establish an Instagram messaging window', () => {
  const store=storeWithAccount();
  try {
    const raw=Buffer.from(JSON.stringify({object:'page',entry:[{id:'200',messaging:[{sender:{id:'400'},recipient:{id:'200'},timestamp:Date.now(),message:{mid:'facebook-message',text:'Hello'}}]}]}));
    assert.equal(receiveWebhook(raw,signature(raw),config,store),0);
    assert.equal(store.inboundMessageAt('300','400'),undefined);
  } finally {store.close();}
});

test('signed inbound messages normalize, encrypt, and deduplicate before acknowledgement', () => {
  const store = storeWithAccount();
  try {
    const timestamp = Date.now(), raw = messageBody(timestamp);
    assert.equal(receiveWebhook(raw, signature(raw), config, store), 1);
    receiveWebhook(raw, signature(raw), config, store);
    const events = store.events('300', Date.now() + 1, 10);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.topic, 'messages');
    assert.deepEqual(events[0]!.payload, { sender_id: '400', recipient_id: '300', text: 'Hello', message_id: 'message-1', timestamp });
    const row = store.db.prepare('SELECT payload FROM events').get();
    assert.equal(String(row!.payload).includes('Hello'), false);
  } finally { store.close(); }
});

test('webhooks reject foreign accounts and recipients without partial writes', () => {
  const store = storeWithAccount();
  try {
    for (const raw of [messageBody(Date.now(), '999'), Buffer.from(JSON.stringify({ object: 'instagram', entry: [{ id: '999', changes: [] }] }))]) {
      assert.throws(() => receiveWebhook(raw, signature(raw), config, store), /connected account/);
    }
    assert.equal(store.events('300', Date.now() + 1, 10).length, 0);
  } finally { store.close(); }
});

test('webhooks ignore stale, future, deleted, and echo messages for messaging-window authorization', () => {
  const store = storeWithAccount(), now = Date.now();
  try {
    for (const raw of [messageBody(now + 10 * 60_000), messageBody(now - 31 * 86_400_000), messageBody(now, '300', { is_echo: true }), messageBody(now, '300', { is_deleted: true })]) {
      assert.equal(receiveWebhook(raw, signature(raw), config, store, now), 0);
    }
    assert.equal(store.events('300', now + 1, 10).length, 0);
  } finally { store.close(); }
});

test('comment and mention payloads whitelist documented identities and omit unexpected secrets', () => {
  const store = storeWithAccount();
  try {
    const raw = Buffer.from(JSON.stringify({ object: 'instagram', entry: [{ id: '300', time: 1700000000, changes: [
      { field: 'comments', value: { id: '500', text: 'Comment', from: { id: '400', username: 'reader' }, media: { id: '600' }, access_token: 'DO_NOT_STORE' } },
      { field: 'mentions', value: { media_id: '600', comment_id: '500', secret: 'DO_NOT_STORE' } },
      { field: 'invented_media_changes', value: { id: '600' } },
    ] }] }));
    assert.equal(receiveWebhook(raw, signature(raw), config, store), 2);
    assert.equal(JSON.stringify(store.events('300', Date.now() + 1, 10)).includes('DO_NOT_STORE'), false);
  } finally { store.close(); }
});

test('webhook transaction rolls back the whole delivery on a storage error', () => {
  const store = storeWithAccount();
  const event = store.event.bind(store);
  let writes = 0;
  store.event = (...args) => { if (++writes === 2) throw new Error('storage failure'); event(...args); };
  try {
    const raw = Buffer.from(JSON.stringify({ object: 'instagram', entry: [{ id: '300', changes: [
      { field: 'comments', value: { id: '500', text: 'First' } },
      { field: 'comments', value: { id: '501', text: 'Second' } },
    ] }] }));
    assert.throws(() => receiveWebhook(raw, signature(raw), config, store), /could not be stored/);
    assert.equal(store.events('300', Date.now() + 1, 10).length, 0);
  } finally { store.close(); }
});

test('HTTP enforces bearer, host, origin, body bounds, and stateless methods', async () => {
  const store = storeWithAccount(), server = createHttpServer(config, store), port = await listening(server);
  try {
    assert.equal((await send(port, '/healthz')).status, 200);
    assert.equal((await send(port, '/mcp', 'POST')).status, 401);
    assert.equal((await send(port, '/healthz', 'GET', { Host: 'attacker.example' })).status, 403);
    assert.equal((await send(port, '/healthz', 'GET', { Origin: 'https://attacker.example' })).status, 403);
    const auth = { Authorization: `Bearer ${config.httpBearerToken}`, 'Content-Type': 'application/json' };
    assert.equal((await send(port, '/mcp', 'GET', auth)).status, 405);
    assert.equal((await send(port, '/mcp', 'POST', auth, 'invalid json')).status, 400);
    assert.equal((await send(port, '/mcp', 'POST', { ...auth, 'Content-Length': '300000' })).status, 413);
    assert.equal((await send(port, '/mcp', 'POST', { Authorization: auth.Authorization }, '{}')).status, 400);
    assert.throws(() => createHttpServer({ ...config, httpBearerToken: 'short' }, store), /32 characters/);
  } finally { await close(server); store.close(); }
});

test('HTTP webhook endpoint verifies challenge and persists signed events before returning 200', async () => {
  const store = storeWithAccount(), server = createHttpServer(config, store), port = await listening(server);
  try {
    const query = new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': config.webhookVerifyToken!, 'hub.challenge': '42' });
    const challenge = await send(port, `/webhooks/instagram?${query}`);
    assert.equal(challenge.status, 200);
    assert.equal(challenge.body, '42');
    const raw = messageBody();
    assert.equal((await send(port, '/webhooks/instagram', 'POST', { 'x-hub-signature-256': signature(raw) }, raw)).status, 200);
    assert.equal(store.events('300', Date.now() + 1, 10).length, 1);
    assert.equal((await send(port, '/webhooks/instagram', 'POST', {}, raw)).status, 403);
  } finally { await close(server); store.close(); }
});

test('HTTP MCP uses the official transport for initialize and tools/list', async () => {
  const store = storeWithAccount(), server = createHttpServer(config, store), port = await listening(server);
  const headers = { Authorization: `Bearer ${config.httpBearerToken}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  try {
    const initialized = await send(port, '/mcp', 'POST', headers, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'unit-test', version: '1.0.0' } } }));
    assert.equal(initialized.status, 200);
    assert.equal(JSON.parse(initialized.body).result.serverInfo.name, 'furlpay-instagram-mcp');
    assert.equal(initialized.headers['mcp-session-id'], undefined);
    const listed = await send(port, '/mcp', 'POST', headers, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }));
    assert.equal(listed.status, 200);
    const tools = JSON.parse(listed.body).result.tools as { name: string; annotations: { readOnlyHint: boolean } }[];
    assert.ok(tools.length > 0);
    assert.ok(tools.find(tool => tool.name === 'instagram_get_account')?.annotations.readOnlyHint);
    assert.equal(listed.body.includes('NEVER_PRINT_ME'), false);
  } finally { await close(server); store.close(); }
});

test('OAuth connect server requires one-use ticket and browser cookie before exchanging code', async () => {
  let calls = 0;
  const binding = 'b'.repeat(43), state = 's'.repeat(43);
  const flow = createConnectServer(config, {
    begin: () => ({ url: `https://www.facebook.com/v26.0/dialog/oauth?state=${state}`, state, browserBinding: binding }),
    complete: async (code, actualState, actualBinding) => {
      calls++;
      assert.equal(code, 'code-1'); assert.equal(actualState, state); assert.equal(actualBinding, binding);
      return connection;
    },
  });
  const outcome = flow.completion.catch(error => error as Error);
  const port = await listening(flow.server), host = { Host: '127.0.0.1:8787' };
  try {
    assert.equal((await send(port, '/oauth/callback?code=code-1&state=' + state, 'GET', host)).status, 400);
    const startPath = new URL(flow.startUrl).pathname + new URL(flow.startUrl).search;
    const started = await send(port, startPath, 'GET', host);
    assert.equal(started.status, 302);
    assert.match(String(started.headers['set-cookie']), /HttpOnly; SameSite=Lax/);
    assert.equal((await send(port, startPath, 'GET', host)).status, 400);
    assert.equal((await send(port, '/oauth/callback?code=code-1&state=' + state, 'GET', { ...host, Cookie: `fp_instagram_oauth=${binding}` })).status, 200);
    await outcome;
    assert.equal(calls, 1);
  } finally { flow.cancel(); await outcome; await close(flow.server); }
});

test('OAuth denial settles only a matching browser-bound state and never exchanges a code', async () => {
  const binding = 'b'.repeat(43), state = 's'.repeat(43);
  let exchanges = 0, settled = false;
  const flow = createConnectServer(config, {
    begin: () => ({ url: `https://www.facebook.com/v26.0/dialog/oauth?state=${state}`, state, browserBinding: binding }),
    complete: async () => { exchanges++; return connection; },
  });
  const outcome = flow.completion.then(() => { settled = true; return undefined; }, error => { settled = true; return error as { code: string; message: string }; });
  const port = await listening(flow.server), host = { Host: '127.0.0.1:8787' };
  const cookie = { ...host, Cookie: `fp_instagram_oauth=${binding}` };
  try {
    const start = new URL(flow.startUrl);
    assert.equal((await send(port, start.pathname + start.search, 'GET', host)).status, 302);
    const callback = `/oauth/callback?error=access_denied&state=${state}`;
    assert.equal((await send(port, callback, 'GET', host)).status, 400);
    assert.equal((await send(port, callback, 'GET', { ...host, Cookie: `fp_instagram_oauth=${'x'.repeat(43)}` })).status, 400);
    assert.equal((await send(port, '/oauth/callback?error=access_denied&state=wrong', 'GET', cookie)).status, 400);
    assert.equal((await send(port, `${callback}&state=${state}`, 'GET', cookie)).status, 400);
    assert.equal((await send(port, `${callback}&code=ambiguous`, 'GET', cookie)).status, 400);
    assert.equal(settled, false);
    const denied = await send(port, `${callback}&error_description=UNTRUSTED_PROVIDER_DETAIL`, 'GET', cookie);
    assert.equal(denied.status, 200);
    assert.match(String(denied.headers['set-cookie']), /Max-Age=0/);
    assert.equal(denied.body.includes('UNTRUSTED_PROVIDER_DETAIL'), false);
    const error = await outcome;
    assert.equal(error?.code, 'INSTAGRAM_OAUTH_CANCELLED');
    assert.equal(error?.message.includes('UNTRUSTED_PROVIDER_DETAIL'), false);
    assert.equal(exchanges, 0);
    assert.equal((await send(port, callback, 'GET', cookie)).status, 400);
  } finally { flow.cancel(); await outcome; await close(flow.server); }
});

test('approval preview binds exact account and action; piped approval is rejected', async () => {
  const store = storeWithAccount();
  try {
    const approval = store.requestApproval('instagram_delete_comment', { comment_id: '500', reason: '\u001b[31munsafe' }, '300');
    const preview = approvalPreview(store, approval.id);
    assert.match(preview, /instagram_delete_comment/);
    assert.match(preview, /"account_id": "300"/);
    assert.equal(preview.includes('\u001b'), false);
    if (!process.stdin.isTTY || !process.stderr.isTTY) await assert.rejects(approveAction(store, approval.id), /interactive operator terminal/);
    assert.equal(store.getApproval(approval.id).status, 'pending');
    assert.throws(() => approvalPreview(store, 'invalid'), /valid approval/);
    assert.throws(() => approvalPreview(store, randomUUID()), /not found/);
  } finally { store.close(); }
});
