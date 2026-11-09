import { app } from './app.js';
import { config, validateConfig } from './config.js';
import { pool } from './db.js';
import { initializeFirebase } from './firebase.js';
import { chatCache } from './services/chatCache.js';
import { markChatDatabaseDown, startChatSync, stopChatSync } from './services/chatSync.js';

validateConfig();
try {
  await pool.query('SELECT 1');
} catch (error) {
  // Start anyway: chat is served from the SQLite cache until PostgreSQL returns.
  markChatDatabaseDown(error);
}
await initializeFirebase();

startChatSync();

const server = app.listen(config.port, () => {
  console.log(`StudentConnect API listening on port ${config.port}`);
});

async function shutdown(signal) {
  console.log(`${signal} received; shutting down`);
  stopChatSync();
  server.close(async () => {
    await pool.end();
    chatCache.close();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
