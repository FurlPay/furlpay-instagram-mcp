export type Product = 'instagram_login' | 'facebook_login';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Data = Record<string, unknown>;
export interface Connection {
  product: Product;
  accountId: string;
  username?: string;
  accountType?: string;
  accessToken: string;
  pageAccessToken?: string;
  pageId?: string;
  userId?: string;
  dataAccessExpiresAt?: number | null;
  lastValidatedAt?: number;
  permissions: string[];
  issuedAt: number;
  expiresAt: number | null;
  connectedAt: number;
  appId: string;
}
export interface Config {
  product: Product;
  apiVersion: string;
  appId: string;
  appSecret: string;
  encryptionKey: Buffer;
  databasePath: string;
  redirectUri: string;
  facebookPageId?: string;
  facebookLoginConfigId?: string;
  scopes?: string[];
  httpHost: string;
  httpPort: number;
  httpBearerToken?: string;
  allowedOrigin?: string;
  webhookVerifyToken?: string;
  humanSupportUrl?: string;
}
export type Fetch = typeof globalThis.fetch;
export interface AuditEvent {
  actor: string;
  tool: string;
  accountId: string;
  operation: string;
  resourceId?: string;
  result: string;
  requestId: string;
}
