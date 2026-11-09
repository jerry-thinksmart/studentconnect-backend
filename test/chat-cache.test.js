import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.CHAT_CACHE_PATH = ':memory:';
process.env.DATABASE_URL = 'postgres://unused@127.0.0.1:1/unused';

const { pool } = await import('../src/db.js');
const { chatCache } = await import('../src/services/chatCache.js');
const chat = await import('../src/services/chatSync.js');

const CONVERSATION = '11111111-1111-4111-8111-111111111111';
const ALICE = '22222222-2222-4222-8222-222222222222';
const STRANGER = '33333333-3333-4333-8333-333333333333';

// Minimal in-memory stand-in for the PostgreSQL queries chatSync issues.
const remote = { online: true, messages: [], members: new Set([`${CONVERSATION}:${ALICE}`]) };
pool.query = async (sql, params = []) => {
  if (!remote.online) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  if (/^SELECT 1$/.test(sql.trim())) return { rows: [{ '?column?': 1 }] };
  if (sql.includes('FROM messages m JOIN users')) {
    const [conversationId, userId] = params;
    if (!remote.members.has(`${conversationId}:${userId}`)) return { rows: [] };
    return { rows: remote.messages.filter((m) => m.conversationId === conversationId).map((m) => ({ ...m, senderName: 'Alice' })) };
  }
  if (sql.includes('INSERT INTO messages')) {
    const [id, conversationId, senderId, body, mediaUrl, createdAt] = params;
    if (!remote.members.has(`${conversationId}:${senderId}`)) return { rows: [] };
    if (remote.messages.some((m) => m.id === id)) return { rows: [] };
    const row = { id, conversationId, senderId, body, mediaUrl, createdAt: new Date(createdAt ?? Date.now()) };
    remote.messages.push(row);
    return { rows: [row] };
  }
  if (sql.includes('FROM messages WHERE id=$1')) {
    return { rows: remote.messages.filter((m) => m.id === params[0] && m.senderId === params[1]) };
  }
  if (sql.startsWith('UPDATE conversations')) return { rows: [] };
  throw new Error(`Unexpected query: ${sql}`);
};

test('online send is written to PostgreSQL and cached', async () => {
  const { message, queued } = await chat.sendMessage(CONVERSATION, { id: ALICE }, { body: 'hello' });
  assert.equal(queued, false);
  assert.equal(remote.messages.length, 1);
  assert.equal(chatCache.messages(CONVERSATION)[0].id, message.id);
});

test('reads fall back to the cache and sends queue while PostgreSQL is down', async () => {
  remote.online = false;
  const sent = await chat.sendMessage(CONVERSATION, { id: ALICE }, { body: 'offline hello' });
  assert.equal(sent.queued, true);
  assert.equal(sent.message.pending, true);

  const read = await chat.listMessages(CONVERSATION, ALICE);
  assert.equal(read.source, 'cache');
  assert.deepEqual(read.messages.map((m) => m.body), ['hello', 'offline hello']);
  assert.equal(chat.chatStatus().database, 'down');
  assert.equal(chat.chatStatus().queued, 1);
});

test('non-members are refused while offline', async () => {
  await assert.rejects(chat.listMessages(CONVERSATION, STRANGER), { status: 503 });
  await assert.rejects(chat.sendMessage(CONVERSATION, { id: STRANGER }, { body: 'x' }), { status: 503 });
});

test('queued messages are delivered once PostgreSQL returns, without duplicates', async () => {
  remote.online = true;
  chat.startChatSync();
  await new Promise((resolve) => setTimeout(resolve, 50));
  chat.stopChatSync();

  assert.deepEqual(remote.messages.map((m) => m.body), ['hello', 'offline hello']);
  assert.equal(chat.chatStatus().queued, 0);

  const read = await chat.listMessages(CONVERSATION, ALICE);
  assert.equal(read.source, 'database');
  assert.equal(read.messages.filter((m) => m.pending).length, 0);
  assert.equal(read.messages.length, 2);
});

test('retrying a client message id does not duplicate it', async () => {
  const clientMessageId = '44444444-4444-4444-8444-444444444444';
  await chat.sendMessage(CONVERSATION, { id: ALICE }, { body: 'once', clientMessageId });
  const retry = await chat.sendMessage(CONVERSATION, { id: ALICE }, { body: 'once', clientMessageId });
  assert.equal(retry.queued, false);
  assert.equal(remote.messages.filter((m) => m.id === clientMessageId).length, 1);
});

test('non-members get 403 online', async () => {
  await assert.rejects(chat.sendMessage(CONVERSATION, { id: STRANGER }, { body: 'x' }), { status: 403 });
});
