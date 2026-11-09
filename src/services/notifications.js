import { query } from '../db.js';
import { firebaseMessaging } from '../firebase.js';

export async function saveDeviceToken({ userId, token, platform }) {
  const result = await query(
    `INSERT INTO device_tokens (user_id, token, platform)
     VALUES ($1, $2, $3)
     ON CONFLICT (token) DO UPDATE
       SET user_id = EXCLUDED.user_id,
           platform = EXCLUDED.platform,
           updated_at = now()
     RETURNING id, user_id, platform, created_at, updated_at`,
    [userId, token, platform],
  );
  return result.rows[0];
}

export async function removeDeviceToken(token) {
  await query('DELETE FROM device_tokens WHERE token = $1', [token]);
}

export async function sendToUser({ userId, title, body, data = {} }) {
  await query(
    `INSERT INTO notifications (user_id, type, title, body, data)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [userId, data.type ? String(data.type) : 'general', title, body, JSON.stringify(data)],
  );
  const result = await query('SELECT token FROM device_tokens WHERE user_id = $1', [userId]);
  const tokens = result.rows.map((row) => row.token);
  if (tokens.length === 0) return { successCount: 0, failureCount: 0 };

  const response = await firebaseMessaging().sendEachForMulticast({
    tokens,
    notification: { title, body },
    data: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, String(value)])),
  });

  const invalidTokens = response.responses
    .map((item, index) => ({ item, token: tokens[index] }))
    .filter(({ item }) => item.error?.code === 'messaging/registration-token-not-registered')
    .map(({ token }) => token);

  if (invalidTokens.length) {
    await query('DELETE FROM device_tokens WHERE token = ANY($1::text[])', [invalidTokens]);
  }

  return { successCount: response.successCount, failureCount: response.failureCount };
}
