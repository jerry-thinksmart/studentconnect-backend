import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getMessaging } from 'firebase-admin/messaging';
import { config } from './config.js';

let messaging;

export async function initializeFirebase() {
  if (messaging) return messaging;

  const serviceAccountJson = await readFile(
    resolve(process.cwd(), config.firebaseServiceAccountPath),
    'utf8',
  );
  const serviceAccount = JSON.parse(serviceAccountJson);
  const app = getApps()[0] ?? initializeApp({ credential: cert(serviceAccount) });
  messaging = getMessaging(app);
  return messaging;
}

export function firebaseAuth() {
  if (!messaging) throw new Error('Firebase has not been initialized');
  return getAuth(getApps()[0]);
}

export function firebaseMessaging() {
  if (!messaging) throw new Error('Firebase has not been initialized');
  return messaging;
}
