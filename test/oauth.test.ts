import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { OAuthService, DEFAULT_SCOPES } from '../src/oauth.js';
import { Store } from '../src/store.js';
import { InstagramError } from '../src/errors.js';
import type { Config, Data, Fetch } from '../src/types.js';

const config: Config = {
  product: 'facebook_login', apiVersion: 'v26.0', appId: '123', appSecret: 'not-a-real-client-secret',
  encryptionKey: Buffer.alloc(32, 1), databasePath: ':memory:', redirectUri: 'http://localhost:8787/oauth/callback',
  httpHost: '127.0.0.1', httpPort: 8788,
};
const nowSeconds = () => Math.floor(Date.now() / 1000);
const tokenInfo = (patch: Data = {}) => ({ data: { app_id: '123', type: 'USER', is_valid: true, user_id: '456',
  scopes: DEFAULT_SCOPES, expires_at: nowSeconds() + 3600, data_access_expires_at: nowSeconds() + 1800, ...patch } });
function harness(options: { config?: Partial<Config>; debug?: Data; pages?: Data[]; me?: Data; profile?: Data; linked?: Data } = {}) {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const pages = [...options.pages ?? [{ data: [{ id: '789', access_token: 'page-secret' }] }]];
  const fetcher: Fetch = async (url, init) => {
    const u = new URL(String(url));
    calls.push({ url: u, init });
    let body: unknown;
    if (u.pathname.endsWith('/oauth/access_token')) body = { access_token: u.searchParams.has('code') ? 'short-secret' : 'long-secret', expires_in: 7200 };
    else if (u.pathname.endsWith('/debug_token')) body = options.debug ?? tokenInfo();
    else if (u.pathname.endsWith('/me/accounts')) body = pages.shift();
    else if (u.pathname.endsWith('/me')) body = options.me ?? { id: '456' };
    else if (u.pathname.endsWith('/789')) body = options.linked ?? { id: '789', instagram_business_account: { id: '111' } };
    else if (u.pathname.endsWith('/111')) body = options.profile ?? { id: '111', username: 'furlpay' };
    else throw new Error('Unexpected upstream request');
    return Response.json(body);
  };
  const store = new Store(':memory:', config.encryptionKey);
  const service = new OAuthService({ ...config, ...options.config }, store, fetcher);
  return { service, store, calls, run: () => { const flow = service.begin(); return service.complete('authorization-code', flow.state, flow.browserBinding); } };
}
function errorCode(code: string) { return (error: unknown) => error instanceof InstagramError && error.code === code; }

test('OAuth uses one-time browser-bound state and only stores hashes', async t => {
  const h = harness(); t.after(() => h.store.db.close());
  const flow = h.service.begin();
  const url = new URL(flow.url);
  assert.equal(url.origin, 'https://www.facebook.com');
  assert.equal(url.pathname, '/v26.0/dialog/oauth');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('redirect_uri'), config.redirectUri);
  assert.equal(url.searchParams.get('state'), flow.state);
  assert.notEqual(flow.state, flow.browserBinding);
  const row = h.store.db.prepare('SELECT * FROM oauth_states').get()!;
  assert.equal(row.state_hash, createHash('sha256').update(flow.state).digest('hex'));
  assert.equal(JSON.stringify(row).includes(flow.browserBinding), false);
  await assert.rejects(h.service.complete('authorization-code', flow.state, 'a'.repeat(43)), errorCode('INSTAGRAM_OAUTH_STATE_INVALID'));
  assert.equal(h.calls.length, 0);
  await h.service.complete('authorization-code', flow.state, flow.browserBinding);
  const count = h.calls.length;
  await assert.rejects(h.service.complete('authorization-code', flow.state, flow.browserBinding), errorCode('INSTAGRAM_OAUTH_STATE_INVALID'));
  assert.equal(h.calls.length, count);
});

test('Facebook Login for Business configuration is bound to the OAuth session',async t=>{
  const h=harness({config:{facebookLoginConfigId:'987'}});t.after(()=>h.store.close());
  const flow=h.service.begin();assert.equal(new URL(flow.url).searchParams.get('config_id'),'987');
  const changed=new OAuthService({...config,facebookLoginConfigId:'654'},h.store);
  await assert.rejects(changed.complete('code',flow.state,flow.browserBinding),errorCode('INSTAGRAM_OAUTH_STATE_INVALID'));
  assert.equal(h.calls.length,0);
});

