import { Router } from 'express';
import { pool, query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError, listMessages, sendMessage } from '../services/chatSync.js';

export const featuresRouter = Router();
featuresRouter.use(requireAuth);

const failRequired = (res, fields) => res.status(400).json({ error: `${fields.join(', ')} required` });

const requireCommunityAdmin = async (communityId, userId) => {
  const result = await query(
    `SELECT 1 FROM community_members
     WHERE community_id=$1 AND user_id=$2 AND status='approved' AND role='admin'`,
    [communityId, userId],
  );
  return Boolean(result.rows[0]);
};

const requireApprovedCommunityMember = async (communityId, userId) => {
  const result = await query(
    `SELECT 1 FROM community_members
     WHERE community_id=$1 AND user_id=$2 AND status='approved'`,
    [communityId, userId],
  );
  return Boolean(result.rows[0]);
};

featuresRouter.get('/communities', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT c.id,c.title,c.topic,c.description,c.approval_required AS "approvalRequired",c.created_at AS "createdAt",
        COALESCE((SELECT count(*)::int FROM community_members all_members WHERE all_members.community_id=c.id AND all_members.status='approved'),0) AS "memberCount",
        COALESCE((SELECT json_agg(json_build_object('id',u.id,'displayName',u.display_name))
          FROM community_members cm JOIN users u ON u.id=cm.user_id
          WHERE cm.community_id=c.id AND cm.status='approved' AND cm.role='admin'),'[]'::json) AS admins,
        current_member.status AS "membershipStatus", current_member.role AS "membershipRole"
       FROM communities c
       LEFT JOIN community_members current_member ON current_member.community_id=c.id AND current_member.user_id=$1
       ORDER BY c.created_at DESC`,
      [req.auth.sub],
    );
    res.json({ communities: result.rows });
  } catch (error) { next(error); }
});

featuresRouter.post('/communities', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { title, topic = '', description = '' } = req.body;
    if (!title?.trim()) return failRequired(res, ['title']);
    await client.query('BEGIN');
    const community = await client.query(
      `INSERT INTO communities (created_by,title,topic,description) VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.auth.sub, title.trim(), topic.trim(), description.trim()],
    );
    await client.query(
      `INSERT INTO community_members (community_id,user_id,role,status) VALUES ($1,$2,'admin','approved')`,
      [community.rows[0].id, req.auth.sub],
    );
    await client.query('COMMIT');
    res.status(201).json({ community: community.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally { client.release(); }
});

featuresRouter.post('/communities/:id/join', async (req, res, next) => {
  try {
    const community = await query(`SELECT approval_required FROM communities WHERE id=$1`, [req.params.id]);
    if (!community.rows[0]) return res.status(404).json({ error: 'Community not found' });
    const status = community.rows[0].approval_required ? 'pending' : 'approved';
    const result = await query(
      `INSERT INTO community_members (community_id,user_id,status) VALUES ($1,$2,$3)
       ON CONFLICT (community_id,user_id) DO UPDATE SET status=CASE WHEN community_members.status='rejected' THEN EXCLUDED.status ELSE community_members.status END, updated_at=now()
       RETURNING status,role`,
      [req.params.id, req.auth.sub, status],
    );
    res.status(201).json({ membership: result.rows[0] });
  } catch (error) { next(error); }
});

featuresRouter.get('/communities/:id/members', async (req, res, next) => {
  try {
    if (!await requireCommunityAdmin(req.params.id, req.auth.sub)) return res.status(403).json({ error: 'Admin access required' });
    const result = await query(
      `SELECT cm.user_id AS "userId",cm.role,cm.status,cm.created_at AS "createdAt",u.display_name AS "displayName",u.username
       FROM community_members cm JOIN users u ON u.id=cm.user_id
       WHERE cm.community_id=$1 ORDER BY CASE cm.status WHEN 'pending' THEN 0 ELSE 1 END, cm.created_at DESC`,
      [req.params.id],
    );
    res.json({ members: result.rows });
  } catch (error) { next(error); }
});

