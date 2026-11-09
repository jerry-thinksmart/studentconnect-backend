import bcrypt from 'bcryptjs';
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query } from '../db.js';
import { firebaseAuth } from '../firebase.js';
import { requireAuth } from '../middleware/auth.js';

export const authRouter = Router();
const publicUserColumns = `id, email, first_name AS "firstName", last_name AS "lastName",
  display_name AS "displayName", username, phone, gender,
  country, city, career_path AS "careerPath", institution,
  created_at AS "createdAt", updated_at AS "updatedAt"`;
const issueToken = (user) => jwt.sign(
  { sub: user.id, email: user.email },
  config.jwtSecret,
  { expiresIn: '30d' },
);

authRouter.post('/register', async (req, res, next) => {
  try {
    const { firstName, lastName, username, email, phone, gender, password, country, city, careerPath, institution } = req.body;
    const optionalText = (value) => (typeof value === 'string' ? value.trim().slice(0, 80) || null : null);
    if (!firstName || !lastName || !username || !email || !password) {
      return res.status(400).json({ error: 'firstName, lastName, username, email, and password are required' });
    }
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await query(
      `INSERT INTO users (email, display_name, first_name, last_name, username, phone, gender, password_hash,
         country, city, career_path, institution)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING ${publicUserColumns}`,
      [email.trim().toLowerCase(), `${firstName.trim()} ${lastName.trim()}`, firstName.trim(),
        lastName.trim(), username.trim().toLowerCase(), phone?.trim() || null, gender || null, passwordHash,
        optionalText(country), optionalText(city), optionalText(careerPath), optionalText(institution)],
    );
    const user = result.rows[0];
    return res.status(201).json({ token: issueToken(user), user });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Email, username, or phone is already registered' });
    return next(error);
  }
});

authRouter.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    const result = await query(
      `SELECT ${publicUserColumns}, password_hash AS "passwordHash" FROM users WHERE lower(email) = lower($1) LIMIT 1`,
      [email.trim()],
    );
    const user = result.rows[0];
    if (!user?.passwordHash || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    delete user.passwordHash;
    return res.json({ token: issueToken(user), user });
  } catch (error) { return next(error); }
});

authRouter.post('/google', async (req, res, next) => {
  try {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ error: 'idToken is required' });
    let decoded;
    try {
      decoded = await firebaseAuth().verifyIdToken(idToken);
    } catch {
      return res.status(401).json({ error: 'Invalid Google sign-in token' });
    }
    if (!decoded.email || decoded.email_verified === false) {
      return res.status(401).json({ error: 'Google account email is not verified' });
    }
    const email = decoded.email.trim().toLowerCase();
    const displayName = decoded.name?.trim() || email.split('@')[0];
    const [firstName, ...rest] = displayName.split(/\s+/);
    const result = await query(
      `INSERT INTO users (email, display_name, first_name, last_name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE SET updated_at = now()
       RETURNING ${publicUserColumns}`,
      [email, displayName, firstName, rest.join(' ') || null],
    );
    const user = result.rows[0];
    return res.json({ token: issueToken(user), user });
  } catch (error) { return next(error); }
});

authRouter.get('/me', requireAuth, async (req, res, next) => {
  try {
    const result = await query(`SELECT ${publicUserColumns} FROM users WHERE id = $1`, [req.auth.sub]);
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    return res.json({ user: result.rows[0] });
  } catch (error) { return next(error); }
});

const profileFields = { country: 'country', city: 'city', careerPath: 'career_path', institution: 'institution' };

authRouter.patch('/me', requireAuth, async (req, res, next) => {
  try {
    const assignments = [];
    const values = [req.auth.sub];
    for (const [key, column] of Object.entries(profileFields)) {
      if (!(key in req.body)) continue;
      const value = req.body[key];
      if (value !== null && typeof value !== 'string') return res.status(400).json({ error: `${key} must be text` });
      const clean = value?.trim().slice(0, 80) || null;
      values.push(clean);
      assignments.push(`${column}=$${values.length}`);
    }
    if (!assignments.length) return res.status(400).json({ error: 'No profile fields to update' });
    const result = await query(
      `UPDATE users SET ${assignments.join(', ')}, updated_at=now() WHERE id=$1 RETURNING ${publicUserColumns}`,
      values,
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    return res.json({ user: result.rows[0] });
  } catch (error) { return next(error); }
});
