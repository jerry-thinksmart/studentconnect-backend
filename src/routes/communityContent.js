import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { decodeBase64, inspectResource, MAX_TITLE_LENGTH, parseQuiz, presentQuiz } from '../services/communityContent.js';

export const communityContentRouter = Router();
communityContentRouter.use(requireAuth);

const getMembership = async (communityId, userId) => {
  const result = await query(
    `SELECT role FROM community_members WHERE community_id=$1 AND user_id=$2 AND status='approved'`,
    [communityId, userId],
  );
  return result.rows[0] ?? null;
};

// Resolves the caller's approved membership or answers 403 itself.
const requireMember = async (req, res) => {
  const membership = await getMembership(req.params.id, req.auth.sub);
  if (!membership) res.status(403).json({ error: 'Approved membership required' });
  return membership;
};

const requireAdmin = async (req, res) => {
  const membership = await getMembership(req.params.id, req.auth.sub);
  if (membership?.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return null;
  }
  return membership;
};

const resourceColumns = `r.id, r.title, r.file_name AS "fileName", r.content_type AS "contentType",
  r.size_bytes AS "sizeBytes", r.created_at AS "createdAt", r.uploaded_by AS "uploadedBy",
  u.display_name AS "uploaderName"`;

communityContentRouter.get('/:id/resources', async (req, res, next) => {
  try {
    const membership = await requireMember(req, res);
    if (!membership) return;
    const result = await query(
      `SELECT ${resourceColumns} FROM community_resources r JOIN users u ON u.id=r.uploaded_by
       WHERE r.community_id=$1 ORDER BY r.created_at DESC`,
      [req.params.id],
    );
    const isAdmin = membership.role === 'admin';
    res.json({
      resources: result.rows.map(({ uploadedBy, ...resource }) => ({
        ...resource,
        isMine: uploadedBy === req.auth.sub,
        canDelete: isAdmin || uploadedBy === req.auth.sub,
      })),
    });
  } catch (error) { next(error); }
});