featuresRouter.patch('/communities/:id/members/:userId', async (req, res, next) => {
  try {
    if (!await requireCommunityAdmin(req.params.id, req.auth.sub)) return res.status(403).json({ error: 'Admin access required' });
    const { status, role } = req.body;
    if (status && !['approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'Invalid membership status' });
    if (role && !['admin', 'member'].includes(role)) return res.status(400).json({ error: 'Invalid membership role' });
    if (!status && !role) return failRequired(res, ['status or role']);
    const result = await query(
      `UPDATE community_members SET status=COALESCE($3,status),role=COALESCE($4,role),updated_at=now()
       WHERE community_id=$1 AND user_id=$2 RETURNING user_id AS "userId",status,role`,
      [req.params.id, req.params.userId, status || null, role || null],
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Membership not found' });
    res.json({ membership: result.rows[0] });
  } catch (error) { next(error); }
});

featuresRouter.get('/communities/:id/discussions', async (req, res, next) => {
  try {
    if (!await requireApprovedCommunityMember(req.params.id, req.auth.sub)) return res.status(403).json({ error: 'Approved membership required' });
    const result = await query(
      `SELECT d.id,d.content,d.created_at AS "createdAt",u.id AS "authorId",u.display_name AS "authorName"
       FROM community_discussions d JOIN users u ON u.id=d.author_id
       WHERE d.community_id=$1 ORDER BY d.created_at DESC`, [req.params.id]);
    res.json({ discussions: result.rows });
  } catch (error) { next(error); }
});

featuresRouter.post('/communities/:id/discussions', async (req, res, next) => {
  try {
    if (!await requireApprovedCommunityMember(req.params.id, req.auth.sub)) return res.status(403).json({ error: 'Approved membership required' });
    if (!req.body.content?.trim()) return failRequired(res, ['content']);
    const result = await query(
      `INSERT INTO community_discussions (community_id,author_id,content) VALUES ($1,$2,$3) RETURNING id,content,created_at AS "createdAt"`,
      [req.params.id, req.auth.sub, req.body.content.trim()],
    );
    res.status(201).json({ discussion: result.rows[0] });
  } catch (error) { next(error); }
});

featuresRouter.get('/communities/:id/classes', async (req, res, next) => {
  try {
    if (!await requireApprovedCommunityMember(req.params.id, req.auth.sub)) return res.status(403).json({ error: 'Approved membership required' });
    const result = await query(
      `SELECT id,title,starts_at AS "startsAt",room_name AS "roomName" FROM community_classes
       WHERE community_id=$1 ORDER BY starts_at`, [req.params.id]);
    res.json({ classes: result.rows });
  } catch (error) { next(error); }
});

featuresRouter.post('/communities/:id/classes', async (req, res, next) => {
  try {
    if (!await requireCommunityAdmin(req.params.id, req.auth.sub)) return res.status(403).json({ error: 'Admin access required' });
    const { title, startsAt } = req.body;
    if (!title?.trim() || !startsAt) return failRequired(res, ['title', 'startsAt']);
    const roomName = `studentconnect-${req.params.id.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`;
    const result = await query(
      `INSERT INTO community_classes (community_id,created_by,title,starts_at,room_name)
       VALUES ($1,$2,$3,$4,$5) RETURNING id,title,starts_at AS "startsAt",room_name AS "roomName"`,
      [req.params.id, req.auth.sub, title.trim(), startsAt, roomName]);
    res.status(201).json({ class: result.rows[0] });
  } catch (error) { next(error); }
});

featuresRouter.get('/classes', async (req, res, next) => {
  try {
    const values = [req.auth.sub];
    const conditions = ['c.published = true'];
    if (req.query.category) { values.push(req.query.category); conditions.push(`cat.slug = $${values.length}`); }
    if (req.query.search) { values.push(`%${req.query.search}%`); conditions.push(`c.title ILIKE $${values.length}`); }
    const result = await query(
      `SELECT c.id, c.title, c.description, c.cover_url AS "coverUrl", c.level,
        c.duration_minutes AS "durationMinutes", cat.name AS category,
        u.display_name AS instructor, COALESCE(e.progress_percent, 0) AS "progressPercent",
        (e.user_id IS NOT NULL) AS enrolled
       FROM courses c LEFT JOIN categories cat ON cat.id = c.category_id
       LEFT JOIN users u ON u.id = c.instructor_id
       LEFT JOIN course_enrollments e ON e.course_id = c.id AND e.user_id = $1
       WHERE ${conditions.join(' AND ')} ORDER BY c.created_at DESC`, values);
    res.json({ classes: result.rows });
  } catch (error) { next(error); }
});

featuresRouter.post('/classes', async (req, res, next) => {
  try {
    const { title, description = '', coverUrl, level, durationMinutes = 0, categoryId } = req.body;
    if (!title) return failRequired(res, ['title']);
    const result = await query(
      `INSERT INTO courses (instructor_id, category_id, title, description, cover_url, level, duration_minutes, published)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true) RETURNING *`,
      [req.auth.sub, categoryId || null, title, description, coverUrl || null, level || null, durationMinutes]);
    res.status(201).json({ class: result.rows[0] });
  } catch (error) { next(error); }
});

featuresRouter.post('/classes/:id/enroll', async (req, res, next) => {
  try {
    const result = await query(
      `INSERT INTO course_enrollments (user_id, course_id) VALUES ($1,$2)
       ON CONFLICT (user_id, course_id) DO UPDATE SET updated_at = now() RETURNING *`,
      [req.auth.sub, req.params.id]);
    res.status(201).json({ enrollment: result.rows[0] });
  } catch (error) { next(error); }
});

featuresRouter.patch('/classes/:id/progress', async (req, res, next) => {
  try {
    const result = await query(
      `UPDATE course_enrollments SET progress_percent=$3, updated_at=now()
       WHERE user_id=$1 AND course_id=$2 RETURNING *`,
      [req.auth.sub, req.params.id, req.body.progressPercent]);
    res.json({ enrollment: result.rows[0] });
  } catch (error) { next(error); }
});

const POST_CONTENT_MAX = 2000;
const COMMENT_CONTENT_MAX = 1000;

// Views dominate the score; likes and comments add weight. Dividing by a
// power of the post's age lets fresh posts compete with older popular ones.
const feedSelect = `
  SELECT p.id, p.content, p.media_url AS "mediaUrl", p.visibility, p.created_at AS "createdAt",
    p.view_count AS "viewCount",
    json_build_object('id',u.id,'displayName',u.display_name,'username',u.username) AS author,
    (SELECT count(*)::int FROM post_likes l WHERE l.post_id=p.id) AS "likeCount",
    (SELECT count(*)::int FROM post_comments c WHERE c.post_id=p.id) AS "commentCount",
    EXISTS (SELECT 1 FROM post_likes l WHERE l.post_id=p.id AND l.user_id=$1) AS "likedByMe",
    (p.author_id=$1) AS "isMine",
    (
      p.view_count
      + 3 * (SELECT count(*) FROM post_likes l WHERE l.post_id=p.id)
      + 5 * (SELECT count(*) FROM post_comments c WHERE c.post_id=p.id)
      + 1
    ) / power(extract(epoch FROM (now() - p.created_at)) / 3600 + 2, 1.3) AS score
  FROM posts p JOIN users u ON u.id=p.author_id`;

featuresRouter.get('/feeds', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 100);
    const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
    const result = await query(
      `${feedSelect} WHERE p.visibility='public'
       ORDER BY score DESC, p.created_at DESC LIMIT $2 OFFSET $3`,
      [req.auth.sub, limit, offset]);
    res.json({ posts: result.rows });
  } catch (error) { next(error); }
});

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const detectImageType = (buffer) => {
  if (buffer.length > 12 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length > 12 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length > 12 && buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
};

featuresRouter.get('/feeds/stories', async (_req, res, next) => {
  try {
    const result = await query(
      `SELECT u.id, u.display_name AS "displayName", u.username,
        max(p.created_at) AS "latestAt",
        json_agg(json_build_object('id',p.id,'mediaUrl',p.media_url,'content',p.content,'createdAt',p.created_at)
          ORDER BY p.created_at) AS posts
       FROM posts p JOIN users u ON u.id=p.author_id
       WHERE p.visibility='public' AND p.media_url IS NOT NULL AND p.created_at > now() - interval '24 hours'
       GROUP BY u.id ORDER BY max(p.created_at) DESC LIMIT 30`);
    res.json({ stories: result.rows });
  } catch (error) { next(error); }
});

featuresRouter.post('/feeds', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const content = typeof req.body.content === 'string' ? req.body.content.trim() : '';
    const imageBase64 = typeof req.body.imageBase64 === 'string' ? req.body.imageBase64 : null;
    if (!content && !imageBase64) return failRequired(res, ['content']);
    if (content.length > POST_CONTENT_MAX) {
      return res.status(400).json({ error: `content must be ${POST_CONTENT_MAX} characters or fewer` });
    }
    let image = null;
    if (imageBase64) {
      const data = Buffer.from(imageBase64, 'base64');
      const contentType = detectImageType(data);
      if (!contentType) return res.status(400).json({ error: 'Image must be a JPEG, PNG or WebP file' });
      if (data.length > MAX_IMAGE_BYTES) return res.status(400).json({ error: 'Image must be 5 MB or smaller' });
      image = { data, contentType };
    }

    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO posts (author_id,content,visibility) VALUES ($1,$2,'public') RETURNING id`,
      [req.auth.sub, content]);
    const postId = inserted.rows[0].id;
    if (image) {
      const stored = await client.query(
        `INSERT INTO post_images (post_id,content_type,data) VALUES ($1,$2,$3) RETURNING id`,
        [postId, image.contentType, image.data]);
      await client.query(`UPDATE posts SET media_url=$2 WHERE id=$1`, [postId, `/api/v1/feed-images/${stored.rows[0].id}`]);
    }
    await client.query('COMMIT');
    const result = await query(`${feedSelect} WHERE p.id=$2`, [req.auth.sub, postId]);
    res.status(201).json({ post: result.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally {
    client.release();
  }
});

featuresRouter.delete('/feeds/:id', async (req, res, next) => {
  try {
    const result = await query(`DELETE FROM posts WHERE id=$1 AND author_id=$2 RETURNING id`, [req.params.id, req.auth.sub]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Post not found' });
    res.status(204).end();
  } catch (error) { next(error); }
});

featuresRouter.post('/feeds/:id/view', async (req, res, next) => {
  try {
    // Authors opening their own post do not inflate its reach.
    const result = await query(
      `WITH target AS (
         SELECT id FROM posts WHERE id=$1 AND author_id<>$2 AND visibility='public'
       ), seen AS (
         INSERT INTO post_views (post_id,user_id) SELECT id,$2 FROM target
         ON CONFLICT DO NOTHING RETURNING post_id
       )
       UPDATE posts SET view_count=view_count+1 WHERE id IN (SELECT post_id FROM seen)
       RETURNING view_count AS "viewCount"`,
      [req.params.id, req.auth.sub]);
    res.json({ viewCount: result.rows[0]?.viewCount ?? null });
  } catch (error) { next(error); }
});

featuresRouter.get('/feeds/:id/comments', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT c.id, c.content, c.created_at AS "createdAt",
        json_build_object('id',u.id,'displayName',u.display_name,'username',u.username) AS author
       FROM post_comments c JOIN users u ON u.id=c.author_id
       WHERE c.post_id=$1 ORDER BY c.created_at ASC LIMIT 200`,
      [req.params.id]);
    res.json({ comments: result.rows });
  } catch (error) { next(error); }
});

