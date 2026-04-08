const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { getPool } = require('../database');
const { authMiddleware, JWT_SECRET, JWT_ISSUER } = require('../middleware/auth');

const router = express.Router();
const ah = fn => (req, res, next) => fn(req, res, next).catch(next);

// Register
router.post('/register', ah(async (req, res) => {
  const { first_name, last_name, email, phone, password } = req.body;
  if (!first_name || !last_name || !email || !password)
    return res.status(400).json({ error: 'All fields required' });
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email))
    return res.status(400).json({ error: 'Invalid email address' });
  if (password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const db = getPool();
  const { rows: existing } = await db.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
  if (existing[0]) return res.status(409).json({ error: 'Email already registered' });

  const passwordHash = bcrypt.hashSync(password, 10);
  const userId = uuidv4(), walletId = uuidv4();

  await db.query(
    'INSERT INTO users (id,first_name,last_name,email,phone,password_hash,kyc_status) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [userId, first_name.trim(), last_name.trim(), email.toLowerCase(), phone || '', passwordHash, 'verified']
  );
  await db.query('INSERT INTO wallets (id,user_id,balance) VALUES ($1,$2,$3)', [walletId, userId, 0.00]);
  await db.query(
    'INSERT INTO notifications (id,user_id,title,message,type) VALUES ($1,$2,$3,$4,$5)',
    [uuidv4(), userId, 'Welcome to Betweena!', 'Your account is set up. Add funds to your wallet and start your first secure transaction.', 'success']
  );

  const token = jwt.sign({ id: userId, email: email.toLowerCase() }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '7d', issuer: JWT_ISSUER });
  const { rows: uRows } = await db.query('SELECT id,first_name,last_name,email,phone,kyc_status,created_at FROM users WHERE id = $1', [userId]);
  const { rows: wRows } = await db.query('SELECT balance FROM wallets WHERE user_id = $1', [userId]);
  res.status(201).json({ token, user: { ...uRows[0], wallet_balance: parseFloat(wRows[0].balance) } });
}));

// Login
router.post('/login', ah(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const db = getPool();
  const { rows } = await db.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
  const user = rows[0];
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  if (!bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '7d', issuer: JWT_ISSUER });
  const { rows: wRows } = await db.query('SELECT balance FROM wallets WHERE user_id = $1', [user.id]);
  const { rows: nRows } = await db.query('SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND read = 0', [user.id]);

  res.json({
    token,
    user: {
      id: user.id, first_name: user.first_name, last_name: user.last_name,
      email: user.email, phone: user.phone, kyc_status: user.kyc_status,
      created_at: user.created_at,
      wallet_balance: wRows[0] ? parseFloat(wRows[0].balance) : 0,
      unread_count: parseInt(nRows[0].count),
    }
  });
}));

// Get profile
router.get('/profile', authMiddleware, ah(async (req, res) => {
  const db = getPool();
  const { rows } = await db.query('SELECT id,first_name,last_name,email,phone,kyc_status,created_at FROM users WHERE id = $1', [req.user.id]);
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  const { rows: wRows } = await db.query('SELECT balance FROM wallets WHERE user_id = $1', [req.user.id]);
  const { rows: nRows } = await db.query('SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND read = 0', [req.user.id]);
  res.json({ ...rows[0], wallet_balance: wRows[0] ? parseFloat(wRows[0].balance) : 0, unread_count: parseInt(nRows[0].count) });
}));

// Update profile
router.put('/profile', authMiddleware, ah(async (req, res) => {
  const { first_name, last_name, phone } = req.body;
  const db = getPool();
  await db.query('UPDATE users SET first_name=$1, last_name=$2, phone=$3, updated_at=NOW() WHERE id=$4', [first_name, last_name, phone, req.user.id]);
  res.json({ success: true });
}));

module.exports = router;
