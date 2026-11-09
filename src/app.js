import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { query } from './db.js';
import { notificationsRouter } from './routes/notifications.js';
import { authRouter } from './routes/auth.js';
import { peopleRouter } from './routes/people.js';
import { featuresRouter } from './routes/features.js';
import { feedImagesRouter } from './routes/feedImages.js';
import { communityContentRouter } from './routes/communityContent.js';
import { chatStatus, isConnectivityError, markChatDatabaseDown } from './services/chatSync.js';
import { requireAuth } from './middleware/auth.js';

export const app = express();

app.use(helmet());
app.use(cors());
// Posting a photo sends it base64-encoded, so this one path accepts a larger body (authenticated only).
app.use('/api/v1/feeds', requireAuth, express.json({ limit: '8mb' }));
// Community resources are uploaded base64-encoded (up to 10 MB of file data), authenticated only.
app.use('/api/v1/communities/:id/resources', requireAuth, express.json({ limit: '15mb' }));
app.use(express.json({ limit: '1mb' }));

app.get('/health', async (_req, res, next) => {
  try {
    await query('SELECT 1');
    res.json({ status: 'ok', chat: chatStatus() });
  } catch (error) {
    // Still serving chat from the SQLite cache, so keep this node in the load balancer.
    if (isConnectivityError(error)) {
      markChatDatabaseDown(error);
      return res.json({ status: 'degraded', chat: chatStatus() });
    }
    next(error);
  }
});

app.use('/api/v1/notifications', notificationsRouter);
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/people', peopleRouter);
app.use('/api/v1/feed-images', feedImagesRouter);
app.use('/api/v1/communities', communityContentRouter);
app.use('/api/v1', featuresRouter);

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

app.use((error, _req, res, _next) => {
  if (error.code === '22P02') return res.status(400).json({ error: 'Invalid id' });
  console.error(error);
  res.status(500).json({ error: 'Internal server error' });
});
