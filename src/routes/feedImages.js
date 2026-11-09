import { Router } from 'express';
import { query } from '../db.js';

export const feedImagesRouter = Router();

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Image ids are unguessable UUIDs, which lets Image.network load them without auth headers.
feedImagesRouter.get('/:id', async (req, res, next) => {
  try {
    if (!UUID_PATTERN.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const result = await query(
      `SELECT i.content_type, i.data FROM post_images i JOIN posts p ON p.id=i.post_id
       WHERE i.id=$1 AND p.visibility='public'`,
      [req.params.id]);
    const image = result.rows[0];
    if (!image) return res.status(404).json({ error: 'Not found' });
    res.set({
      'Content-Type': image.content_type,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'X-Content-Type-Options': 'nosniff',
    });
    res.send(image.data);
  } catch (error) { next(error); }
});