featuresRouter.post('/feeds/:id/comments', async (req, res, next) => {
  try {
    const content = typeof req.body.content === 'string' ? req.body.content.trim() : '';
    if (!content) return failRequired(res, ['content']);
    if (content.length > COMMENT_CONTENT_MAX) {
      return res.status(400).json({ error: `content must be ${COMMENT_CONTENT_MAX} characters or fewer` });
    }
    const post = await query(`SELECT 1 FROM posts WHERE id=$1 AND visibility='public'`, [req.params.id]);
    if (!post.rows[0]) return res.status(404).json({ error: 'Post not found' });
    const result = await query(
      `WITH inserted AS (
         INSERT INTO post_comments (post_id,author_id,content) VALUES ($1,$2,$3) RETURNING *
       )
       SELECT i.id, i.content, i.created_at AS "createdAt",
         json_build_object('id',u.id,'displayName',u.display_name,'username',u.username) AS author
       FROM inserted i JOIN users u ON u.id=i.author_id`,
      [req.params.id, req.auth.sub, content]);
    res.status(201).json({ comment: result.rows[0] });
  } catch (error) { next(error); }
});

featuresRouter.put('/feeds/:id/like', async (req, res, next) => {
  try {
    await query(
      `INSERT INTO post_likes (post_id,user_id)
       SELECT id,$2 FROM posts WHERE id=$1 AND visibility='public' ON CONFLICT DO NOTHING`,
      [req.params.id, req.auth.sub]);
    res.status(204).end();
  } catch (error) { next(error); }
});
featuresRouter.delete('/feeds/:id/like', async (req, res, next) => {
  try { await query(`DELETE FROM post_likes WHERE post_id=$1 AND user_id=$2`, [req.params.id, req.auth.sub]); res.status(204).end(); }
  catch (error) { next(error); }
});

