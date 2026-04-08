const jwt = require('jsonwebtoken');
const { getDb } = require('../database');

const JWT_SECRET = process.env.JWT_SECRET || 'betweena-secret-key-change-in-production';
const JWT_ISSUER = 'betweena';

// Warn at startup if using the default insecure secret
if (!process.env.JWT_SECRET) {
  console.warn('\x1b[33m⚠  JWT_SECRET not set — using insecure default. Set JWT_SECRET in .env before deploying.\x1b[0m');
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const token = authHeader.split(' ')[1];
  try {
    // Always specify algorithms allowlist — prevents alg:none attack (CVE-2015-9235)
    // and algorithm confusion where RS256 public key is used as an HMAC secret.
    const decoded = jwt.verify(token, JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: JWT_ISSUER,
    });
    // Make sure the user still exists (catches stale tokens after DB reset)
    const db = getDb();
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(decoded.id);
    if (!user) return res.status(401).json({ error: 'Session expired, please log in again' });
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { authMiddleware, JWT_SECRET, JWT_ISSUER };
