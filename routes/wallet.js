const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getPool } = require('../database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
const ah = fn => (req, res, next) => fn(req, res, next).catch(next);

// GET /api/wallet
router.get('/', authMiddleware, ah(async (req, res) => {
  const db = getPool();
  const { rows: wRows } = await db.query('SELECT * FROM wallets WHERE user_id = $1', [req.user.id]);
  const wallet = wRows[0];
  if (!wallet) return res.status(404).json({ error: 'Wallet not found' });

  const { rows: txns } = await db.query(
    'SELECT * FROM wallet_transactions WHERE wallet_id = $1 ORDER BY created_at DESC LIMIT 20',
    [wallet.id]
  );
  res.json({
    wallet: { ...wallet, balance: parseFloat(wallet.balance) },
    transactions: txns.map(t => ({
      ...t,
      amount: parseFloat(t.amount),
      balance_after: parseFloat(t.balance_after),
    })),
  });
}));

// POST /api/wallet/deposit
router.post('/deposit', authMiddleware, ah(async (req, res) => {
  const { method } = req.body;
  const amount = parseFloat(req.body.amount);
  if (!amount || isNaN(amount) || amount <= 0) return res.status(400).json({ error: 'Valid amount required' });
  if (amount > 100000) return res.status(400).json({ error: 'Maximum deposit is ₵100,000' });

  const db = getPool();
  const { rows: wRows } = await db.query('SELECT * FROM wallets WHERE user_id = $1', [req.user.id]);
  const wallet = wRows[0];
  if (!wallet) return res.status(404).json({ error: 'Wallet not found' });

  const newBalance = parseFloat(wallet.balance) + amount;
  await db.query('UPDATE wallets SET balance=$1 WHERE id=$2', [newBalance, wallet.id]);
  const txnId = uuidv4();
  await db.query(
    'INSERT INTO wallet_transactions (id,wallet_id,type,amount,description,reference,balance_after) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [txnId, wallet.id, 'deposit', amount, `Deposit via ${method || 'Mobile Money'}`, `DEP-${Date.now()}`, newBalance]
  );
  await db.query(
    'INSERT INTO notifications (id,user_id,title,message,type) VALUES ($1,$2,$3,$4,$5)',
    [uuidv4(), req.user.id, 'Deposit Successful', `₵${amount.toFixed(2)} added to your wallet.`, 'success']
  );
  res.json({ balance: newBalance, transaction_id: txnId });
}));

// POST /api/wallet/withdraw
router.post('/withdraw', authMiddleware, ah(async (req, res) => {
  const { method, account_number } = req.body;
  const amount = parseFloat(req.body.amount);
  if (!amount || isNaN(amount) || amount <= 0) return res.status(400).json({ error: 'Valid amount required' });

  const db = getPool();
  const { rows: wRows } = await db.query('SELECT * FROM wallets WHERE user_id = $1', [req.user.id]);
  const wallet = wRows[0];
  if (!wallet) return res.status(404).json({ error: 'Wallet not found' });
  if (parseFloat(wallet.balance) < amount) return res.status(400).json({ error: 'Insufficient balance' });

  const newBalance = parseFloat(wallet.balance) - amount;
  await db.query('UPDATE wallets SET balance=$1 WHERE id=$2', [newBalance, wallet.id]);
  const txnId = uuidv4();
  await db.query(
    'INSERT INTO wallet_transactions (id,wallet_id,type,amount,description,reference,balance_after) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [txnId, wallet.id, 'withdrawal', -amount,
     `Withdrawal to ${method || 'Mobile Money'} ${account_number || ''}`.trim(),
     `WIT-${Date.now()}`, newBalance]
  );
  await db.query(
    'INSERT INTO notifications (id,user_id,title,message,type) VALUES ($1,$2,$3,$4,$5)',
    [uuidv4(), req.user.id, 'Withdrawal Initiated', `₵${amount.toFixed(2)} will arrive within 24 hours.`, 'info']
  );
  res.json({ balance: newBalance, transaction_id: txnId });
}));

module.exports = router;
