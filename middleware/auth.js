const jwt = require('jsonwebtoken');
const { getPool } = require('../database');

const JWT_SECRET = process.env.JWT_SECRET || 'betweena-secret-key-change-in-production';
const JWT_ISSUER = 'betweena';

if (!process.env.JWT_SECRET) {
  console.warn('\x1b[33m⚠  JWT_SECRET not set — using insecure default. Set JWT_SECRET in .env before deploying.\x1b[0m');
}

async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: JWT_ISSUER,
    });
    const db = getPool();
    const { rows } = await db.query('SELECT id FROM users WHERE id = $1', [decoded.id]);
    if (!rows[0]) return res.status(401).json({ error: 'Session expired, please log in again' });
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { authMiddleware, JWT_SECRET, JWT_ISSUER };
