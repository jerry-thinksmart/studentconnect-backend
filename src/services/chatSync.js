import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { query } from '../db.js';
import { chatCache } from './chatCache.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONNECTIVITY_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'CHAT_DB_TIMEOUT',
  '57P01', '57P02', '57P03', '53300', '08000', '08001', '08003', '08004', '08006',
]);

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function isConnectivityError(error) {
  if (!error) return false;
  if (CONNECTIVITY_CODES.has(error.code)) return true;
  if (error instanceof AggregateError) return error.errors.some(isConnectivityError);
  return /timeout exceeded when trying to connect|Connection terminated|Client has encountered a connection error|Cannot use a pool after calling end/i.test(
    error.message ?? '',
  );
}

const state = { databaseUp: true, lastFlushAt: null, lastError: null };

function markDown(error) {
  if (state.databaseUp) console.warn(`PostgreSQL unreachable; chat is running from the SQLite cache (${error?.message ?? error})`);
  state.databaseUp = false;
  state.lastError = error?.message ?? String(error);
}

function markUp() {
  if (!state.databaseUp) console.log('PostgreSQL reachable again; syncing queued chat messages');
  state.databaseUp = true;
  state.lastError = null;
}

function withTimeout(promise, ms = config.chatDbTimeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`PostgreSQL did not answer within ${ms}ms`), { code: 'CHAT_DB_TIMEOUT' })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Runs a PostgreSQL operation. Returns { value } on success, or { offline: true } when the database is unreachable.
async function tryDatabase(operation) {
  if (!state.databaseUp) return { offline: true };
  try {
    const value = await withTimeout(operation());
    return { value };
  } catch (error) {
    if (!isConnectivityError(error)) throw error;
    markDown(error);
    return { offline: true };
  }
}

export const chatStatus = () => ({
  database: state.databaseUp ? 'up' : 'down',
  lastError: state.lastError,
  lastFlushAt: state.lastFlushAt,
  ...chatCache.stats(),
});

export async function listMessages(conversationId, userId) {
  const result = await tryDatabase(() =>
    query(
      `SELECT m.id,m.body,m.media_url AS "mediaUrl",m.created_at AS "createdAt",m.sender_id AS "senderId",u.display_name AS "senderName"
       FROM messages m JOIN users u ON u.id=m.sender_id JOIN conversation_members cm ON cm.conversation_id=m.conversation_id
       WHERE m.conversation_id=$1 AND cm.user_id=$2 ORDER BY m.created_at`,
      [conversationId, userId],
    ),
  );

  if (!result.offline) {
    const rows = result.value.rows;
    if (rows.length) {
      chatCache.rememberMember(conversationId, userId);
      chatCache.storeSynced(conversationId, rows);
    }
    // Messages still queued locally are not in PostgreSQL yet; merge them so the sender never sees them vanish.
    const known = new Set(rows.map((row) => String(row.id)));
    const queued = chatCache.messages(conversationId).filter((message) => message.pending && !known.has(message.id));
    return { messages: [...rows.map((row) => ({ ...row, pending: false })), ...queued], source: 'database' };
  }

  if (!chatCache.isMember(conversationId, userId)) {
    throw new HttpError(503, 'Chat is temporarily unavailable. Please try again shortly.');
  }
  return { messages: chatCache.messages(conversationId), source: 'cache' };
}

// Inserts one message idempotently. Returns the stored row, or null when the user is not a conversation member.
async function insertMessage({ id, conversationId, senderId, body, mediaUrl, createdAt }) {
  const inserted = await query(
    `INSERT INTO messages (id,conversation_id,sender_id,body,media_url,created_at)
     SELECT $1,$2,$3,$4,$5,COALESCE($6::timestamptz, now())
     WHERE EXISTS (SELECT 1 FROM conversation_members WHERE conversation_id=$2 AND user_id=$3)
     ON CONFLICT (id) DO NOTHING
     RETURNING id,conversation_id AS "conversationId",sender_id AS "senderId",body,media_url AS "mediaUrl",created_at AS "createdAt"`,
    [id, conversationId, senderId, body, mediaUrl, createdAt ?? null],
  );
  let row = inserted.rows[0];
  if (!row) {
    // Either a retry of an already-stored message, or the sender is not a member.
    const existing = await query(
      `SELECT id,conversation_id AS "conversationId",sender_id AS "senderId",body,media_url AS "mediaUrl",created_at AS "createdAt"
       FROM messages WHERE id=$1 AND sender_id=$2 AND conversation_id=$3`,
      [id, senderId, conversationId],
    );
    row = existing.rows[0];
  }
  if (row) await query('UPDATE conversations SET updated_at=now() WHERE id=$1', [conversationId]);
  return row ?? null;
}

export async function sendMessage(conversationId, user, { body, mediaUrl, clientMessageId }) {
  const message = {
    id: UUID.test(clientMessageId ?? '') ? clientMessageId : randomUUID(),
    conversationId,
    senderId: user.id,
    body,
    mediaUrl: mediaUrl || null,
  };

  const result = await tryDatabase(() => insertMessage(message));
  if (!result.offline) {
    if (!result.value) {
      chatCache.forgetMember(conversationId, user.id);
      throw new HttpError(403, 'Not a conversation member');
    }
    chatCache.rememberMember(conversationId, user.id);
    chatCache.storeSynced(conversationId, [{ ...result.value, senderName: user.name ?? chatCache.userName(user.id) }]);
    return { message: result.value, queued: false };
  }

  // Offline: only members that PostgreSQL confirmed earlier may queue messages.
  if (!chatCache.isMember(conversationId, user.id)) {
    throw new HttpError(503, 'Chat is temporarily unavailable. Please try again shortly.');
  }
  const queued = chatCache.queue({
    ...message,
    senderName: user.name ?? chatCache.userName(user.id),
    createdAt: new Date().toISOString(),
  });
  return { message: queued, queued: true };
}

let flushing = false;

// Uploads queued messages to PostgreSQL in order; stops at the first connectivity failure.
export async function flushQueue() {
  if (flushing) return 0;
  flushing = true;
  let delivered = 0;
  try {
    for (const row of chatCache.queued()) {
      try {
        const stored = await withTimeout(
          insertMessage({
            id: row.id,
            conversationId: row.conversation_id,
            senderId: row.sender_id,
            body: row.body,
            mediaUrl: row.media_url,
            createdAt: row.created_at,
          }),
        );
        if (stored) {
          chatCache.markSynced(row.id, new Date(stored.createdAt).toISOString());
          delivered += 1;
        } else {
          chatCache.markRejected(row.id, 'Sender is not a conversation member');
        }
      } catch (error) {
        if (isConnectivityError(error)) {
          markDown(error);
          break;
        }
        chatCache.recordFailure(row.id, error.message, config.chatMaxSyncAttempts);
      }
    }
    if (delivered) state.lastFlushAt = new Date().toISOString();
  } finally {
    flushing = false;
  }
  return delivered;
}

async function probe() {
  try {
    await withTimeout(query('SELECT 1'));
    markUp();
    await flushQueue();
  } catch (error) {
    if (isConnectivityError(error)) markDown(error);
    else console.error('Chat sync probe failed', error);
  }
}

let timer;

export function startChatSync() {
  chatCache.init();
  if (timer) return;
  timer = setInterval(probe, config.chatSyncIntervalMs);
  timer.unref();
  probe();
}

export function stopChatSync() {
  clearInterval(timer);
  timer = undefined;
}

export const markChatDatabaseDown = markDown;
