import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { Config } from './types.js';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = z.object({
    INSTAGRAM_API_PRODUCT: z.literal('facebook_login').default('facebook_login'),
    META_GRAPH_API_VERSION: z.literal('v26.0').default('v26.0'),
    META_APP_ID: z.string().regex(/^\d+$/),
    META_APP_SECRET: z.string().min(16),
    TOKEN_ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
    INSTAGRAM_REDIRECT_URI: z.string().url().default('http://localhost:8787/oauth/callback'),
    FACEBOOK_LOGIN_CONFIG_ID: z.string().regex(/^\d+$/).optional(),
    INSTAGRAM_HUMAN_SUPPORT_URL: z.string().url().startsWith('https://').optional(),
    MCP_HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(8788),
  }).safeParse(env);
  if (!parsed.success) throw new Error(`Invalid configuration: ${parsed.error.issues.map(i => i.path.join('.')).join(', ')}. See .env.example.`);
  const e = parsed.data;
  return {
    product: e.INSTAGRAM_API_PRODUCT, apiVersion: e.META_GRAPH_API_VERSION,
    appId: e.META_APP_ID, appSecret: e.META_APP_SECRET,
    encryptionKey: Buffer.from(e.TOKEN_ENCRYPTION_KEY, 'hex'),
    databasePath: resolve(env.INSTAGRAM_DATABASE_PATH ?? join(homedir(), '.furlpay-instagram', 'state.sqlite')),
    redirectUri: e.INSTAGRAM_REDIRECT_URI, facebookPageId: env.FACEBOOK_PAGE_ID,
    facebookLoginConfigId: e.FACEBOOK_LOGIN_CONFIG_ID,
    scopes: env.INSTAGRAM_SCOPES?.split(',').map(s => s.trim()).filter(Boolean),
    httpHost: env.MCP_HTTP_HOST ?? '127.0.0.1', httpPort: e.MCP_HTTP_PORT,
    httpBearerToken: env.MCP_HTTP_BEARER_TOKEN, allowedOrigin: env.MCP_ALLOWED_ORIGIN,
    webhookVerifyToken: env.META_WEBHOOK_VERIFY_TOKEN,
    humanSupportUrl: e.INSTAGRAM_HUMAN_SUPPORT_URL,
  };
}
