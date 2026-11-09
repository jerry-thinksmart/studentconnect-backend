import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

process.env.CHAT_CACHE_PATH = ':memory:';
process.env.DATABASE_URL = 'postgres://unused@127.0.0.1:1/unused';
process.env.JWT_SECRET = 'test-secret';

const { default: jwt } = await import('jsonwebtoken');
const { pool } = await import('../src/db.js');
const { app } = await import('../src/app.js');
const content = await import('../src/services/communityContent.js');

const COMMUNITY = '11111111-1111-4111-8111-111111111111';
const ADMIN = '22222222-2222-4222-8222-222222222222';
const MEMBER = '33333333-3333-4333-8333-333333333333';
const OUTSIDER = '44444444-4444-4444-8444-444444444444';
const ROLES = { [ADMIN]: 'admin', [MEMBER]: 'member' };

const db = { resources: [], quizzes: [] };
let nextId = 1;
const id = () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(nextId++).padStart(12, '0')}`;

// Minimal in-memory stand-in for the PostgreSQL queries the community content routes issue.
pool.query = async (sql, params = []) => {
  if (sql.includes('FROM community_members')) {
    const role = ROLES[params[1]];
    return { rows: role ? [{ role }] : [] };
  }
  if (sql.startsWith('DELETE FROM community_resources')) {
    const [resourceId, , userId, isAdmin] = params;
    const index = db.resources.findIndex((r) => r.id === resourceId && (isAdmin || r.uploadedBy === userId));
    if (index === -1) return { rows: [] };
    db.resources.splice(index, 1);
    return { rows: [{ id: resourceId }] };
  }
  if (sql.startsWith('DELETE FROM community_quizzes')) {
    const index = db.quizzes.findIndex((q) => q.id === params[0]);
    if (index === -1) return { rows: [] };
    db.quizzes.splice(index, 1);
    return { rows: [{ id: params[0] }] };
  }
  if (sql.startsWith('INSERT INTO community_resources')) {
    const [communityId, uploadedBy, title, fileName, contentType, sizeBytes, data] = params;
    const row = { id: id(), communityId, uploadedBy, title, fileName, contentType, sizeBytes, data, createdAt: new Date() };
    db.resources.push(row);
    return { rows: [{ id: row.id }] };
  }
  if (sql.includes('FROM community_resources r JOIN users u')) {
    const view = (r) => ({ ...r, uploaderName: 'Someone', data: undefined });
    if (sql.includes('WHERE r.id=$1')) return { rows: db.resources.filter((r) => r.id === params[0]).map(view) };
    return { rows: db.resources.map(view) };
  }
  if (sql.includes('FROM community_resources WHERE id=$1')) {
    const found = db.resources.find((r) => r.id === params[0]);
    return { rows: found ? [{ file_name: found.fileName, content_type: found.contentType, data: found.data }] : [] };
  }
  if (sql.startsWith('INSERT INTO community_quizzes')) {
    const [, , title, instructions, startsAt, durationMinutes, testUrl] = params;
    const row = { id: id(), title, instructions, startsAt, durationMinutes, testUrl, createdAt: new Date() };
    db.quizzes.push(row);
    return { rows: [row] };
  }
  if (sql.includes('FROM community_quizzes')) return { rows: db.quizzes };
  throw new Error(`Unexpected query: ${sql}`);
};

let server;
let baseUrl;
before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/v1/communities/${COMMUNITY}`;
});
after(() => server.close());

const call = (path, { as, method = 'GET', body } = {}) => fetch(`${baseUrl}${path}`, {
  method,
  headers: {
    'Content-Type': 'application/json',
    ...(as ? { Authorization: `Bearer ${jwt.sign({ sub: as }, 'test-secret')}` } : {}),
  },
  body: body ? JSON.stringify(body) : undefined,
});

const PDF = Buffer.from('%PDF-1.4\n%fake\n');
const upload = (as, overrides = {}) => call('/resources', {
  as,
  method: 'POST',
  body: { title: 'Notes', fileName: 'notes.pdf', dataBase64: PDF.toString('base64'), ...overrides },
});

const minutesFromNow = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();

test('resources require authentication and approved membership', async () => {
  assert.equal((await call('/resources')).status, 401);
  assert.equal((await call('/resources', { as: OUTSIDER })).status, 403);
  assert.equal((await upload(OUTSIDER)).status, 403);
});

test('any member can share a file and every member can see and download it', async () => {
  const created = await upload(MEMBER);
  assert.equal(created.status, 201);
  const { resource } = await created.json();
  assert.equal(resource.contentType, 'application/pdf');
  assert.equal(resource.isMine, true);

  const listed = await (await call('/resources', { as: ADMIN })).json();
  assert.equal(listed.resources.length, 1);
  assert.equal(listed.resources[0].isMine, false);
  assert.equal(listed.resources[0].canDelete, true);

  const file = await call(`/resources/${resource.id}/file`, { as: ADMIN });
  assert.equal(file.status, 200);
  assert.match(file.headers.get('content-disposition'), /^attachment;/);
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), PDF);
  assert.equal((await call(`/resources/${resource.id}/file`, { as: OUTSIDER })).status, 403);
});