featuresRouter.get('/scholarships', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT s.id,s.title,s.provider,s.description,s.amount,s.currency,s.country,
        s.application_url AS "applicationUrl",s.cover_url AS "coverUrl",s.deadline,
        cat.name AS category,(ss.user_id IS NOT NULL) AS saved
       FROM scholarships s LEFT JOIN categories cat ON cat.id=s.category_id
       LEFT JOIN saved_scholarships ss ON ss.scholarship_id=s.id AND ss.user_id=$1
       WHERE s.published=true ORDER BY s.deadline NULLS LAST`, [req.auth.sub]);
    res.json({ scholarships: result.rows });
  } catch (error) { next(error); }
});

featuresRouter.post('/scholarships', async (req, res, next) => {
  try {
    const { title, provider, description='', amount, currency, country, applicationUrl, coverUrl, deadline, categoryId } = req.body;
    if (!title || !provider) return failRequired(res, ['title', 'provider']);
    const result = await query(
      `INSERT INTO scholarships (category_id,title,provider,description,amount,currency,country,application_url,cover_url,deadline,published)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true) RETURNING *`,
      [categoryId||null,title,provider,description,amount||null,currency||null,country||null,applicationUrl||null,coverUrl||null,deadline||null]);
    res.status(201).json({ scholarship: result.rows[0] });
  } catch (error) { next(error); }
});

featuresRouter.put('/scholarships/:id/save', async (req, res, next) => {
  try { await query(`INSERT INTO saved_scholarships (user_id,scholarship_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [req.auth.sub,req.params.id]); res.status(204).end(); }
  catch (error) { next(error); }
});

