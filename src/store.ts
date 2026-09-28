import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AuditEvent, Connection, Data } from './types.js';
import { InstagramError, required } from './errors.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export interface Approval {
  id: string; tool: string; input: Data; accountId: string; status: string;
  createdAt: number; expiresAt: number;
}
export interface Job {
  id: string; tool: string; accountId: string; input: Data;
  status: string; phase: string; data: Data; result?: Data;
}

/** One account per database. Use a local durable volume, never a network filesystem. */
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string, private readonly key: Buffer) {
    required(key.length === 32, 'INSTAGRAM_CONFIG_ERROR', 'The encryption key must contain 32 bytes.');
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS connection (id INTEGER PRIMARY KEY CHECK(id=1), sealed TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, tool TEXT NOT NULL, input TEXT NOT NULL,
        hash TEXT NOT NULL, account_id TEXT NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY REFERENCES approvals(id), tool TEXT NOT NULL,
        account_id TEXT NOT NULL, input TEXT NOT NULL, status TEXT NOT NULL, phase TEXT NOT NULL,
        data TEXT NOT NULL, result TEXT, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, topic TEXT NOT NULL,
        payload TEXT NOT NULL, timestamp INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS events_time ON events(timestamp);
    `);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.pruneEvents();
  }
  seal(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from('furlpay-instagram-v1'));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: ciphertext.toString('base64') });
  }
  unseal<T>(sealed: string): T {
    try {
      const v = JSON.parse(sealed) as {iv:string;tag:string;data:string};
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(v.iv, 'base64'));
      decipher.setAAD(Buffer.from('furlpay-instagram-v1'));
      decipher.setAuthTag(Buffer.from(v.tag, 'base64'));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(v.data, 'base64')), decipher.final()]).toString('utf8')) as T;
    } catch { throw new InstagramError('INSTAGRAM_STORAGE_ERROR', 'Encrypted state cannot be read. Check the configured encryption key.'); }
  }
  getConnection(): Connection | undefined {
    const row = this.db.prepare('SELECT sealed FROM connection WHERE id=1').get();
    return row ? this.unseal<Connection>(String(row.sealed)) : undefined;
  }
  saveConnection(connection: Connection) {
    const prior = this.getConnection();
    if (prior && (prior.accountId !== connection.accountId || prior.appId !== connection.appId || prior.connectedAt !== connection.connectedAt)) {
      this.db.prepare("UPDATE approvals SET status='revoked' WHERE status IN ('pending','approved')").run();
      this.db.prepare("UPDATE jobs SET status='revoked' WHERE status='processing'").run();
    }
    this.db.prepare('INSERT OR REPLACE INTO connection VALUES(1,?)').run(this.seal(connection));
  }
  clearConnection() {
    this.db.exec("BEGIN IMMEDIATE; DELETE FROM connection; UPDATE approvals SET status='revoked' WHERE status IN ('pending','approved'); UPDATE jobs SET status='revoked' WHERE status='processing'; DELETE FROM events; COMMIT;");
  }
  requestApproval(tool: string, input: Data, accountId: string): Approval {
    const hash = digest(input);
    const row = this.db.prepare("SELECT id FROM approvals WHERE tool=? AND hash=? AND account_id=? AND status IN ('pending','approved') AND expires>? ORDER BY created DESC LIMIT 1").get(tool, hash, accountId, Date.now());
    if (row) return this.getApproval(String(row.id));
    const id = randomUUID(), now = Date.now();
    this.db.prepare('INSERT INTO approvals VALUES(?,?,?,?,?,?,?,?)').run(id, tool, this.seal(input), hash, accountId, 'pending', now, now + 15 * 60_000);
    return this.getApproval(id);
  }
  getApproval(id: string): Approval {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id=?').get(id);
    required(row, 'INSTAGRAM_APPROVAL_INVALID', 'Approval request was not found.');
    return { id, tool: String(row.tool), input: this.unseal<Data>(String(row.input)), accountId: String(row.account_id), status: String(row.status), createdAt: Number(row.created), expiresAt: Number(row.expires) };
  }
  approve(id: string, actor: string) {
    const approval = this.getApproval(id);
    const connection = this.getConnection();
    required(connection?.accountId === approval.accountId, 'INSTAGRAM_APPROVAL_INVALID', 'The connected account has changed.');
    const result = this.db.prepare("UPDATE approvals SET status='approved' WHERE id=? AND status='pending' AND expires>?").run(id, Date.now());
    required(result.changes === 1, 'INSTAGRAM_APPROVAL_INVALID', 'Approval is expired or no longer pending.');
    this.audit({ actor, tool: approval.tool, accountId: approval.accountId, operation: 'approve', result: 'approved', requestId: id });
  }
  beginJob(id: string, tool: string, input: Data, accountId: string): Job {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const approval = this.db.prepare('SELECT * FROM approvals WHERE id=?').get(id);
      required(approval && approval.tool === tool && approval.hash === digest(input) && approval.account_id === accountId,
        'INSTAGRAM_APPROVAL_INVALID', 'Approval does not match this exact action and account.');
      const existing = this.getJob(id);
      if (existing) {
        if (existing.status === 'completed') { this.db.exec('COMMIT'); return existing; }
        required(existing.status === 'processing', 'INSTAGRAM_OUTCOME_UNKNOWN', 'This action has already been attempted. Reconcile its outcome before requesting a new approval.');
        this.db.prepare("UPDATE jobs SET status='running',updated=? WHERE id=?").run(Date.now(), id);
      } else {
        required(approval.status === 'approved' && Number(approval.expires) > Date.now(), 'INSTAGRAM_APPROVAL_REQUIRED', 'A human must approve this action in the operator CLI.');
        this.db.prepare("UPDATE approvals SET status='consumed' WHERE id=?").run(id);
        this.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?)').run(id, tool, accountId, this.seal(input), 'running', 'start', this.seal({}), null, Date.now());
      }
      this.db.exec('COMMIT');
      return this.getJob(id)!;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  getJob(id: string): Job | undefined {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
    return row ? { id, tool: String(row.tool), accountId: String(row.account_id), input: this.unseal<Data>(String(row.input)), status: String(row.status), phase: String(row.phase), data: this.unseal<Data>(String(row.data)), result: row.result ? this.unseal<Data>(String(row.result)) : undefined } : undefined;
  }
  updateJob(id: string, status: string, phase: string, data: Data, result?: Data) {
    this.db.prepare('UPDATE jobs SET status=?,phase=?,data=?,result=?,updated=? WHERE id=?').run(status, phase, this.seal(data), result ? this.seal(result) : null, Date.now(), id);
  }
  audit(event: AuditEvent) {
    this.db.prepare('INSERT INTO audit VALUES(?,?,?)').run(randomUUID(), Date.now(), JSON.stringify(event));
  }
  event(id: string, accountId: string, topic: string, payload: Data) {
    this.db.prepare('INSERT OR IGNORE INTO events VALUES(?,?,?,?,?)').run(id, accountId, topic, this.seal(payload), Date.now());
    this.pruneEvents();
  }
  private pruneEvents() { this.db.prepare('DELETE FROM events WHERE timestamp<?').run(Date.now() - 30 * 24 * 60 * 60_000); }
  events(accountId: string, before: number, limit: number, beforeId = '\uffff') {
    this.pruneEvents();
    return this.db.prepare('SELECT * FROM events WHERE account_id=? AND (timestamp<? OR (timestamp=? AND id<?)) ORDER BY timestamp DESC,id DESC LIMIT ?').all(accountId, before, before, beforeId, limit).map(row => ({ id: String(row.id), topic: String(row.topic), timestamp: Number(row.timestamp), payload: this.unseal<Data>(String(row.payload)) }));
  }
  inboundMessageAt(accountId: string, senderId: string, now = Date.now()): number | undefined {
    const rows = this.db.prepare("SELECT payload FROM events WHERE account_id=? AND topic='messages' AND timestamp>? ORDER BY timestamp DESC LIMIT 1000").all(accountId, now-86_400_000);
    let latest = 0;
    for (const row of rows) {
      const value = this.unseal<Data>(String(row.payload));
      if (value.sender_id === senderId && typeof value.timestamp === 'number' && value.timestamp <= now && value.timestamp > now-86_400_000) latest = Math.max(latest,value.timestamp);
    }
    return latest || undefined;
  }
  close() { this.db.close(); }
}
