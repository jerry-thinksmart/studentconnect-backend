import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

export function requireNotificationApiKey(req, res, next) {
  const received = req.get('x-api-key') ?? '';
  const expected = config.notificationApiKey ?? '';
  const valid = received.length === expected.length
    && received.length > 0
    && timingSafeEqual(Buffer.from(received), Buffer.from(expected));

  if (!valid) return res.status(401).json({ error: 'Unauthorized' });
  next();
}