featuresRouter.get('/events', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT e.id,e.title,e.description,e.location,e.cover_url AS "coverUrl",e.starts_at AS "startsAt",
        e.ends_at AS "endsAt",e.capacity,u.display_name AS organizer,cat.name AS category,
        ea.status AS "attendanceStatus",count(all_ea.user_id)::int AS "attendeeCount"
       FROM events e LEFT JOIN users u ON u.id=e.organizer_id LEFT JOIN categories cat ON cat.id=e.category_id
       LEFT JOIN event_attendees ea ON ea.event_id=e.id AND ea.user_id=$1
       LEFT JOIN event_attendees all_ea ON all_ea.event_id=e.id AND all_ea.status='going'
       WHERE e.published=true GROUP BY e.id,u.id,cat.id,ea.status ORDER BY e.starts_at`, [req.auth.sub]);
    res.json({ events: result.rows });
  } catch (error) { next(error); }
});

featuresRouter.post('/events', async (req, res, next) => {
  try {
    const { title, description='', location, coverUrl, startsAt, endsAt, capacity, categoryId } = req.body;
    if (!title || !startsAt) return failRequired(res, ['title', 'startsAt']);
    const result = await query(
      `INSERT INTO events (organizer_id,category_id,title,description,location,cover_url,starts_at,ends_at,capacity,published)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true) RETURNING *`,
      [req.auth.sub,categoryId||null,title,description,location||null,coverUrl||null,startsAt,endsAt||null,capacity||null]);
    res.status(201).json({ event: result.rows[0] });
  } catch (error) { next(error); }
});

featuresRouter.post('/events/:id/join', async (req, res, next) => {
  try {
    const result = await query(
      `INSERT INTO event_attendees (event_id,user_id,status) VALUES ($1,$2,$3)
       ON CONFLICT (event_id,user_id) DO UPDATE SET status=EXCLUDED.status RETURNING *`,
      [req.params.id,req.auth.sub,req.body.status||'going']);
    res.status(201).json({ attendance: result.rows[0] });
  } catch (error) { next(error); }
});

featuresRouter.get('/friends', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT f.requester_id AS "requesterId",f.addressee_id AS "addresseeId",f.status,f.created_at AS "createdAt",
        json_build_object('id',u.id,'displayName',u.display_name,'username',u.username) AS user
       FROM friendships f JOIN users u ON u.id=CASE WHEN f.requester_id=$1 THEN f.addressee_id ELSE f.requester_id END
       WHERE f.requester_id=$1 OR f.addressee_id=$1 ORDER BY f.updated_at DESC`, [req.auth.sub]);
    res.json({ friendships: result.rows });
  } catch (error) { next(error); }
});

