const jwt = require('jsonwebtoken');
const { getDb } = require('../database');
const JWT_SECRET = process.env.JWT_SECRET || 'betweena-secret-key-change-in-production';

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
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

module.exports = { authMiddleware, JWT_SECRET };
