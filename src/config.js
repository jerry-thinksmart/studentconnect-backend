import 'dotenv/config';

function booleanEnv(value, defaultValue) {
  if (value === undefined) return defaultValue;
  return value.toLowerCase() === 'true';
}

export const config = Object.freeze({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL,
  databaseSsl: booleanEnv(process.env.DATABASE_SSL, true),
  firebaseServiceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT_PATH,
  notificationApiKey: process.env.NOTIFICATION_API_KEY,
  chatCachePath: process.env.CHAT_CACHE_PATH ?? './data/chat-cache.db',
  chatSyncIntervalMs: Number(process.env.CHAT_SYNC_INTERVAL_MS ?? 5000),
  chatDbTimeoutMs: Number(process.env.CHAT_DB_TIMEOUT_MS ?? 4000),
  chatMaxSyncAttempts: Number(process.env.CHAT_MAX_SYNC_ATTEMPTS ?? 5),
  jwtSecret: process.env.JWT_SECRET ?? process.env.NOTIFICATION_API_KEY,
});

export function validateConfig() {
  const missing = [];
  if (!config.databaseUrl) missing.push('DATABASE_URL');
  if (!config.firebaseServiceAccountPath) missing.push('FIREBASE_SERVICE_ACCOUNT_PATH');
  if (!config.notificationApiKey) missing.push('NOTIFICATION_API_KEY');
  if (!config.jwtSecret) missing.push('JWT_SECRET');
  if (missing.length) {
    throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  }
}