featuresRouter.post('/friends/:userId', async (req, res, next) => {
  try {
    const result = await query(`INSERT INTO friendships (requester_id,addressee_id) VALUES ($1,$2) RETURNING *`, [req.auth.sub,req.params.userId]);
    res.status(201).json({ friendship: result.rows[0] });
  } catch (error) { if (error.code==='23505') return res.status(409).json({error:'Friend request already exists'}); next(error); }
});

featuresRouter.patch('/friends/:userId', async (req, res, next) => {
  try {
    const result = await query(
      `UPDATE friendships SET status=$3,updated_at=now() WHERE requester_id=$2 AND addressee_id=$1 RETURNING *`,
      [req.auth.sub,req.params.userId,req.body.status]);
    res.json({ friendship: result.rows[0] });
  } catch (error) { next(error); }
});

featuresRouter.get('/conversations', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT c.id,
        COALESCE(c.title,(SELECT string_agg(u.display_name,', ' ORDER BY u.display_name)
          FROM conversation_members other_cm JOIN users u ON u.id=other_cm.user_id
          WHERE other_cm.conversation_id=c.id AND other_cm.user_id<>$1),'Chat') AS title,
        c.is_group AS "isGroup",c.updated_at AS "updatedAt",
        (SELECT body FROM messages WHERE conversation_id=c.id ORDER BY created_at DESC LIMIT 1) AS "lastMessage"
       FROM conversations c JOIN conversation_members cm ON cm.conversation_id=c.id
       WHERE cm.user_id=$1 ORDER BY c.updated_at DESC`, [req.auth.sub]);
    res.json({ conversations: result.rows });
  } catch (error) { next(error); }
});

featuresRouter.post('/conversations', async (req, res, next) => {
  const isGroup = Boolean(req.body.isGroup);
  const otherIds = [...new Set((req.body.memberIds || []).map(String))].filter((id) => id !== req.auth.sub);
  if (!otherIds.length) return failRequired(res, ['memberIds']);
  if (!isGroup && otherIds.length !== 1) return res.status(400).json({ error: 'A direct chat needs exactly one other member' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const people = await client.query(
      `SELECT u.id FROM users u WHERE u.id = ANY($2::uuid[]) AND NOT EXISTS (
         SELECT 1 FROM friendships f WHERE f.status='blocked'
           AND ((f.requester_id=$1 AND f.addressee_id=u.id) OR (f.requester_id=u.id AND f.addressee_id=$1)))`,
      [req.auth.sub, otherIds]);
    if (people.rows.length !== otherIds.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'One or more people could not be found' });
    }
    if (!isGroup) {
      // Serialize concurrent "start chat" taps so the same pair never gets two conversations.
      const pair = [req.auth.sub, otherIds[0]].sort().join(':');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [pair]);
      const existing = await client.query(
        `SELECT c.* FROM conversations c
         WHERE NOT c.is_group
           AND EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id=c.id AND m.user_id=$1)
           AND EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id=c.id AND m.user_id=$2)
           AND (SELECT count(*) FROM conversation_members m WHERE m.conversation_id=c.id) = 2
         ORDER BY c.updated_at DESC LIMIT 1`, [req.auth.sub, otherIds[0]]);
      if (existing.rows[0]) {
        await client.query('COMMIT');
        return res.json({ conversation: existing.rows[0], existing: true });
      }
    }
    const created = await client.query(`INSERT INTO conversations (title,is_group,created_by) VALUES ($1,$2,$3) RETURNING *`, [req.body.title||null,isGroup,req.auth.sub]);
    await client.query(`INSERT INTO conversation_members (conversation_id,user_id) SELECT $1,unnest($2::uuid[])`, [created.rows[0].id,[req.auth.sub,...otherIds]]);
    await client.query('COMMIT');
    res.status(201).json({ conversation: created.rows[0], existing: false });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

featuresRouter.get('/conversations/:id/messages', async (req, res, next) => {
  try {
    const { messages, source } = await listMessages(req.params.id, req.auth.sub);
    res.set('X-Data-Source', source).json({ messages, source });
  } catch (error) {
    if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

featuresRouter.post('/conversations/:id/messages', async (req, res, next) => {
  try {
    const body = typeof req.body.body === 'string' ? req.body.body.trim() : '';
    if (!body) return failRequired(res,['body']);
    const { message, queued } = await sendMessage(req.params.id, { id: req.auth.sub }, {
      body,
      mediaUrl: req.body.mediaUrl,
      clientMessageId: req.body.clientMessageId,
    });
    // 202 means the message is safely stored on this server and will be delivered to PostgreSQL automatically.
    res.status(queued ? 202 : 201).json({ message, queued });
  } catch (error) {
    if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

featuresRouter.get('/library', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT b.id,b.title,b.author,b.description,b.cover_url AS "coverUrl",b.file_url AS "fileUrl",b.page_count AS "pageCount",
        cat.name AS category,COALESCE(r.progress_percent,0) AS "progressPercent",COALESCE(r.current_page,0) AS "currentPage"
       FROM books b LEFT JOIN categories cat ON cat.id=b.category_id
       LEFT JOIN reading_progress r ON r.book_id=b.id AND r.user_id=$1 WHERE b.published=true ORDER BY b.created_at DESC`, [req.auth.sub]);
    res.json({ books: result.rows });
  } catch (error) { next(error); }
});

