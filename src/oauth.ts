import { createHash, createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { InstagramError, required } from './errors.js';
import type { Store } from './store.js';
import type { Config, Connection, Data, Fetch } from './types.js';

export const BASE_SCOPES = ['instagram_basic', 'pages_show_list', 'pages_read_engagement'] as const;
export const DEFAULT_SCOPES = [...BASE_SCOPES, 'instagram_content_publish', 'instagram_manage_comments', 'instagram_manage_insights'];
const ALLOWED_SCOPES = new Set([...DEFAULT_SCOPES, 'pages_manage_metadata', 'instagram_manage_messages', 'pages_messaging',
  'instagram_manage_contents', 'instagram_manage_engagement', 'ads_read']);
const ID = z.string().regex(/^\d{1,30}$/);
const TokenResponse = z.object({ access_token: z.string().min(1).max(8192), expires_in: z.number().int().positive().optional() });
const DebugResponse = z.object({ data: z.object({
  app_id: z.union([z.string(), z.number()]).transform(String), type: z.literal('USER'),
  is_valid: z.literal(true), user_id: ID, scopes: z.array(z.string()),
  expires_at: z.number().int().nonnegative(), data_access_expires_at: z.number().int().nonnegative().optional(),
  issued_at: z.number().int().nonnegative().optional(),
}) });
const PageResponse = z.object({
  data: z.array(z.object({ id: ID, access_token: z.string().min(1).max(8192).optional() })).max(100),
  paging: z.object({ next: z.string().optional(), cursors: z.object({ after: z.string().max(4096).optional() }).optional() }).optional(),
});
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const oauthError = () => new InstagramError('INSTAGRAM_REAUTH_REQUIRED', 'Instagram authorization is invalid or expired. Run the connect command again.');
const responseError = () => new InstagramError('INSTAGRAM_UPSTREAM_ERROR', 'Meta returned an invalid authorization response. Try connecting again.');

async function readBody(response: Response): Promise<string> {
  const limit = 1_048_576;
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw responseError();
  }
  if (!response.body) throw responseError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw responseError();
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, length).toString('utf8');
}

/** Server-side Facebook Login. Credentials never enter an MCP tool input or result. */
export class OAuthService {
  readonly scopes: string[];
  constructor(private readonly config: Config, private readonly store: Store, private readonly fetcher: Fetch = fetch) {
    required(config.product === 'facebook_login', 'INSTAGRAM_CONFIG_ERROR', 'This server implements Instagram API with Facebook Login.');
    this.scopes = [...new Set(config.scopes ?? DEFAULT_SCOPES)];
    required(BASE_SCOPES.every(s => this.scopes.includes(s)) && this.scopes.every(s => ALLOWED_SCOPES.has(s)),
      'INSTAGRAM_CONFIG_ERROR', 'Configure the documented Facebook Login permissions, including all base permissions.');
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS oauth_states (
      state_hash TEXT PRIMARY KEY, binding_hash TEXT NOT NULL, context_hash TEXT NOT NULL, expires INTEGER NOT NULL
    )`);
  }

  begin(): { url: string; state: string; browserBinding: string } {
    const state = randomBytes(32).toString('base64url');
    const browserBinding = randomBytes(32).toString('base64url');
    this.store.db.prepare('DELETE FROM oauth_states WHERE expires<=?').run(Date.now());
    this.store.db.prepare('INSERT INTO oauth_states VALUES(?,?,?,?)').run(sha256(state), sha256(browserBinding), this.context(), Date.now() + 10 * 60_000);
    const url = new URL(`https://www.facebook.com/${this.config.apiVersion}/dialog/oauth`);
    url.search = new URLSearchParams({ client_id: this.config.appId, redirect_uri: this.config.redirectUri,
      response_type: 'code', state, scope: this.scopes.join(','), auth_type: 'rerequest' }).toString();
    if (this.config.facebookLoginConfigId) url.searchParams.set('config_id', this.config.facebookLoginConfigId);
    return { url: url.toString(), state, browserBinding };
  }