communityContentRouter.post('/:id/resources', async (req, res, next) => {
  try {
    if (!await requireMember(req, res)) return;
    const decoded = decodeBase64(req.body.dataBase64);
    if (decoded?.tooLarge) return res.status(413).json({ error: 'File must be 10 MB or smaller' });
    if (!decoded) return res.status(400).json({ error: 'dataBase64 must be a base64 encoded file' });
    const file = inspectResource(req.body.fileName, decoded.data);
    if (file.error) return res.status(400).json({ error: file.error });
    const title = typeof req.body.title === 'string' && req.body.title.trim() ? req.body.title.trim() : file.fileName;
    if (title.length > MAX_TITLE_LENGTH) {
      return res.status(400).json({ error: `title must be ${MAX_TITLE_LENGTH} characters or fewer` });
    }
    const inserted = await query(
      `INSERT INTO community_resources (community_id,uploaded_by,title,file_name,content_type,size_bytes,data)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [req.params.id, req.auth.sub, title, file.fileName, file.contentType, decoded.data.length, decoded.data],
    );
    const result = await query(
      `SELECT ${resourceColumns} FROM community_resources r JOIN users u ON u.id=r.uploaded_by WHERE r.id=$1`,
      [inserted.rows[0].id],
    );
    const { uploadedBy: _uploadedBy, ...resource } = result.rows[0];
    res.status(201).json({ resource: { ...resource, isMine: true, canDelete: true } });
  } catch (error) { next(error); }
});

// Files are only served to approved members and always as a download, never rendered inline.
communityContentRouter.get('/:id/resources/:resourceId/file', async (req, res, next) => {
  try {
    if (!await requireMember(req, res)) return;
    const result = await query(
      `SELECT file_name, content_type, data FROM community_resources WHERE id=$1 AND community_id=$2`,
      [req.params.resourceId, req.params.id],
    );
    const file = result.rows[0];
    if (!file) return res.status(404).json({ error: 'Resource not found' });
    res.set({
      'Content-Type': file.content_type,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.file_name)}`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.send(file.data);
  } catch (error) { next(error); }
});

communityContentRouter.delete('/:id/resources/:resourceId', async (req, res, next) => {
  try {
    const membership = await requireMember(req, res);
    if (!membership) return;
    const result = await query(
      `DELETE FROM community_resources WHERE id=$1 AND community_id=$2 AND ($4 OR uploaded_by=$3) RETURNING id`,
      [req.params.resourceId, req.params.id, req.auth.sub, membership.role === 'admin'],
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Resource not found' });
    res.status(204).end();
  } catch (error) { next(error); }
});

const quizColumns = `id, title, instructions, starts_at AS "startsAt", duration_minutes AS "durationMinutes",
  test_url AS "testUrl", questions, created_at AS "createdAt"`;
const quizListColumns = `q.id, q.title, q.instructions, q.starts_at AS "startsAt", q.duration_minutes AS "durationMinutes",
  q.test_url AS "testUrl", q.questions, q.created_at AS "createdAt",
  a.score AS "attemptScore", a.total AS "attemptTotal"`;

communityContentRouter.get('/:id/quizzes', async (req, res, next) => {
  try {
    const membership = await requireMember(req, res);
    if (!membership) return;
    const result = await query(
      `SELECT ${quizListColumns} FROM community_quizzes q
       LEFT JOIN community_quiz_attempts a ON a.quiz_id=q.id AND a.user_id=$2
       WHERE q.community_id=$1 ORDER BY q.starts_at DESC`,
      [req.params.id, req.auth.sub],
    );
    const now = new Date();
    const isAdmin = membership.role === 'admin';
    // `now` lets the app count down against the server clock instead of the device clock.
    res.json({
      now: now.toISOString(),
      quizzes: result.rows.map((quiz) => presentQuiz(quiz, { isAdmin, now })),
    });
  } catch (error) { next(error); }
});

communityContentRouter.post('/:id/quizzes/:quizId/submit', async (req, res, next) => {
  try {
    if (!await requireMember(req, res)) return;
    const found = await query(
      `SELECT starts_at AS "startsAt", duration_minutes AS "durationMinutes", questions
       FROM community_quizzes WHERE id=$1 AND community_id=$2`,
      [req.params.quizId, req.params.id],
    );
    const quiz = found.rows[0];
    if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
    const now = new Date();
    const startsAt = new Date(quiz.startsAt);
    const endsAt = new Date(startsAt.getTime() + quiz.durationMinutes * 60_000);
    if (now < startsAt || now >= endsAt) return res.status(409).json({ error: 'This quiz is not open for submissions' });
    const questions = quiz.questions ?? [];
    const answers = req.body.answers;
    if (!questions.length) return res.status(409).json({ error: 'This quiz has no in-app questions' });
    if (!Array.isArray(answers) || answers.length !== questions.length || answers.some((answer) => !Number.isInteger(answer) || answer < 0 || answer > 3)) {
      return res.status(400).json({ error: 'Answer every question before submitting' });
    }
    const score = questions.reduce((sum, question, index) => sum + (['A', 'B', 'C', 'D'][answers[index]] === question.correctOption ? 1 : 0), 0);
    const inserted = await query(
      `INSERT INTO community_quiz_attempts (quiz_id,user_id,answers,score,total)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (quiz_id,user_id) DO NOTHING RETURNING score,total,submitted_at AS "submittedAt"`,
      [req.params.quizId, req.auth.sub, JSON.stringify(answers), score, questions.length],
    );
    if (!inserted.rows[0]) return res.status(409).json({ error: 'You have already submitted this quiz' });
    res.status(201).json({ result: inserted.rows[0] });
  } catch (error) { next(error); }
});

communityContentRouter.post('/:id/quizzes', async (req, res, next) => {
  try {
    if (!await requireAdmin(req, res)) return;
    const parsed = parseQuiz(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const { title, instructions, startsAt, durationMinutes, testUrl, questions } = parsed.value;
    const result = await query(
      `INSERT INTO community_quizzes (community_id,created_by,title,instructions,starts_at,duration_minutes,test_url,questions)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${quizColumns}`,
      [req.params.id, req.auth.sub, title, instructions, startsAt, durationMinutes, testUrl, JSON.stringify(questions)],
    );
    res.status(201).json({ quiz: presentQuiz(result.rows[0], { isAdmin: true }) });
  } catch (error) { next(error); }
});

communityContentRouter.patch('/:id/quizzes/:quizId', async (req, res, next) => {
  try {
    if (!await requireAdmin(req, res)) return;
    const existing = await query(
      `SELECT starts_at AS "startsAt" FROM community_quizzes WHERE id=$1 AND community_id=$2`,
      [req.params.quizId, req.params.id],
    );
    if (!existing.rows[0]) return res.status(404).json({ error: 'Quiz not found' });
    if (new Date(existing.rows[0].startsAt) <= new Date()) {
      return res.status(409).json({ error: 'A quiz can only be edited before it opens' });
    }
    const parsed = parseQuiz(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const { title, instructions, startsAt, durationMinutes, testUrl, questions } = parsed.value;
    const result = await query(
      `UPDATE community_quizzes
       SET title=$3,instructions=$4,starts_at=$5,duration_minutes=$6,test_url=$7,questions=$8
       WHERE id=$1 AND community_id=$2 RETURNING ${quizColumns}`,
      [req.params.quizId, req.params.id, title, instructions, startsAt, durationMinutes, testUrl, JSON.stringify(questions)],
    );
    res.json({ quiz: presentQuiz(result.rows[0], { isAdmin: true }) });
  } catch (error) { next(error); }
});

communityContentRouter.delete('/:id/quizzes/:quizId', async (req, res, next) => {
  try {
    if (!await requireAdmin(req, res)) return;
    const result = await query(
      `DELETE FROM community_quizzes WHERE id=$1 AND community_id=$2 RETURNING id`,
      [req.params.quizId, req.params.id],
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Quiz not found' });
    res.status(204).end();
  } catch (error) { next(error); }
});
