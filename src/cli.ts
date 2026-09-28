#!/usr/bin/env node
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { userInfo } from 'node:os';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { OAuthService } from './oauth.js';
import { createHttpServer, serveStdio } from './server.js';
import { InstagramError, publicError, required } from './errors.js';
import { secretEquals } from './webhooks.js';
import type { Config } from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function approvalPreview(store: Store, id: string): string {
  required(UUID.test(id), 'INSTAGRAM_APPROVAL_INVALID', 'Use a valid approval request ID.');
  const approval = store.getApproval(id);
  required(approval.status === 'pending' && approval.expiresAt > Date.now(),
    'INSTAGRAM_APPROVAL_INVALID', 'The request is expired or no longer awaiting approval.');
  // JSON quoting neutralizes terminal escape characters in untrusted captions and comments.
  return JSON.stringify({ approval_id: approval.id, account_id: approval.accountId, tool: approval.tool,
    action: approval.input, expires_at: new Date(approval.expiresAt).toISOString() }, null, 2)
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, character => `\\u${character.charCodeAt(0).toString(16)}`);
}

export async function approveAction(store: Store, id: string): Promise<void> {
  required(process.stdin.isTTY && process.stderr.isTTY, 'INSTAGRAM_APPROVAL_REQUIRED',
    'Human approval requires an interactive operator terminal. Piped input is not accepted.');
  process.stderr.write(`Review the exact account, operation and content before approving:\n${approvalPreview(store, id)}\n`);
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await prompt.question(`Type APPROVE ${id} to authorize this exact action once: `);
    required(answer === `APPROVE ${id}`, 'INSTAGRAM_APPROVAL_REQUIRED', 'Approval was cancelled.');
    store.approve(id, `operator:${userInfo().username}`);
    process.stderr.write('Approved. Retry the same MCP call with this approval_id to execute it.\n');
  } finally { prompt.close(); }
}

export interface ConnectServer {
  server: Server;
  startUrl: string;
  completion: Promise<void>;
  cancel: () => void;
}