  async complete(code: string, state: string, browserBinding: string): Promise<Connection> {
    required(/^[A-Za-z0-9_-]{43}$/.test(state) && /^[A-Za-z0-9_-]{43}$/.test(browserBinding),
      'INSTAGRAM_OAUTH_STATE_INVALID', 'The authorization session is invalid. Start the connect command again.');
    // Atomic consumption survives restarts and concurrent callbacks. A code is exchanged at most once.
    const consumed = this.store.db.prepare('DELETE FROM oauth_states WHERE state_hash=? AND binding_hash=? AND context_hash=? AND expires>? RETURNING state_hash')
      .get(sha256(state), sha256(browserBinding), this.context(), Date.now());
    required(consumed, 'INSTAGRAM_OAUTH_STATE_INVALID', 'The authorization session is expired or already used. Start the connect command again.');
    required(code.length > 0 && code.length <= 8192 && !/[\u0000-\u001f]/.test(code), 'INSTAGRAM_OAUTH_CODE_INVALID', 'The authorization response was invalid.');
    const short = TokenResponse.safeParse(await this.request('oauth/access_token', {
      client_id: this.config.appId, client_secret: this.config.appSecret, redirect_uri: this.config.redirectUri, code,
    }));
    if (!short.success) throw responseError();
    const long = TokenResponse.safeParse(await this.request('oauth/access_token', {
      client_id: this.config.appId, client_secret: this.config.appSecret,
      grant_type: 'fb_exchange_token', fb_exchange_token: short.data.access_token,
    }));
    if (!long.success) throw responseError();
    const token = long.data.access_token;
    const inspected = await this.inspect(token);
    const page = await this.selectPage(token);
    const linked = z.object({ id: ID, instagram_business_account: z.object({ id: ID }) }).safeParse(
      await this.request(page.id, { fields: 'id,instagram_business_account' }, token));
    required(linked.success && linked.data.id === page.id, 'INSTAGRAM_ACCOUNT_REQUIRED',
      'The selected Facebook Page must be linked to an Instagram Business or Creator account.');
    // The Facebook Login IG User reference does not list account_type. The linked
    // instagram_business_account edge establishes a professional account; never infer its subtype.
    const profile = z.object({ id: ID, username: z.string().min(1).max(100) }).safeParse(
      await this.request(linked.data.instagram_business_account.id, { fields: 'id,username' }, token));
    required(profile.success && profile.data.id === linked.data.instagram_business_account.id, 'INSTAGRAM_ACCOUNT_REQUIRED',
      'Meta did not return the linked Instagram professional account.');
    const now = Date.now();
    const exchangeExpiry = long.data.expires_in ? now + long.data.expires_in * 1000 : null;
    const connection: Connection = {
      product: 'facebook_login', accountId: profile.data.id, username: profile.data.username,
      accessToken: token, pageAccessToken: page.access_token,
      pageId: page.id, userId: inspected.user_id, permissions: inspected.scopes,
      issuedAt: inspected.issued_at ? inspected.issued_at * 1000 : now,
      expiresAt: this.expiry(inspected.expires_at * 1000, inspected.data_access_expires_at ? inspected.data_access_expires_at * 1000 : null, exchangeExpiry),
      dataAccessExpiresAt: inspected.data_access_expires_at ? inspected.data_access_expires_at * 1000 : null,
      connectedAt: now, lastValidatedAt: now, appId: this.config.appId,
    };
    this.store.saveConnection(connection);
    return connection;
  }

  /** Validate the existing server-held token. Facebook user tokens require login again on expiry. */
  async validate(): Promise<Connection> {
    const connection = this.store.getConnection();
    if (!connection || connection.product !== 'facebook_login' || connection.appId !== this.config.appId ||
      (connection.expiresAt !== null && connection.expiresAt <= Date.now()) ||
      (connection.dataAccessExpiresAt && connection.dataAccessExpiresAt <= Date.now())) throw oauthError();
    const inspected = await this.inspect(connection.accessToken, connection.userId);
    const updated: Connection = { ...connection, permissions: inspected.scopes,
      expiresAt: this.expiry(connection.expiresAt, inspected.expires_at * 1000, inspected.data_access_expires_at ? inspected.data_access_expires_at * 1000 : null),
      dataAccessExpiresAt: inspected.data_access_expires_at ? inspected.data_access_expires_at * 1000 : null,
      userId: inspected.user_id, lastValidatedAt: Date.now() };
    this.store.saveConnection(updated);
    return updated;
  }

  /** Local credential removal; provider revocation is a separate explicit operation. */
  disconnect(): void {
    this.store.clearConnection();
    this.store.db.exec('DELETE FROM oauth_states');
  }

  private context(): string { return sha256(`${this.config.appId}\n${this.config.redirectUri}\n${this.scopes.join(',')}\n${this.config.facebookLoginConfigId ?? ''}`); }

  private expiry(...values: (number | null)[]): number | null {
    const positive = values.filter((v): v is number => v !== null && v > 0);
    return positive.length ? Math.min(...positive) : null;
  }

