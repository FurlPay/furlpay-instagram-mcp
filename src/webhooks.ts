import { createHmac, timingSafeEqual } from 'node:crypto';
import { digest, type Store } from './store.js';
import { InstagramError, required } from './errors.js';
import type { Config, Data } from './types.js';

const idPattern = /^\d{1,40}$/;
const record = (value: unknown): Data | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Data : undefined;
const identifier = (value: unknown): string | undefined => typeof value === 'string' && idPattern.test(value) ? value : undefined;
const shortText = (value: unknown, limit = 2200): string | undefined => typeof value === 'string' ? value.slice(0, limit) : undefined;
const compact = (value: Data): Data => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));

export function secretEquals(left: string, right: string): boolean {
  // Fixed-length hashes avoid leaking either secret's length through timing comparison.
  return timingSafeEqual(createHmac('sha256', 'comparison').update(left).digest(), createHmac('sha256', 'comparison').update(right).digest());
}

export function validWebhookSignature(raw: Buffer, signature: string | undefined, appSecret: string): boolean {
  if (!signature || !/^sha256=[a-fA-F0-9]{64}$/.test(signature)) return false;
  const expected = createHmac('sha256', appSecret).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'));
}

export function webhookChallenge(query: URLSearchParams, config: Config): string {
  const token = query.get('hub.verify_token');
  const challenge = query.get('hub.challenge');
  required(config.webhookVerifyToken && token && secretEquals(token, config.webhookVerifyToken)
    && query.get('hub.mode') === 'subscribe' && challenge && /^\d{1,100}$/.test(challenge),
  'INSTAGRAM_WEBHOOK_FORBIDDEN', 'Webhook verification failed.');
  return challenge;
}

interface NormalizedEvent { topic: string; payload: Data }

/** Only signed, account-bound fields enter the event inbox. Never follow webhook URLs. */
export function receiveWebhook(raw: Buffer, signature: string | undefined, config: Config, store: Store, now = Date.now()): number {
  required(validWebhookSignature(raw, signature, config.appSecret), 'INSTAGRAM_WEBHOOK_FORBIDDEN', 'Webhook signature is invalid.');
  let body: Data | undefined;
  try { body = record(JSON.parse(raw.toString('utf8'))); } catch { /* Return a sanitized validation error below. */ }
  required(body && (body.object === 'instagram' || body.object === 'page') && Array.isArray(body.entry)
    && body.entry.length <= 1000, 'INSTAGRAM_WEBHOOK_INVALID', 'Unsupported webhook body.');
  const connection = store.getConnection();
  required(connection, 'INSTAGRAM_REAUTH_REQUIRED', 'Connect an Instagram account before accepting webhooks.');
  const pageId = connection.pageId ?? config.facebookPageId;
  const boundId = body.object === 'page' ? pageId : connection.accountId;
  const events: NormalizedEvent[] = [];
  for (const rawEntry of body.entry) {
    const entry = record(rawEntry);
    required(entry && boundId && identifier(entry.id) === boundId, 'INSTAGRAM_WEBHOOK_FORBIDDEN', 'Webhook is not for the connected account.');
    if (Array.isArray(entry.changes)) {
      for (const rawChange of entry.changes.slice(0, 1000)) {
        const change = record(rawChange), value = record(change?.value);
        if (!change || !value) continue;
        const topic = String(change.field);
        const from = record(value.from), media = record(value.media);
        let payload: Data;
        if (topic === 'comments' || topic === 'live_comments') {
          if (!identifier(value.id)) continue;
          payload = compact({ comment_id: identifier(value.id), text: shortText(value.text),
            sender_id: identifier(from?.id), username: shortText(from?.username, 100), media_id: identifier(media?.id),
            media_product_type: shortText(media?.media_product_type, 40) });
        } else if (topic === 'mentions') {
          payload = compact({ media_id: identifier(value.media_id), comment_id: identifier(value.comment_id) });
          if (!Object.keys(payload).length) continue;
        } else if (topic === 'story_insights') {
          // Retain only identity. Insight metrics must come from the versioned capability map.
          payload = compact({ media_id: identifier(value.media_id) ?? identifier(value.id) });
          if (!Object.keys(payload).length) continue;
        } else continue;
        if (typeof entry.time === 'number' && Number.isFinite(entry.time)) payload.timestamp = entry.time;
        events.push({ topic, payload });
      }
    }
    if (Array.isArray(entry.messaging)) {
      // Page-object messages can be Facebook Messenger traffic. They cannot establish an Instagram reply window.
      if (body.object !== 'instagram') continue;
      for (const rawMessage of entry.messaging.slice(0, 1000)) {
        const event = record(rawMessage), message = record(event?.message);
        const senderId = identifier(record(event?.sender)?.id), recipientId = identifier(record(event?.recipient)?.id);
        const timestamp = event?.timestamp;
        if (!message || message.is_echo || message.is_deleted || !senderId || !recipientId || !message.mid
          || typeof message.mid !== 'string' || message.mid.length > 1024 || typeof timestamp !== 'number'
          || !Number.isSafeInteger(timestamp) || timestamp > now + 5 * 60_000 || timestamp < now - 30 * 24 * 60 * 60_000) continue;
        required(recipientId === connection.accountId,
          'INSTAGRAM_WEBHOOK_FORBIDDEN', 'Message recipient is not the connected account.');
        if (senderId === connection.accountId || senderId === pageId) continue;
        events.push({ topic: 'messages', payload: compact({ sender_id: senderId, recipient_id: recipientId,
          text: shortText(message.text), message_id: message.mid, timestamp }) });
      }
    }
  }
  // Acknowledge only after every event is durably stored. Retried deliveries are deduplicated.
  store.db.exec('BEGIN IMMEDIATE');
  try {
    for (const event of events) {
      const identity = event.topic === 'messages'
        ? { account: connection.accountId, topic: event.topic, message_id: event.payload.message_id }
        : { account: connection.accountId, ...event };
      store.event(digest(identity), connection.accountId, event.topic, event.payload);
    }
    store.db.exec('COMMIT');
  } catch {
    store.db.exec('ROLLBACK');
    throw new InstagramError('INSTAGRAM_STORAGE_ERROR', 'Webhook events could not be stored. Retry delivery.');
  }
  return events.length;
}