featuresRouter.post('/library', async (req, res, next) => {
  try {
    const { title, author, description='', coverUrl, fileUrl, pageCount, categoryId } = req.body;
    if (!title || !author || !fileUrl) return failRequired(res, ['title','author','fileUrl']);
    const result = await query(
      `INSERT INTO books (category_id,title,author,description,cover_url,file_url,page_count,published)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true) RETURNING *`,
      [categoryId||null,title,author,description,coverUrl||null,fileUrl,pageCount||null]);
    res.status(201).json({ book: result.rows[0] });
  } catch (error) { next(error); }
});

featuresRouter.patch('/library/:id/progress', async (req, res, next) => {
  try {
    const result = await query(
      `INSERT INTO reading_progress (user_id,book_id,current_page,progress_percent) VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id,book_id) DO UPDATE SET current_page=EXCLUDED.current_page,progress_percent=EXCLUDED.progress_percent,updated_at=now() RETURNING *`,
      [req.auth.sub,req.params.id,req.body.currentPage||0,req.body.progressPercent||0]);
    res.json({ progress: result.rows[0] });
  } catch (error) { next(error); }
});

featuresRouter.get('/notifications', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id,type,title,body,data,read_at AS "readAt",created_at AS "createdAt" FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`,
      [req.auth.sub]);
    res.json({ notifications: result.rows });
  } catch (error) { next(error); }
});

featuresRouter.patch('/notifications/:id/read', async (req, res, next) => {
  try { await query(`UPDATE notifications SET read_at=now() WHERE id=$1 AND user_id=$2`,[req.params.id,req.auth.sub]); res.status(204).end(); }
  catch (error) { next(error); }
});
