import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';

// sync_state: 0 = confirmed in PostgreSQL, 1 = queued for upload, 2 = rejected by PostgreSQL.
export const SYNC = Object.freeze({ synced: 0, queued: 1, rejected: 2 });

const MESSAGES_KEPT_PER_CONVERSATION = 500;

let db;

function open() {
  if (db) return db;
  if (config.chatCachePath !== ':memory:') mkdirSync(dirname(config.chatCachePath), { recursive: true });
  db = new DatabaseSync(config.chatCachePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      sender_name TEXT,
      body TEXT NOT NULL,
      media_url TEXT,
      created_at TEXT NOT NULL,
      sync_state INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS messages_by_sync_state ON messages(sync_state, created_at);
    CREATE TABLE IF NOT EXISTS members (
      conversation_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      PRIMARY KEY (conversation_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS user_names (
      user_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL
    );
  `);
  return db;
}

function transaction(work) {
  const database = open();
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = work(database);
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

const toApi = (row) => ({
  id: row.id,
  conversationId: row.conversation_id,
  senderId: row.sender_id,
  senderName: row.sender_name,
  body: row.body,
  mediaUrl: row.media_url,
  createdAt: row.created_at,
  pending: row.sync_state === SYNC.queued,
});

export const chatCache = {
  init: open,

  close() {
    db?.close();
    db = undefined;
  },

  isMember: (conversationId, userId) =>
    Boolean(open().prepare('SELECT 1 FROM members WHERE conversation_id=? AND user_id=?').get(conversationId, userId)),

  rememberMember(conversationId, userId) {
    open().prepare('INSERT OR IGNORE INTO members (conversation_id, user_id) VALUES (?, ?)').run(conversationId, userId);
  },

  forgetMember(conversationId, userId) {
    open().prepare('DELETE FROM members WHERE conversation_id=? AND user_id=?').run(conversationId, userId);
  },

  rememberUserName(userId, displayName) {
    if (!displayName) return;
    open()
      .prepare(
        `INSERT INTO user_names (user_id, display_name) VALUES (?, ?)
         ON CONFLICT(user_id) DO UPDATE SET display_name=excluded.display_name`,
      )
      .run(userId, displayName);
  },

  userName: (userId) => open().prepare('SELECT display_name FROM user_names WHERE user_id=?').get(userId)?.display_name ?? null,

  // Write-through of rows read from PostgreSQL. Never downgrades a queued row to a stale copy.
  storeSynced(conversationId, messages) {
    transaction((database) => {
      const upsert = database.prepare(
        `INSERT INTO messages (id, conversation_id, sender_id, sender_name, body, media_url, created_at, sync_state, attempts, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, NULL)
         ON CONFLICT(id) DO UPDATE SET sender_name=excluded.sender_name, body=excluded.body,
           media_url=excluded.media_url, created_at=excluded.created_at, sync_state=0, attempts=0, last_error=NULL`,
      );
      for (const message of messages) {
        upsert.run(
          String(message.id),
          conversationId,
          String(message.senderId),
          message.senderName ?? null,
          message.body,
          message.mediaUrl ?? null,
          new Date(message.createdAt).toISOString(),
        );
        if (message.senderName) {
          database
            .prepare(
              `INSERT INTO user_names (user_id, display_name) VALUES (?, ?)
               ON CONFLICT(user_id) DO UPDATE SET display_name=excluded.display_name`,
            )
            .run(String(message.senderId), message.senderName);
        }
      }
      database
        .prepare(
          `DELETE FROM messages WHERE conversation_id=? AND sync_state=0 AND id NOT IN (
             SELECT id FROM messages WHERE conversation_id=? AND sync_state=0 ORDER BY created_at DESC LIMIT ?)`,
        )
        .run(conversationId, conversationId, MESSAGES_KEPT_PER_CONVERSATION);
    });
  },

  // Rows for one conversation, oldest first, including messages still waiting to reach PostgreSQL.
  messages(conversationId) {
    return open()
      .prepare(
        `SELECT * FROM messages WHERE conversation_id=? AND sync_state IN (0, 1) ORDER BY created_at, id`,
      )
      .all(conversationId)
      .map(toApi);
  },

  queue({ id, conversationId, senderId, senderName, body, mediaUrl, createdAt }) {
    open()
      .prepare(
        `INSERT OR IGNORE INTO messages (id, conversation_id, sender_id, sender_name, body, media_url, created_at, sync_state)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(id, conversationId, senderId, senderName ?? null, body, mediaUrl ?? null, createdAt);
    return toApi(open().prepare('SELECT * FROM messages WHERE id=?').get(id));
  },

  queued: (limit = 100) =>
    open().prepare('SELECT * FROM messages WHERE sync_state=1 ORDER BY created_at, id LIMIT ?').all(limit),

  markSynced(id, createdAt) {
    open().prepare('UPDATE messages SET sync_state=0, attempts=0, last_error=NULL, created_at=? WHERE id=?').run(createdAt, id);
  },

  markRejected(id, reason) {
    open().prepare('UPDATE messages SET sync_state=2, last_error=? WHERE id=?').run(String(reason).slice(0, 500), id);
  },

  recordFailure(id, reason, maxAttempts) {
    open()
      .prepare(
        `UPDATE messages SET attempts=attempts+1, last_error=?,
           sync_state=CASE WHEN attempts+1 >= ? THEN 2 ELSE 1 END WHERE id=?`,
      )
      .run(String(reason).slice(0, 500), maxAttempts, id);
  },

  stats() {
    const counts = open()
      .prepare('SELECT sync_state AS state, COUNT(*) AS total FROM messages GROUP BY sync_state')
      .all();
    const byState = Object.fromEntries(counts.map((row) => [row.state, row.total]));
    return {
      cachedMessages: (byState[SYNC.synced] ?? 0) + (byState[SYNC.queued] ?? 0) + (byState[SYNC.rejected] ?? 0),
      queued: byState[SYNC.queued] ?? 0,
      rejected: byState[SYNC.rejected] ?? 0,
    };
  },
};
