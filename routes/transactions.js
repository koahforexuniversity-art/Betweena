const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// Thresholds in GHS (≈ $1k and $10k at ~14.9 GHS/USD)
function calcFee(amount) {
  if (amount <= 15000)  return amount * 0.035;
  if (amount <= 150000) return amount * 0.0225;
  return Math.min(amount * 0.015, 7500);
}

function getUserById(db, id) {
  return db.prepare('SELECT id, first_name, last_name, email FROM users WHERE id = ?').get(id);
}

function enrichTransaction(db, tx) {
  const initiator = getUserById(db, tx.initiator_id);
  const counterparty = tx.counterparty_id ? getUserById(db, tx.counterparty_id) : null;
  return { ...tx, initiator, counterparty };
}

function notify(db, userId, title, message, type, txId) {
  db.prepare(`INSERT INTO notifications (id, user_id, title, message, type, transaction_id) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(uuidv4(), userId, title, message, type || 'info', txId || null);
}

// Get all user transactions
router.get('/', authMiddleware, (req, res) => {
  const db = getDb();
  const txns = db.prepare(`
    SELECT * FROM transactions
    WHERE initiator_id = ? OR counterparty_id = ?
    ORDER BY created_at DESC
  `).all(req.user.id, req.user.id);
  const enriched = txns.map(tx => enrichTransaction(db, tx));
  res.json(enriched);
});

// Get dashboard stats
router.get('/stats', authMiddleware, (req, res) => {
  const db = getDb();
  const uid = req.user.id;
  const all = db.prepare('SELECT * FROM transactions WHERE initiator_id = ? OR counterparty_id = ?').all(uid, uid);
  const inEscrow = all.filter(t => ['funded','shipped'].includes(t.status)).reduce((s,t) => s + t.amount, 0);
  const released = all.filter(t => t.status === 'completed').reduce((s,t) => s + t.amount, 0);
  const active = all.filter(t => !['completed','cancelled'].includes(t.status)).length;
  const disputes = all.filter(t => t.status === 'disputed').length;
  const feesTotal = all.filter(t => t.status === 'completed').reduce((s,t) => s + (t.fee_amount || 0), 0);
  res.json({ in_escrow: inEscrow, total_released: released, active_count: active, dispute_count: disputes, total_fees_paid: feesTotal, total_transactions: all.length });
});

// Get single transaction
router.get('/:id', authMiddleware, (req, res) => {
  const db = getDb();
  const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
  if (!tx) return res.status(404).json({ error: 'Transaction not found' });
  if (tx.initiator_id !== req.user.id && tx.counterparty_id !== req.user.id) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  const messages = db.prepare(`
    SELECT tm.*, u.first_name, u.last_name FROM transaction_messages tm
    JOIN users u ON tm.sender_id = u.id
    WHERE tm.transaction_id = ? ORDER BY tm.created_at ASC
  `).all(req.params.id);
  res.json({ ...enrichTransaction(db, tx), messages });
});

// Create transaction
router.post('/create', authMiddleware, (req, res) => {
  const { title, description, amount, category, initiator_role, counterparty_email, inspection_days, notes } = req.body;
  if (!title || !amount || !initiator_role) return res.status(400).json({ error: 'Title, amount, and role required' });
  if (amount <= 0 || amount > 500000) return res.status(400).json({ error: 'Amount must be between $1 and $500,000' });

  const db = getDb();
  const joinCode = Math.random().toString(36).substr(2, 8).toUpperCase();
  const txId = uuidv4();
  const fee = calcFee(parseFloat(amount));

  // Find counterparty by email if provided
  let counterpartyId = null;
  let status = 'awaiting_counterparty';
  if (counterparty_email) {
    const cp = db.prepare('SELECT id FROM users WHERE email = ?').get(counterparty_email.toLowerCase());
    if (cp) { counterpartyId = cp.id; status = 'awaiting_funding'; }
  }

  db.prepare(`INSERT INTO transactions
    (id, title, description, amount, category, initiator_id, initiator_role, counterparty_id, counterparty_email, join_code, fee_amount, fee_rate, inspection_days, notes, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(txId, title.trim(), description || '', parseFloat(amount), category || 'goods',
      req.user.id, initiator_role, counterpartyId, counterparty_email || null,
      joinCode, fee, fee / parseFloat(amount), parseInt(inspection_days) || 3, notes || '', status);

  if (counterpartyId) {
    notify(db, counterpartyId, 'New Escrow Invitation', `You've been invited to a $${parseFloat(amount).toFixed(2)} escrow: "${title}"`, 'info', txId);
  }
  notify(db, req.user.id, 'Transaction Created', `Your escrow for "${title}" is ready. Share code: ${joinCode}`, 'success', txId);

  const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(txId);
  res.status(201).json(enrichTransaction(db, tx));
});

// Join transaction via code
router.post('/join', authMiddleware, (req, res) => {
  const { join_code } = req.body;
  if (!join_code) return res.status(400).json({ error: 'Join code required' });

  const db = getDb();
  const tx = db.prepare('SELECT * FROM transactions WHERE join_code = ?').get(join_code.toUpperCase());
  if (!tx) return res.status(404).json({ error: 'Invalid join code' });
  if (tx.initiator_id === req.user.id) return res.status(400).json({ error: 'You created this transaction' });
  if (tx.counterparty_id && tx.counterparty_id !== req.user.id) return res.status(400).json({ error: 'Transaction already has a counterparty' });
  if (!['awaiting_counterparty'].includes(tx.status)) return res.status(400).json({ error: 'Transaction cannot be joined at this stage' });

  db.prepare('UPDATE transactions SET counterparty_id = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(req.user.id, 'awaiting_funding', tx.id);

  notify(db, tx.initiator_id, 'Counterparty Joined!', `Someone joined your escrow: "${tx.title}". It's ready to be funded.`, 'success', tx.id);
  notify(db, req.user.id, 'Joined Escrow', `You've joined the escrow: "${tx.title}". Waiting for funds.`, 'info', tx.id);

  const updated = db.prepare('SELECT * FROM transactions WHERE id = ?').get(tx.id);
  res.json(enrichTransaction(db, updated));
});

// Fund transaction (buyer deposits into escrow)
router.post('/:id/fund', authMiddleware, (req, res) => {
  const db = getDb();
  const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
  if (!tx) return res.status(404).json({ error: 'Not found' });

  // Determine who is the buyer
  const buyerRole = tx.initiator_role === 'buyer' ? tx.initiator_id : tx.counterparty_id;
  if (req.user.id !== buyerRole) return res.status(403).json({ error: 'Only the buyer funds this escrow' });
  if (!['awaiting_funding'].includes(tx.status)) return res.status(400).json({ error: 'Transaction cannot be funded at this stage' });

  const wallet = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(req.user.id);
  const totalNeeded = tx.amount + tx.fee_amount;
  if (wallet.balance < totalNeeded) return res.status(400).json({ error: `Insufficient balance. Need $${totalNeeded.toFixed(2)} (amount + fee)` });

  const newBalance = wallet.balance - totalNeeded;
  db.prepare('UPDATE wallets SET balance = ? WHERE id = ?').run(newBalance, wallet.id);
  db.prepare(`INSERT INTO wallet_transactions (id, wallet_id, type, amount, description, reference, balance_after)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(uuidv4(), wallet.id, 'escrow_lock', -totalNeeded, `Escrow funded: ${tx.title}`, tx.id, newBalance);

  db.prepare('UPDATE transactions SET status = ?, funded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run('funded', tx.id);

  const sellerId = tx.initiator_role === 'seller' ? tx.initiator_id : tx.counterparty_id;
  notify(db, sellerId, 'Escrow Funded!', `Funds are secured for "${tx.title}". Deliver the goods/service and mark as shipped.`, 'success', tx.id);
  notify(db, req.user.id, 'Escrow Funded', `$${tx.amount.toFixed(2)} is now held in escrow for "${tx.title}".`, 'success', tx.id);

  const updated = db.prepare('SELECT * FROM transactions WHERE id = ?').get(tx.id);
  res.json(enrichTransaction(db, updated));
});

// Mark as shipped (seller)
router.post('/:id/ship', authMiddleware, (req, res) => {
  const { tracking_info } = req.body;
  const db = getDb();
  const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
  if (!tx) return res.status(404).json({ error: 'Not found' });

  const sellerId = tx.initiator_role === 'seller' ? tx.initiator_id : tx.counterparty_id;
  if (req.user.id !== sellerId) return res.status(403).json({ error: 'Only the seller can mark as shipped' });
  if (tx.status !== 'funded') return res.status(400).json({ error: 'Transaction must be funded first' });

  db.prepare('UPDATE transactions SET status = ?, shipped_at = CURRENT_TIMESTAMP, tracking_info = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run('shipped', tracking_info || '', tx.id);

  const buyerId = tx.initiator_role === 'buyer' ? tx.initiator_id : tx.counterparty_id;
  notify(db, buyerId, 'Item Shipped!', `"${tx.title}" has been shipped. Inspect and approve within ${tx.inspection_days} days.`, 'info', tx.id);

  const updated = db.prepare('SELECT * FROM transactions WHERE id = ?').get(tx.id);
  res.json(enrichTransaction(db, updated));
});

// Approve & release funds (buyer)
router.post('/:id/approve', authMiddleware, (req, res) => {
  const db = getDb();
  const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
  if (!tx) return res.status(404).json({ error: 'Not found' });

  const buyerId = tx.initiator_role === 'buyer' ? tx.initiator_id : tx.counterparty_id;
  if (req.user.id !== buyerId) return res.status(403).json({ error: 'Only the buyer can approve' });
  if (!['funded','shipped'].includes(tx.status)) return res.status(400).json({ error: 'Cannot approve at this stage' });

  const sellerId = tx.initiator_role === 'seller' ? tx.initiator_id : tx.counterparty_id;
  const sellerWallet = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(sellerId);
  const payout = tx.amount; // fee already deducted when funding
  const newSellerBalance = sellerWallet.balance + payout;

  db.prepare('UPDATE wallets SET balance = ? WHERE id = ?').run(newSellerBalance, sellerWallet.id);
  db.prepare(`INSERT INTO wallet_transactions (id, wallet_id, type, amount, description, reference, balance_after)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(uuidv4(), sellerWallet.id, 'escrow_release', payout, `Escrow released: ${tx.title}`, tx.id, newSellerBalance);

  db.prepare('UPDATE transactions SET status = ?, approved_at = CURRENT_TIMESTAMP, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run('completed', tx.id);

  notify(db, sellerId, '💰 Funds Released!', `$${payout.toFixed(2)} has been released to your wallet for "${tx.title}".`, 'success', tx.id);
  notify(db, buyerId, 'Transaction Complete', `You've approved "${tx.title}". The deal is complete!`, 'success', tx.id);

  const updated = db.prepare('SELECT * FROM transactions WHERE id = ?').get(tx.id);
  res.json(enrichTransaction(db, updated));
});

// Raise dispute
router.post('/:id/dispute', authMiddleware, (req, res) => {
  const { reason } = req.body;
  if (!reason) return res.status(400).json({ error: 'Dispute reason required' });

  const db = getDb();
  const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
  if (!tx) return res.status(404).json({ error: 'Not found' });
  if (tx.initiator_id !== req.user.id && tx.counterparty_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });
  if (!['funded','shipped'].includes(tx.status)) return res.status(400).json({ error: 'Cannot dispute at this stage' });

  db.prepare('UPDATE transactions SET status = ?, disputed_at = CURRENT_TIMESTAMP, dispute_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run('disputed', reason, tx.id);

  const otherId = tx.initiator_id === req.user.id ? tx.counterparty_id : tx.initiator_id;
  if (otherId) notify(db, otherId, '⚠️ Dispute Raised', `A dispute has been opened on "${tx.title}". Our team will review within 48 hours.`, 'warning', tx.id);
  notify(db, req.user.id, 'Dispute Submitted', `Your dispute for "${tx.title}" is under review. We'll contact both parties.`, 'warning', tx.id);

  const updated = db.prepare('SELECT * FROM transactions WHERE id = ?').get(tx.id);
  res.json(enrichTransaction(db, updated));
});

// Cancel transaction
router.post('/:id/cancel', authMiddleware, (req, res) => {
  const db = getDb();
  const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
  if (!tx) return res.status(404).json({ error: 'Not found' });
  if (tx.initiator_id !== req.user.id) return res.status(403).json({ error: 'Only initiator can cancel' });
  if (!['draft','awaiting_counterparty','awaiting_funding'].includes(tx.status)) {
    return res.status(400).json({ error: 'Cannot cancel a funded transaction — raise a dispute instead' });
  }
  db.prepare('UPDATE transactions SET status = ?, cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run('cancelled', tx.id);
  res.json({ success: true });
});

// Send message
router.post('/:id/messages', authMiddleware, (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });

  const db = getDb();
  const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
  if (!tx) return res.status(404).json({ error: 'Not found' });
  if (tx.initiator_id !== req.user.id && tx.counterparty_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });

  if (message.length > 1000) return res.status(400).json({ error: 'Message too long (max 1000 characters)' });

  const msgId = uuidv4();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO transaction_messages (id, transaction_id, sender_id, message) VALUES (?, ?, ?, ?)')
    .run(msgId, tx.id, req.user.id, message.trim());

  const sender = db.prepare('SELECT id, first_name, last_name FROM users WHERE id = ?').get(req.user.id);
  res.status(201).json({
    id: msgId,
    transaction_id: tx.id,
    sender_id: req.user.id,
    message: message.trim(),
    type: 'chat',
    created_at: now,
    first_name: sender ? sender.first_name : '',
    last_name: sender ? sender.last_name : ''
  });
});

// Get notifications
router.get('/user/notifications', authMiddleware, (req, res) => {
  const db = getDb();
  const notifications = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 30').all(req.user.id);
  db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(req.user.id);
  res.json(notifications);
});

module.exports = router;
