const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// Get wallet info
router.get('/', authMiddleware, (req, res) => {
  const db = getDb();
  const wallet = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(req.user.id);
  if (!wallet) return res.status(404).json({ error: 'Wallet not found' });
  const txns = db.prepare(`SELECT * FROM wallet_transactions WHERE wallet_id = ? ORDER BY created_at DESC LIMIT 20`).all(wallet.id);
  res.json({ wallet, transactions: txns });
});

// Deposit (simulated - in production integrate with payment gateway)
router.post('/deposit', authMiddleware, (req, res) => {
  const { method } = req.body;
  const amount = parseFloat(req.body.amount);
  if (!amount || isNaN(amount) || amount <= 0) return res.status(400).json({ error: 'Valid amount required' });
  if (amount > 10000) return res.status(400).json({ error: 'Maximum deposit is $10,000' });

  const db = getDb();
  const wallet = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(req.user.id);
  if (!wallet) return res.status(404).json({ error: 'Wallet not found' });

  const newBalance = wallet.balance + parseFloat(amount);
  db.prepare('UPDATE wallets SET balance = ? WHERE id = ?').run(newBalance, wallet.id);
  const txnId = uuidv4();
  db.prepare(`INSERT INTO wallet_transactions (id, wallet_id, type, amount, description, reference, balance_after)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(txnId, wallet.id, 'deposit', amount, `Deposit via ${method || 'Mobile Money'}`, `DEP-${Date.now()}`, newBalance);

  db.prepare(`INSERT INTO notifications (id, user_id, title, message, type) VALUES (?, ?, ?, ?, ?)`)
    .run(uuidv4(), req.user.id, 'Deposit Successful', `₵${parseFloat(amount).toFixed(2)} added to your wallet.`, 'success');

  res.json({ balance: newBalance, transaction_id: txnId });
});

// Withdraw
router.post('/withdraw', authMiddleware, (req, res) => {
  const { method, account_number } = req.body;
  const amount = parseFloat(req.body.amount);
  if (!amount || isNaN(amount) || amount <= 0) return res.status(400).json({ error: 'Valid amount required' });

  const db = getDb();
  const wallet = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(req.user.id);
  if (!wallet) return res.status(404).json({ error: 'Wallet not found' });
  if (wallet.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });

  const newBalance = wallet.balance - parseFloat(amount);
  db.prepare('UPDATE wallets SET balance = ? WHERE id = ?').run(newBalance, wallet.id);
  const txnId = uuidv4();
  db.prepare(`INSERT INTO wallet_transactions (id, wallet_id, type, amount, description, reference, balance_after)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(txnId, wallet.id, 'withdrawal', -amount, `Withdrawal to ${method || 'Mobile Money'} ${account_number || ''}`, `WIT-${Date.now()}`, newBalance);

  db.prepare(`INSERT INTO notifications (id, user_id, title, message, type) VALUES (?, ?, ?, ?, ?)`)
    .run(uuidv4(), req.user.id, 'Withdrawal Initiated', `₵${parseFloat(amount).toFixed(2)} will arrive within 24 hours.`, 'info');

  res.json({ balance: newBalance, transaction_id: txnId });
});

module.exports = router;
