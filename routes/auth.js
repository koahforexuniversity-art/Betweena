const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const https = require('https');
const { v4: uuidv4 } = require('uuid');
const { getPool } = require('../database');
const { authMiddleware, JWT_SECRET, JWT_ISSUER } = require('../middleware/auth');

const router = express.Router();
const ah = fn => (req, res, next) => fn(req, res, next).catch(next);

// ── Email via nodemailer (optional — set SMTP_HOST + SMTP_USER + SMTP_PASS) ──
let transporter = null;
try {
  const nodemailer = require('nodemailer');
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    console.log('✓ Email transport ready');
  }
} catch (e) { /* nodemailer not available */ }

async function sendEmail(to, subject, html) {
  if (!transporter) {
    console.log(`[EMAIL] To: ${to} | Subject: ${subject}`);
    return false;
  }
  await transporter.sendMail({
    from: process.env.SMTP_FROM || `"Betweena" <${process.env.SMTP_USER}>`,
    to, subject, html,
  });
  return true;
}

// ── SMS via Twilio REST (optional — set TWILIO_SID + TWILIO_TOKEN + TWILIO_FROM) ──
function sendSms(to, body) {
  return new Promise(resolve => {
    const sid = process.env.TWILIO_SID;
    const token = process.env.TWILIO_TOKEN;
    const from = process.env.TWILIO_FROM;
    if (!sid || !token || !from) {
      console.log(`[SMS] To: ${to} | Body: ${body}`);
      return resolve(false);
    }
    const data = new URLSearchParams({ From: from, To: to, Body: body }).toString();
    const req = https.request({
      hostname: 'api.twilio.com',
      path: `/2010-04-01/Accounts/${sid}/Messages.json`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
      },
    }, () => resolve(true));
    req.on('error', () => resolve(false));
    req.write(data);
    req.end();
  });
}

// ── Register ──
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
    [userId, first_name.trim(), last_name.trim(), email.toLowerCase(), phone || '', passwordHash, 'unverified']
  );
  await db.query('INSERT INTO wallets (id,user_id,balance) VALUES ($1,$2,$3)', [walletId, userId, 0.00]);
  await db.query(
    'INSERT INTO notifications (id,user_id,title,message,type) VALUES ($1,$2,$3,$4,$5)',
    [uuidv4(), userId, 'Welcome to Betweena!', 'Verify your account to start your first secure transaction.', 'success']
  );

  // Return minimal info — frontend will trigger OTP before issuing full session
  res.status(201).json({ registered: true, email: email.toLowerCase() });
}));

// ── Login ──
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
      email_verified: user.email_verified, phone_verified: user.phone_verified,
      created_at: user.created_at,
      wallet_balance: wRows[0] ? parseFloat(wRows[0].balance) : 0,
      unread_count: parseInt(nRows[0].count),
    }
  });
}));

// ── Send OTP ──
router.post('/send-otp', ah(async (req, res) => {
  const { email, type } = req.body; // type: 'email' | 'phone'
  if (!email || !type) return res.status(400).json({ error: 'Email and type required' });

  const db = getPool();
  const { rows } = await db.query('SELECT id, email, phone FROM users WHERE email = $1', [email.toLowerCase()]);
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  await db.query('UPDATE users SET otp_code=$1, otp_expires_at=$2 WHERE id=$3', [otp, expires, rows[0].id]);

  let delivered = false;
  if (type === 'email') {
    delivered = await sendEmail(
      rows[0].email,
      'Your Betweena verification code',
      `<div style="font-family:sans-serif;max-width:420px;margin:0 auto;padding:2rem">
        <h2 style="color:#006B5C;margin-bottom:0.5rem">Betweena Verification</h2>
        <p style="color:#444">Your one-time verification code is:</p>
        <div style="font-size:2.5rem;font-weight:700;letter-spacing:0.35em;color:#006B5C;padding:1.25rem;background:#E8F5F2;border-radius:12px;text-align:center;margin:1rem 0">${otp}</div>
        <p style="color:#888;font-size:0.82rem">Valid for 10 minutes. Never share this code with anyone.</p>
      </div>`
    );
  } else if (type === 'phone') {
    delivered = await sendSms(rows[0].phone, `Your Betweena code: ${otp}. Valid 10 mins. Do not share.`);
  }

  console.log(`OTP [${type.toUpperCase()}] ${email}: ${otp}`);
  // In non-production, expose OTP in response so devs can test without SMTP/Twilio
  const devMode = process.env.NODE_ENV !== 'production';
  res.json({ success: true, delivered, ...(devMode && { dev_otp: otp }) });
}));

