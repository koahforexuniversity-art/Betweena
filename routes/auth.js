const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const { authMiddleware, JWT_SECRET, JWT_ISSUER } = require('../middleware/auth');

const router = express.Router();

// Register
router.post('/register', (req, res) => {
  const { first_name, last_name, email, phone, password } = req.body;
  if (!first_name || !last_name || !email || !password) {
    return res.status(400).json({ error: 'All fields required' });
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) {
    return res.status(409).json({ error: 'Email already registered' });
  }
  const passwordHash = bcrypt.hashSync(password, 10);
  const userId = uuidv4();
  const walletId = uuidv4();

  db.prepare(`INSERT INTO users (id, first_name, last_name, email, phone, password_hash, kyc_status)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(userId, first_name.trim(), last_name.trim(), email.toLowerCase(), phone || '', passwordHash, 'verified');

  db.prepare(`INSERT INTO wallets (id, user_id, balance) VALUES (?, ?, ?)`)
    .run(walletId, userId, 0.00);

  // Welcome notification
  db.prepare(`INSERT INTO notifications (id, user_id, title, message, type) VALUES (?, ?, ?, ?, ?)`)
    .run(uuidv4(), userId, 'Welcome to Betweena!', 'Your account is set up. Add funds to your wallet and start your first secure transaction.', 'success');

  const token = jwt.sign({ id: userId, email: email.toLowerCase() }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '7d', issuer: JWT_ISSUER });
  const user = db.prepare('SELECT id, first_name, last_name, email, phone, kyc_status, created_at FROM users WHERE id = ?').get(userId);
  const wallet = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(userId);

  res.status(201).json({ token, user: { ...user, wallet_balance: wallet.balance } });
});

// Login
router.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const valid = bcrypt.compareSync(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '7d', issuer: JWT_ISSUER });
  const wallet = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(user.id);
  const unread = db.prepare('SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND read = 0').get(user.id);

  res.json({
    token,
    user: {
      id: user.id, first_name: user.first_name, last_name: user.last_name,
      email: user.email, phone: user.phone, kyc_status: user.kyc_status,
      created_at: user.created_at,
      wallet_balance: wallet ? wallet.balance : 0,
      unread_count: unread.count
    }
  });
});

// Get profile
router.get('/profile', authMiddleware, (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT id, first_name, last_name, email, phone, kyc_status, created_at FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const wallet = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(req.user.id);
  const unread = db.prepare('SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND read = 0').get(req.user.id);
  res.json({ ...user, wallet_balance: wallet ? wallet.balance : 0, unread_count: unread.count });
});

// Update profile
router.put('/profile', authMiddleware, (req, res) => {
  const { first_name, last_name, phone } = req.body;
  const db = getDb();
  db.prepare('UPDATE users SET first_name = ?, last_name = ?, phone = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(first_name, last_name, phone, req.user.id);
  res.json({ success: true });
});

module.exports = router;