test('uploads are validated by type, content and size', async () => {
  const notPdf = await upload(MEMBER, { dataBase64: Buffer.from('hello').toString('base64') });
  assert.equal(notPdf.status, 400);
  assert.equal((await upload(MEMBER, { fileName: 'run.exe' })).status, 400);
  assert.equal((await upload(MEMBER, { dataBase64: '' })).status, 400);
  assert.equal((await upload(MEMBER, { dataBase64: '***' })).status, 400);
  const huge = Buffer.concat([PDF, Buffer.alloc(content.MAX_RESOURCE_BYTES)]).toString('base64');
  assert.equal((await upload(MEMBER, { dataBase64: huge })).status, 413);
});

test('only the uploader or an admin can delete a resource', async () => {
  const { resource } = await (await upload(MEMBER)).json();
  assert.equal((await call(`/resources/${resource.id}`, { as: OUTSIDER, method: 'DELETE' })).status, 403);

  const others = await (await upload(ADMIN)).json();
  assert.equal((await call(`/resources/${others.resource.id}`, { as: MEMBER, method: 'DELETE' })).status, 404);
  assert.equal((await call(`/resources/${resource.id}`, { as: MEMBER, method: 'DELETE' })).status, 204);
  assert.equal((await call(`/resources/${others.resource.id}`, { as: ADMIN, method: 'DELETE' })).status, 204);
});

test('only admins can schedule a quiz and it is validated', async () => {
  const quiz = { title: 'Midterm', startsAt: minutesFromNow(60), durationMinutes: 45, testUrl: 'https://forms.example.com/t' };
  assert.equal((await call('/quizzes', { as: MEMBER, method: 'POST', body: quiz })).status, 403);
  assert.equal((await call('/quizzes', { as: ADMIN, method: 'POST', body: { ...quiz, durationMinutes: 0 } })).status, 400);
  assert.equal((await call('/quizzes', { as: ADMIN, method: 'POST', body: { ...quiz, testUrl: 'javascript:alert(1)' } })).status, 400);
  assert.equal((await call('/quizzes', { as: ADMIN, method: 'POST', body: { ...quiz, startsAt: minutesFromNow(-120) } })).status, 400);

  const created = await call('/quizzes', { as: ADMIN, method: 'POST', body: quiz });
  assert.equal(created.status, 201);
  const body = await created.json();
  assert.equal(body.quiz.status, 'upcoming');
  assert.equal(body.quiz.cameraRequired, true);
  assert.equal(body.quiz.testUrl, quiz.testUrl);
});

test('members only receive the test link while the quiz is live', async () => {
  db.quizzes.length = 0;
  const base = { title: 'Quiz', instructions: '', durationMinutes: 30, testUrl: 'https://forms.example.com/t', createdAt: new Date() };
  db.quizzes.push(
    { ...base, id: id(), startsAt: new Date(Date.now() + 3_600_000) },
    { ...base, id: id(), startsAt: new Date(Date.now() - 600_000) },
    { ...base, id: id(), startsAt: new Date(Date.now() - 7_200_000) },
  );

  const asMember = await (await call('/quizzes', { as: MEMBER })).json();
  assert.deepEqual(asMember.quizzes.map((q) => [q.status, 'testUrl' in q]), [
    ['upcoming', false],
    ['live', true],
    ['ended', false],
  ]);
  assert.ok(asMember.quizzes.every((q) => q.hasTestUrl));
  assert.ok(asMember.now);

  const asAdmin = await (await call('/quizzes', { as: ADMIN })).json();
  assert.ok(asAdmin.quizzes.every((q) => q.testUrl));
  assert.equal((await call('/quizzes', { as: OUTSIDER })).status, 403);
});

test('only admins can delete a quiz', async () => {
  const quizId = db.quizzes[0].id;
  assert.equal((await call(`/quizzes/${quizId}`, { as: MEMBER, method: 'DELETE' })).status, 403);
  assert.equal((await call(`/quizzes/${quizId}`, { as: ADMIN, method: 'DELETE' })).status, 204);
  assert.equal((await call(`/quizzes/${quizId}`, { as: ADMIN, method: 'DELETE' })).status, 404);
});

test('file names are sanitised and content sniffing rejects renamed files', () => {
  assert.equal(content.sanitizeFileName('../../etc/pass"wd.pdf'), 'passwd.pdf');
  assert.equal(content.inspectResource('x.png', PDF).error?.includes('does not match'), true);
  assert.equal(content.inspectResource('x.txt', Buffer.from([0x68, 0x00])).error?.includes('does not match'), true);
  assert.equal(content.inspectResource('slides.pptx', Buffer.from([0x50, 0x4b, 0x03, 0x04, 1])).contentType.includes('presentationml'), true);
});