test('OAuth exchanges tokens, verifies identity, discovers Page/account and encrypts credentials', async t => {
  const h = harness(); t.after(() => h.store.db.close());
  const connection = await h.run();
  assert.equal(connection.accountId, '111');
  assert.equal(connection.userId, '456');
  assert.equal(connection.pageId, '789');
  assert.equal(connection.pageAccessToken, 'page-secret');
  assert.equal(connection.accessToken, 'long-secret');
  assert.equal(connection.username, 'furlpay');
  assert.equal(connection.accountType, undefined);
  assert.equal(connection.expiresAt, connection.dataAccessExpiresAt);
  assert.equal(h.store.getConnection()?.accountId, '111');
  const sealed = String(h.store.db.prepare('SELECT sealed FROM connection').get()?.sealed);
  assert.equal(sealed.includes('long-secret'), false);
  assert.equal(sealed.includes('page-secret'), false);
  assert.equal(h.calls[0]!.url.searchParams.get('code'), 'authorization-code');
  assert.equal(h.calls[1]!.url.searchParams.get('grant_type'), 'fb_exchange_token');
  assert.equal(h.calls[1]!.url.searchParams.get('fb_exchange_token'), 'short-secret');
  const pages = h.calls.find(c => c.url.pathname.endsWith('/me/accounts'))!;
  assert.equal(new Headers(pages.init?.headers).get('authorization'), 'Bearer long-secret');
  assert.ok(pages.url.searchParams.get('appsecret_proof'));
  assert.ok(h.calls.every(c => c.init?.redirect === 'error' && !!c.init.signal));
});

test('expired OAuth state and changed redirect context are rejected before exchanging a code', async t => {
  const h = harness(); t.after(() => h.store.db.close());
  let flow = h.service.begin();
  h.store.db.prepare('UPDATE oauth_states SET expires=?').run(Date.now() - 1);
  await assert.rejects(h.service.complete('code', flow.state, flow.browserBinding), errorCode('INSTAGRAM_OAUTH_STATE_INVALID'));
  flow = h.service.begin();
  const other = new OAuthService({ ...config, redirectUri: 'http://localhost:9999/oauth/callback' }, h.store);
  await assert.rejects(other.complete('code', flow.state, flow.browserBinding), errorCode('INSTAGRAM_OAUTH_STATE_INVALID'));
  assert.equal(h.calls.length, 0);
});

for (const [name, patch] of Object.entries({
  'wrong app': { app_id: '666' }, 'invalid token': { is_valid: false }, 'wrong token type': { type: 'PAGE' },
  'expired token': { expires_at: 1 }, 'expired data access': { data_access_expires_at: 1 },
  'missing user': { user_id: '' },
})) {
  test(`OAuth rejects ${name} and does not persist a connection`, async t => {
    const h = harness({ debug: tokenInfo(patch) }); t.after(() => h.store.db.close());
    await assert.rejects(h.run(), errorCode('INSTAGRAM_REAUTH_REQUIRED'));
    assert.equal(h.store.getConnection(), undefined);
  });
}

test('OAuth rejects mismatched user identity and missing base permission', async t => {
  const mismatch = harness({ me: { id: '777' } }); t.after(() => mismatch.store.db.close());
  await assert.rejects(mismatch.run(), errorCode('INSTAGRAM_REAUTH_REQUIRED'));
  const missing = harness({ debug: tokenInfo({ scopes: ['instagram_basic'] }) }); t.after(() => missing.store.db.close());
  await assert.rejects(missing.run(), errorCode('INSTAGRAM_PERMISSION_REQUIRED'));
});

test('declined optional write scopes permit a read-only connection without fabricating permissions', async t => {
  const scopes = ['instagram_basic', 'pages_show_list', 'pages_read_engagement'];
  const h = harness({ debug: tokenInfo({ scopes }) }); t.after(() => h.store.db.close());
  const connection = await h.run();
  assert.deepEqual(connection.permissions, scopes);
});

