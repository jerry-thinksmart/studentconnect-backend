import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pool } from '../db.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

const sqlDirectory = resolve(process.cwd(), 'sql');
const files = (await readdir(sqlDirectory)).filter((file) => file.endsWith('.sql')).sort();
for (const file of files) {
  const sql = await readFile(resolve(sqlDirectory, file), 'utf8');
  await pool.query(sql);
  console.log(`Applied ${file}`);
}
await pool.end();
console.log('Database migration completed');