  private async inspect(token: string, expectedUser?: string) {
    const parsed = DebugResponse.safeParse(await this.request('debug_token', { input_token: token }, `${this.config.appId}|${this.config.appSecret}`, false));
    if (!parsed.success) throw oauthError();
    const info = parsed.data.data;
    if (info.app_id !== this.config.appId || (expectedUser && info.user_id !== expectedUser) ||
      info.expires_at * 1000 <= Date.now() || (info.data_access_expires_at && info.data_access_expires_at * 1000 <= Date.now())) throw oauthError();
    required(BASE_SCOPES.every(scope => info.scopes.includes(scope)), 'INSTAGRAM_PERMISSION_REQUIRED',
      'Connect Instagram again and grant the required basic account and Facebook Page permissions.');
    const me = z.object({ id: ID }).safeParse(await this.request('me', { fields: 'id' }, token));
    if (!me.success || me.data.id !== info.user_id) throw oauthError();
    return info;
  }

  private async selectPage(token: string): Promise<{ id: string; access_token?: string }> {
    const pages = new Map<string, { id: string; access_token?: string }>();
    const seen = new Set<string>();
    let after: string | undefined;
    for (let count = 0; count < 10; count++) {
      const query: Record<string, string> = { fields: 'id,access_token', limit: '100' };
      if (after) query.after = after;
      const parsed = PageResponse.safeParse(await this.request('me/accounts', query, token));
      if (!parsed.success) throw responseError();
      for (const page of parsed.data.data) pages.set(page.id, page);
      if (this.config.facebookPageId && pages.has(this.config.facebookPageId)) return pages.get(this.config.facebookPageId)!;
      if (!parsed.data.paging?.next) {
        if (this.config.facebookPageId) throw new InstagramError('INSTAGRAM_ACCOUNT_REQUIRED', 'The configured Facebook Page was not authorized by this login.');
        required(pages.size > 0, 'INSTAGRAM_ACCOUNT_REQUIRED', 'No authorized Facebook Pages were found. Link your Instagram professional account to a Page.');
        required(pages.size === 1, 'INSTAGRAM_PAGE_SELECTION_REQUIRED', 'Multiple Facebook Pages are authorized. Set FACEBOOK_PAGE_ID and connect again.');
        return [...pages.values()][0]!;
      }
      after = parsed.data.paging.cursors?.after;
      if (!after || seen.has(after)) throw responseError();
      seen.add(after);
    }
    throw new InstagramError('INSTAGRAM_PAGE_SELECTION_REQUIRED', 'Facebook Page discovery reached its safety limit. Set FACEBOOK_PAGE_ID to an accessible Page and connect again.');
  }

  private async request(path: string, parameters: Record<string, string>, bearer?: string, proof = true): Promise<Data> {
    const url = new URL(`https://graph.facebook.com/${this.config.apiVersion}/${path}`);
    url.search = new URLSearchParams(parameters).toString();
    if (bearer && proof) url.searchParams.set('appsecret_proof', createHmac('sha256', this.config.appSecret).update(bearer).digest('hex'));
    try {
      // OAuth exchanges are never retried: authorization codes are single use.
      const response = await this.fetcher(url, { method: 'GET', headers: bearer ? { Authorization: `Bearer ${bearer}` } : {}, redirect: 'error', signal: AbortSignal.timeout(15_000) });
      const text = await readBody(response);
      if (response.status === 429) throw new InstagramError('INSTAGRAM_RATE_LIMITED', 'Meta temporarily limited authorization requests. Try connecting later.', undefined, true);
      if (response.status >= 500) throw new InstagramError('INSTAGRAM_UPSTREAM_ERROR', 'Meta authorization is temporarily unavailable. Try connecting again.', undefined, true);
      let body: Data;
      try { body = JSON.parse(text) as Data; } catch { throw responseError(); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw responseError();
      if (!response.ok || body.error) {
        const code = body.error && typeof body.error === 'object' ? (body.error as Data).code : undefined;
        if (code === 4 || code === 17 || code === 32 || code === 613) {
          throw new InstagramError('INSTAGRAM_RATE_LIMITED', 'Meta temporarily limited authorization requests. Try connecting later.', undefined, true);
        }
        if (code === 10 || code === 200) throw new InstagramError('INSTAGRAM_PERMISSION_REQUIRED',
          'Meta denied account access. Check the granted permissions, app access level, and the authorizing user’s Facebook Page role.');
        throw oauthError();
      }
      return body;
    } catch (error) {
      if (error instanceof InstagramError) throw error;
      throw new InstagramError('INSTAGRAM_NETWORK_ERROR', 'Meta authorization could not be reached. Try connecting again.', undefined, true);
    }
  }
}