test('Page discovery follows bounded cursors on the official host and selects only the authorized Page', async t => {
  const h = harness({ config: { facebookPageId: '789' }, pages: [
    { data: [{ id: '888' }], paging: { next: 'https://attacker.invalid/steal?access_token=secret', cursors: { after: 'cursor-2' } } },
    { data: [{ id: '789', access_token: 'page-secret' }] },
  ] }); t.after(() => h.store.db.close());
  await h.run();
  const calls = h.calls.filter(c => c.url.pathname.endsWith('/me/accounts'));
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.url.searchParams.get('after'), 'cursor-2');
  assert.ok(h.calls.every(c => c.url.hostname === 'graph.facebook.com'));
});

test('multiple Pages require explicit operator selection and unauthorized Page IDs fail', async t => {
  const multiple = harness({ pages: [{ data: [{ id: '789' }, { id: '888' }] }] }); t.after(() => multiple.store.db.close());
  await assert.rejects(multiple.run(), errorCode('INSTAGRAM_PAGE_SELECTION_REQUIRED'));
  const missing = harness({ config: { facebookPageId: '888' } }); t.after(() => missing.store.db.close());
  await assert.rejects(missing.run(), errorCode('INSTAGRAM_ACCOUNT_REQUIRED'));
});

test('repeated Page pagination cursors fail safely', async t => {
  const page = { data: [{ id: '789' }], paging: { next: 'https://graph.facebook.com/next', cursors: { after: 'same' } } };
  const h = harness({ pages: [page, page] }); t.after(() => h.store.db.close());
  await assert.rejects(h.run(), errorCode('INSTAGRAM_UPSTREAM_ERROR'));
  assert.equal(h.calls.filter(c => c.url.pathname.endsWith('/me/accounts')).length, 2);
});

test('profile must match the authorized Instagram professional account', async t => {
  const h = harness({ profile: { id: '222', username: 'another-account' } }); t.after(() => h.store.db.close());
  await assert.rejects(h.run(), errorCode('INSTAGRAM_ACCOUNT_REQUIRED'));
});

test('a Page without a linked Instagram professional account is rejected', async t => {
  const h = harness({ linked: { id: '789' } }); t.after(() => h.store.db.close());
  await assert.rejects(h.run(), errorCode('INSTAGRAM_ACCOUNT_REQUIRED'));
  assert.equal(h.store.getConnection(), undefined);
});

test('validate checks live token status and local expiration; disconnect removes credentials and pending states', async t => {
  const h = harness(); t.after(() => h.store.db.close());
  await h.run();
  const checked = await h.service.validate();
  assert.ok(checked.lastValidatedAt);
  h.store.saveConnection({ ...checked, expiresAt: Date.now() - 1 });
  const count = h.calls.length;
  await assert.rejects(h.service.validate(), errorCode('INSTAGRAM_REAUTH_REQUIRED'));
  assert.equal(h.calls.length, count);
  h.service.begin();
  h.service.disconnect();
  assert.equal(h.store.getConnection(), undefined);
  assert.equal(h.store.db.prepare('SELECT count(*) AS n FROM oauth_states').get()?.n, 0);
});

