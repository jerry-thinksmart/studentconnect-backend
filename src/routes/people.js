import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

export const peopleRouter = Router();
peopleRouter.use(requireAuth);

const SCOPES = new Set(['all', 'nearby', 'career']);
const normalized = (column) => `NULLIF(lower(trim(${column})), '')`;

// Case-insensitive substring search must treat % and _ literally.
const likePattern = (text) => `%${text.replace(/[\\%_]/g, '\\$&')}%`;

// Directory of other students. Only public profile fields are exposed (never email or phone).
// Ranking: same city > same career path > same country > everyone else.
peopleRouter.get('/', async (req, res, next) => {
  try {
    const scope = SCOPES.has(req.query.scope) ? req.query.scope : 'all';
    const search = String(req.query.q ?? '').trim().slice(0, 80);
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 30, 1), 50);
    const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);

    const result = await query(
      `WITH me AS (
         SELECT ${normalized('city')} AS city, ${normalized('country')} AS country, ${normalized('career_path')} AS career
         FROM users WHERE id=$1
       ), people AS (
         SELECT u.id, u.display_name, u.username, u.city, u.country, u.career_path, u.institution,
           COALESCE(${normalized('u.city')} = me.city, false) AS same_city,
           COALESCE(${normalized('u.country')} = me.country, false) AS same_country,
           COALESCE(${normalized('u.career_path')} = me.career, false) AS same_career
         FROM users u CROSS JOIN me
         WHERE u.id <> $1
           AND NOT EXISTS (
             SELECT 1 FROM friendships f
             WHERE f.status='blocked'
               AND ((f.requester_id=$1 AND f.addressee_id=u.id) OR (f.requester_id=u.id AND f.addressee_id=$1)))
           AND ($3 = '' OR u.display_name ILIKE $3 ESCAPE '\\' OR u.username ILIKE $3 ESCAPE '\\'
                OR u.city ILIKE $3 ESCAPE '\\' OR u.country ILIKE $3 ESCAPE '\\'
                OR u.career_path ILIKE $3 ESCAPE '\\' OR u.institution ILIKE $3 ESCAPE '\\')
       )
       SELECT p.id, p.display_name AS "displayName", p.username, p.city, p.country,
         p.career_path AS "careerPath", p.institution,
         p.same_city AS "sameCity", p.same_country AS "sameCountry", p.same_career AS "sameCareer",
         (SELECT c.id FROM conversations c
          WHERE NOT c.is_group
            AND EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id=c.id AND m.user_id=$1)
            AND EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id=c.id AND m.user_id=p.id)
            AND (SELECT count(*) FROM conversation_members m WHERE m.conversation_id=c.id) = 2
          ORDER BY c.updated_at DESC LIMIT 1) AS "conversationId"
       FROM people p
       WHERE CASE $2
         WHEN 'nearby' THEN p.same_city OR p.same_country
         WHEN 'career' THEN p.same_career
         ELSE true END
       ORDER BY (p.same_city::int * 4 + p.same_career::int * 3 + p.same_country::int * 2) DESC, p.display_name, p.id
       LIMIT $4 OFFSET $5`,
      [req.auth.sub, scope, search ? likePattern(search) : '', limit, offset],
    );
    res.json({ people: result.rows, hasMore: result.rows.length === limit });
  } catch (error) { next(error); }
});