// ── Verify OTP ──
router.post('/verify-otp', ah(async (req, res) => {
  const { email, otp, type } = req.body;
  if (!email || !otp) return res.status(400).json({ error: 'Email and code required' });

  const db = getPool();
  const { rows } = await db.query('SELECT id, otp_code, otp_expires_at FROM users WHERE email = $1', [email.toLowerCase()]);
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });

  const u = rows[0];
  if (!u.otp_code) return res.status(400).json({ error: 'No pending verification. Request a new code.' });
  if (u.otp_code !== otp.toString().trim()) return res.status(400).json({ error: 'Invalid code' });
  if (new Date() > new Date(u.otp_expires_at)) return res.status(400).json({ error: 'Code expired. Request a new one.' });

  const field = type === 'phone' ? 'phone_verified' : 'email_verified';
  await db.query(`UPDATE users SET ${field}=TRUE, otp_code=NULL, otp_expires_at=NULL WHERE id=$1`, [u.id]);

  const { rows: uRows } = await db.query('SELECT id,first_name,last_name,email,phone,kyc_status,email_verified,phone_verified,created_at FROM users WHERE id=$1', [u.id]);
  const { rows: wRows } = await db.query('SELECT balance FROM wallets WHERE user_id=$1', [u.id]);

  const token = jwt.sign({ id: u.id, email: email.toLowerCase() }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '7d', issuer: JWT_ISSUER });
  res.json({ success: true, token, user: { ...uRows[0], wallet_balance: parseFloat(wRows[0]?.balance || 0) } });
}));

// ── Submit KYC ──
router.post('/kyc', authMiddleware, ah(async (req, res) => {
  const { id_type, id_number, dob } = req.body;
  if (!id_type || !id_number || !dob)
    return res.status(400).json({ error: 'ID type, number and date of birth are required' });

  const db = getPool();
  await db.query(
    'UPDATE users SET kyc_id_type=$1, kyc_id_number=$2, kyc_dob=$3, kyc_status=$4, kyc_submitted_at=NOW(), updated_at=NOW() WHERE id=$5',
    [id_type, id_number, dob, 'pending', req.user.id]
  );

  // Simulate verification review — auto-approve after 4 s for demo
  setTimeout(async () => {
    try {
      await db.query(
        "UPDATE users SET kyc_status='verified', updated_at=NOW() WHERE id=$1 AND kyc_status='pending'",
        [req.user.id]
      );
    } catch (e) { /* ignore */ }
  }, 4000);

  res.json({ success: true, kyc_status: 'pending' });
}));

// ── Get profile ──
router.get('/profile', authMiddleware, ah(async (req, res) => {
  const db = getPool();
  const { rows } = await db.query(
    'SELECT id,first_name,last_name,email,phone,kyc_status,email_verified,phone_verified,created_at FROM users WHERE id = $1',
    [req.user.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  const { rows: wRows } = await db.query('SELECT balance FROM wallets WHERE user_id = $1', [req.user.id]);
  const { rows: nRows } = await db.query('SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND read = 0', [req.user.id]);
  res.json({ ...rows[0], wallet_balance: wRows[0] ? parseFloat(wRows[0].balance) : 0, unread_count: parseInt(nRows[0].count) });
}));

// ── Update profile ──
router.put('/profile', authMiddleware, ah(async (req, res) => {
  const { first_name, last_name, phone } = req.body;
  const db = getPool();
  await db.query('UPDATE users SET first_name=$1, last_name=$2, phone=$3, updated_at=NOW() WHERE id=$4', [first_name, last_name, phone, req.user.id]);
  res.json({ success: true });
}));

module.exports = router;