test('upstream OAuth failures are redacted and the single-use code is never retried', async t => {
  const store = new Store(':memory:', config.encryptionKey); t.after(() => store.db.close());
  let calls = 0;
  const service = new OAuthService(config, store, async () => { calls++; return Response.json({ error: { code: 190, message: 'secret-code secret-token' } }, { status: 400 }); });
  const flow = service.begin();
  await assert.rejects(service.complete('secret-code', flow.state, flow.browserBinding), (error: unknown) => {
    assert.ok(error instanceof InstagramError);
    assert.equal(error.code, 'INSTAGRAM_REAUTH_REQUIRED');
    assert.equal(error.message.includes('secret'), false);
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(store.getConnection(), undefined);
});

test('OAuth rate limits and network errors have sanitized stable error codes', async t => {
  for (const [fetcher, code] of [
    [async () => Response.json({ error: { code: 4, message: 'secret' } }, { status: 429 }), 'INSTAGRAM_RATE_LIMITED'],
    [async () => new Response('<html>Unavailable</html>', { status: 429 }), 'INSTAGRAM_RATE_LIMITED'],
    [async () => new Response('<html>Unavailable</html>', { status: 503 }), 'INSTAGRAM_UPSTREAM_ERROR'],
    [async () => Response.json({ error: { code: 200, message: 'secret' } }, { status: 403 }), 'INSTAGRAM_PERMISSION_REQUIRED'],
    [async () => { throw new Error('https://example.invalid?client_secret=secret'); }, 'INSTAGRAM_NETWORK_ERROR'],
  ] as const) {
    const store = new Store(':memory:', config.encryptionKey); t.after(() => store.db.close());
    const service = new OAuthService(config, store, fetcher);
    const flow = service.begin();
    await assert.rejects(service.complete('code', flow.state, flow.browserBinding), errorCode(code));
  }
});

test('OAuth rejects oversized declared and streamed bodies before retaining unbounded content', async t => {
  for (const declared of [true, false]) {
    const store = new Store(':memory:', config.encryptionKey); t.after(() => store.db.close());
    let cancelled = false;
    let pulls = 0;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array(262_144)); },
      cancel() { cancelled = true; },
    }), declared ? { headers: { 'content-length': '9999999' } } : undefined);
    const service = new OAuthService(config, store, async () => response);
    const flow = service.begin();
    await assert.rejects(service.complete('code', flow.state, flow.browserBinding), errorCode('INSTAGRAM_UPSTREAM_ERROR'));
    assert.equal(cancelled, true);
    assert.ok(pulls <= 6);
    assert.equal(store.getConnection(), undefined);
  }
});

test('OAuth permits only one concurrent callback to consume persisted state', async t => {
  const h = harness(); t.after(() => h.store.db.close());
  const flow = h.service.begin();
  const results = await Promise.allSettled([
    h.service.complete('code', flow.state, flow.browserBinding),
    h.service.complete('code', flow.state, flow.browserBinding),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(h.calls.filter(c => c.url.searchParams.has('code')).length, 1);
  const rejected = results.find(r => r.status === 'rejected');
  assert.ok(rejected?.status === 'rejected' && errorCode('INSTAGRAM_OAUTH_STATE_INVALID')(rejected.reason));
});

test('validate rejects a different authorizing user and expired stored data access', async t => {
  const h = harness(); t.after(() => h.store.db.close());
  const connection = await h.run();
  h.store.saveConnection({ ...connection, userId: '999' });
  await assert.rejects(h.service.validate(), errorCode('INSTAGRAM_REAUTH_REQUIRED'));
  h.store.saveConnection({ ...connection, dataAccessExpiresAt: Date.now() - 1 });
  const count = h.calls.length;
  await assert.rejects(h.service.validate(), errorCode('INSTAGRAM_REAUTH_REQUIRED'));
  assert.equal(h.calls.length, count);
});

test('OAuth rejects unsupported scopes and does not accept Instagram Login credentials', t => {
  const store = new Store(':memory:', config.encryptionKey); t.after(() => store.db.close());
  assert.throws(() => new OAuthService({ ...config, product: 'instagram_login' }, store), errorCode('INSTAGRAM_CONFIG_ERROR'));
  assert.throws(() => new OAuthService({ ...config, scopes: [...DEFAULT_SCOPES, 'publish_actions'] }, store), errorCode('INSTAGRAM_CONFIG_ERROR'));
  assert.throws(() => new OAuthService({ ...config, scopes: ['instagram_basic'] }, store), errorCode('INSTAGRAM_CONFIG_ERROR'));
});

test('current deletion, engagement, and direct messaging permissions are opt-in scopes', t => {
  const store = new Store(':memory:', config.encryptionKey); t.after(() => store.db.close());
  const optional = ['instagram_manage_contents', 'instagram_manage_engagement', 'pages_messaging'];
  const defaults = new OAuthService(config, store);
  const defaultScopes = new URL(defaults.begin().url).searchParams.get('scope')!.split(',');
  for (const scope of optional) assert.equal(defaultScopes.includes(scope), false);
  const configured = new OAuthService({ ...config, scopes: [...DEFAULT_SCOPES, ...optional] }, store);
  const requestedScopes = new URL(configured.begin().url).searchParams.get('scope')!.split(',');
  for (const scope of optional) assert.equal(requestedScopes.includes(scope), true);
});