/** Browser binding is established by a one-use local ticket before the provider redirect. */
export function createConnectServer(config: Config, oauth: Pick<OAuthService, 'begin' | 'complete'>): ConnectServer {
  const redirect = new URL(config.redirectUri);
  required(redirect.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname)
    && !redirect.username && !redirect.password && !redirect.search && !redirect.hash && redirect.pathname !== '/connect',
  'INSTAGRAM_CONFIG_ERROR', 'The operator connect command requires an HTTP loopback callback URL with a dedicated callback path.');
  const ticket = randomBytes(32).toString('base64url');
  let ticketUsed = false, callbackStarted = false, settled = false;
  let browserSession: { state: string; binding: string } | undefined;
  let resolveCompletion: () => void = () => undefined;
  let rejectCompletion: (error: unknown) => void = () => undefined;
  const completion = new Promise<void>((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; });
  const finish = (error?: unknown) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) rejectCompletion(error); else resolveCompletion();
  };
  const timer = setTimeout(() => finish(new InstagramError('INSTAGRAM_OAUTH_TIMEOUT', 'Authorization timed out. Run connect again.')), 10 * 60_000);
  timer.unref();
  const server = createServer((request, response) => {
    void (async () => {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      try {
        required(request.method === 'GET' && request.headers.host === redirect.host
          && (!request.headers.origin || request.headers.origin === redirect.origin),
        'INSTAGRAM_OAUTH_STATE_INVALID', 'Invalid local authorization request.');
        const url = new URL(request.url ?? '/', redirect.origin);
        if (url.pathname === '/connect') {
          const supplied = url.searchParams.get('ticket');
          required(!ticketUsed && supplied && secretEquals(supplied, ticket),
            'INSTAGRAM_OAUTH_STATE_INVALID', 'This connection link is invalid or already used. Run connect again.');
          ticketUsed = true;
          const session = oauth.begin();
          browserSession = { state: session.state, binding: session.browserBinding };
          response.setHeader('Set-Cookie', `fp_instagram_oauth=${session.browserBinding}; HttpOnly; SameSite=Lax; Path=${redirect.pathname}; Max-Age=600`);
          response.writeHead(302, { Location: session.url });
          response.end();
          return;
        }
        if (url.pathname !== redirect.pathname) { response.writeHead(404); response.end('Not found.'); return; }
        const cookies = (request.headers.cookie ?? '').split(';').map(value => value.trim());
        const bindings = cookies.filter(value => value.startsWith('fp_instagram_oauth='));
        required(ticketUsed && !callbackStarted && !settled && bindings.length === 1,
          'INSTAGRAM_OAUTH_STATE_INVALID', 'Authorization browser session is missing or already used.');
        const binding = bindings[0]!.slice('fp_instagram_oauth='.length);
        const code = url.searchParams.get('code'), state = url.searchParams.get('state');
        required(browserSession && state && url.searchParams.getAll('state').length === 1
          && secretEquals(state, browserSession.state) && secretEquals(binding, browserSession.binding),
        'INSTAGRAM_OAUTH_STATE_INVALID', 'The authorization browser session is invalid.');
        if (url.searchParams.has('error')) {
          required(url.searchParams.getAll('error').length === 1 && !url.searchParams.has('code'),
            'INSTAGRAM_OAUTH_STATE_INVALID', 'The authorization response is ambiguous.');
          callbackStarted = true;
          response.setHeader('Set-Cookie', `fp_instagram_oauth=; HttpOnly; SameSite=Lax; Path=${redirect.pathname}; Max-Age=0`);
          response.writeHead(200);
          response.end('Instagram authorization was cancelled or declined. Return to the terminal and run connect again when ready.');
          finish(new InstagramError('INSTAGRAM_OAUTH_CANCELLED', 'Meta authorization was cancelled or declined. Run connect again when ready.'));
          return;
        }
        required(code && url.searchParams.getAll('code').length === 1,
          'INSTAGRAM_OAUTH_STATE_INVALID', 'Authorization was not completed. Run connect again.');
        callbackStarted = true;
        try {
          await oauth.complete(code, state, binding);
          response.setHeader('Set-Cookie', `fp_instagram_oauth=; HttpOnly; SameSite=Lax; Path=${redirect.pathname}; Max-Age=0`);
          response.writeHead(200);
          response.end('Instagram connected. You may close this window and return to the terminal.');
          finish();
        } catch (error) {
          response.writeHead(400);
          response.end('Instagram connection failed. Return to the terminal and run connect again.');
          finish(error);
        }
      } catch {
        response.writeHead(400);
        response.end('Invalid authorization request. Return to the terminal and run connect again.');
      }
    })();
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.on('error', error => finish(error));
  return { server, startUrl: `${redirect.origin}/connect?ticket=${ticket}`, completion,
    cancel: () => finish(new InstagramError('INSTAGRAM_OAUTH_CANCELLED', 'Authorization was cancelled.')) };
}

export async function runCli(args = process.argv.slice(2)): Promise<void> {
  const command = args[0] ?? 'serve';
  if (command === 'keygen') { process.stdout.write(`${randomBytes(32).toString('hex')}\n`); return; }
  if (command === '--help' || command === 'help') {
    process.stdout.write('FurlPay Instagram MCP\nCommands: serve | http | connect | approve <approval-id> | status | disconnect | keygen\n');
    return;
  }
  required(['serve', 'http', 'connect', 'approve', 'status', 'disconnect'].includes(command),
    'INSTAGRAM_COMMAND_INVALID', 'Unknown command. Run with --help for usage.');
  if (existsSync('.env')) process.loadEnvFile('.env');
  const config = loadConfig();
  const store = new Store(config.databasePath, config.encryptionKey);
  let keepOpen = false;
  try {
    if (command === 'approve') { await approveAction(store, args[1] ?? ''); return; }
    const oauth = new OAuthService(config, store);
    if (command === 'connect') {
      const flow = createConnectServer(config, oauth), redirect = new URL(config.redirectUri);
      flow.server.listen(Number(redirect.port || 80), redirect.hostname.replace(/^\[|\]$/g, ''));
      flow.server.once('listening', () => process.stderr.write(`Open this one-use link in your browser:\n${flow.startUrl}\n`));
      const cancel = () => flow.cancel();
      process.once('SIGINT', cancel);
      process.once('SIGTERM', cancel);
      try { await flow.completion; process.stderr.write('Instagram connected. Run status to validate the connection.\n'); }
      finally {
        process.off('SIGINT', cancel);
        process.off('SIGTERM', cancel);
        const timeout = setTimeout(() => flow.server.closeAllConnections(), 5000);
        timeout.unref();
        await new Promise<void>(resolve => flow.server.close(() => resolve()));
        clearTimeout(timeout);
      }
      return;
    }
    if (command === 'status') {
      if (!store.getConnection()) { process.stdout.write('{"connected":false}\n'); return; }
      const connection = await oauth.validate();
      process.stdout.write(`${JSON.stringify({ connected: true, account_id: connection.accountId, username: connection.username,
        account_type: connection.accountType, product: connection.product, permissions: connection.permissions,
        connected_at: new Date(connection.connectedAt).toISOString(), expires_at: connection.expiresAt ? new Date(connection.expiresAt).toISOString() : null,
        last_validated_at: connection.lastValidatedAt ? new Date(connection.lastValidatedAt).toISOString() : null }, null, 2)}\n`);
      return;
    }
    if (command === 'disconnect') {
      oauth.disconnect();
      process.stderr.write('Local connection removed and pending approvals revoked. To revoke Meta app permissions, remove the app in Facebook Settings > Business Integrations.\n');
      return;
    }
    const closeable = command === 'http' ? createHttpServer(config, store) : await serveStdio(config, store);
    if (command === 'http') {
      const http = closeable as Server;
      await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(config.httpPort, config.httpHost, resolve); });
      process.stderr.write(`FurlPay Instagram MCP listening on ${config.httpHost}:${config.httpPort}.\n`);
    }
    keepOpen = true;
    let shuttingDown = false;
    const shutdown = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      if (command === 'http') {
        const http = closeable as Server;
        http.close(() => { store.close(); });
        setTimeout(() => http.closeAllConnections(), 5000).unref();
      } else void Promise.resolve(closeable.close()).finally(() => store.close());
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    if (command === 'serve') process.stdin.once('end', shutdown);
  } finally { if (!keepOpen) store.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runCli().catch(error => {
    process.stderr.write(`${JSON.stringify(publicError(error, randomUUID()))}\n`);
    process.exitCode = 1;
  });
}
