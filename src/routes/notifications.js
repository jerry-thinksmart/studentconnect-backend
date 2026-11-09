import { Router } from 'express';
import { requireNotificationApiKey } from '../middleware/apiKey.js';
import { removeDeviceToken, saveDeviceToken, sendToUser } from '../services/notifications.js';

export const notificationsRouter = Router();

notificationsRouter.post('/devices', async (req, res, next) => {
  try {
    const { userId, token, platform } = req.body;
    if (!userId || !token || !['android', 'ios', 'web'].includes(platform)) {
      return res.status(400).json({ error: 'userId, token, and a valid platform are required' });
    }
    const device = await saveDeviceToken({ userId, token, platform });
    return res.status(201).json({ device });
  } catch (error) {
    return next(error);
  }
});

notificationsRouter.delete('/devices', async (req, res, next) => {
  try {
    if (!req.body.token) return res.status(400).json({ error: 'token is required' });
    await removeDeviceToken(req.body.token);
    return res.status(204).end();
  } catch (error) {
    return next(error);
  }
});

notificationsRouter.post('/send', requireNotificationApiKey, async (req, res, next) => {
  try {
    const { userId, title, body, data } = req.body;
    if (!userId || !title || !body) {
      return res.status(400).json({ error: 'userId, title, and body are required' });
    }
    const result = await sendToUser({ userId, title, body, data });
    return res.json(result);
  } catch (error) {
    return next(error);
  }
});
