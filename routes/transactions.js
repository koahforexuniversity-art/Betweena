const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getPool } = require('../database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
const ah = fn => (req, res, next) => fn(req, res, next).catch(next);

function calcFee(amount) {
  if (amount <= 15000)  return amount * 0.035;
  if (amount <= 150000) return amount * 0.0225;
  return Math.min(amount * 0.015, 7500);
}

async function getUserById(db, id) {
  if (!id) return null;
  const { rows } = await db.query('SELECT id,first_name,last_name,email FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

async function enrichTransaction(db, tx) {
  const [initiator, counterparty] = await Promise.all([
    getUserById(db, tx.initiator_id),
    getUserById(db, tx.counterparty_id),
  ]);
  return {
    ...tx,
    amount: parseFloat(tx.amount),
    fee_amount: parseFloat(tx.fee_amount || 0),
    initiator,
    counterparty,
  };
}

async function notify(db, userId, title, message, type, txId) {
  await db.query(
    'INSERT INTO notifications (id,user_id,title,message,type,transaction_id) VALUES ($1,$2,$3,$4,$5,$6)',
    [uuidv4(), userId, title, message, type || 'info', txId || null]
  );
}

// GET /api/transactions
router.get('/', authMiddleware, ah(async (req, res) => {
  const db = getPool();
  const { rows } = await db.query(
    'SELECT * FROM transactions WHERE initiator_id=$1 OR counterparty_id=$1 ORDER BY created_at DESC',
    [req.user.id]
  );
  const enriched = await Promise.all(rows.map(tx => enrichTransaction(db, tx)));
  res.json(enriched);
}));

// GET /api/transactions/stats
router.get('/stats', authMiddleware, ah(async (req, res) => {
  const db = getPool();
  const { rows } = await db.query(
    'SELECT * FROM transactions WHERE initiator_id=$1 OR counterparty_id=$1',
    [req.user.id]
  );
  const all = rows.map(t => ({ ...t, amount: parseFloat(t.amount), fee_amount: parseFloat(t.fee_amount || 0) }));
  const inEscrow   = all.filter(t => ['funded','shipped'].includes(t.status)).reduce((s,t) => s + t.amount, 0);
  const released   = all.filter(t => t.status === 'completed').reduce((s,t) => s + t.amount, 0);
  const active     = all.filter(t => !['completed','cancelled'].includes(t.status)).length;
  const disputes   = all.filter(t => t.status === 'disputed').length;
  const feesTotal  = all.filter(t => t.status === 'completed').reduce((s,t) => s + t.fee_amount, 0);
  res.json({ in_escrow: inEscrow, total_released: released, active_count: active, dispute_count: disputes, total_fees_paid: feesTotal, total_transactions: all.length });
}));

// GET /api/transactions/:id
router.get('/:id', authMiddleware, ah(async (req, res) => {
  const db = getPool();
  const { rows } = await db.query('SELECT * FROM transactions WHERE id = $1', [req.params.id]);
  const tx = rows[0];
  if (!tx) return res.status(404).json({ error: 'Transaction not found' });
  if (tx.initiator_id !== req.user.id && tx.counterparty_id !== req.user.id)
    return res.status(403).json({ error: 'Not authorized' });

  const { rows: msgs } = await db.query(
    `SELECT tm.*, u.first_name, u.last_name
     FROM transaction_messages tm
     JOIN users u ON tm.sender_id = u.id
     WHERE tm.transaction_id = $1 ORDER BY tm.created_at ASC`,
    [req.params.id]
  );
  res.json({ ...(await enrichTransaction(db, tx)), messages: msgs });
}));

// POST /api/transactions/create
router.post('/create', authMiddleware, ah(async (req, res) => {
  const { title, description, amount, category, initiator_role, counterparty_email, inspection_days, notes } = req.body;
  if (!title || !amount || !initiator_role) return res.status(400).json({ error: 'Title, amount, and role required' });
  if (amount <= 0 || amount > 500000) return res.status(400).json({ error: 'Amount must be between ₵1 and ₵500,000' });

  const db = getPool();
  const joinCode = Math.random().toString(36).substr(2, 8).toUpperCase();
  const txId = uuidv4();
  const fee = calcFee(parseFloat(amount));

  let counterpartyId = null, status = 'awaiting_counterparty';
  if (counterparty_email) {
    const { rows: cp } = await db.query('SELECT id FROM users WHERE email = $1', [counterparty_email.toLowerCase()]);
    if (cp[0]) { counterpartyId = cp[0].id; status = 'awaiting_funding'; }
  }

  await db.query(
    `INSERT INTO transactions
      (id,title,description,amount,category,initiator_id,initiator_role,counterparty_id,
       counterparty_email,join_code,fee_amount,fee_rate,inspection_days,notes,status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [txId, title.trim(), description || '', parseFloat(amount), category || 'goods',
     req.user.id, initiator_role, counterpartyId, counterparty_email || null,
     joinCode, fee, fee / parseFloat(amount), parseInt(inspection_days) || 3, notes || '', status]
  );

  if (counterpartyId) {
    await notify(db, counterpartyId, 'New Escrow Invitation',
      `You've been invited to a ₵${parseFloat(amount).toFixed(2)} escrow: "${title}"`, 'info', txId);
  }
  await notify(db, req.user.id, 'Transaction Created',
    `Your escrow for "${title}" is ready. Share code: ${joinCode}`, 'success', txId);

  const { rows: created } = await db.query('SELECT * FROM transactions WHERE id = $1', [txId]);
  res.status(201).json(await enrichTransaction(db, created[0]));
}));

// POST /api/transactions/join
router.post('/join', authMiddleware, ah(async (req, res) => {
  const { join_code } = req.body;
  if (!join_code) return res.status(400).json({ error: 'Join code required' });

  const db = getPool();
  const { rows } = await db.query('SELECT * FROM transactions WHERE join_code = $1', [join_code.toUpperCase()]);
  const tx = rows[0];
  if (!tx) return res.status(404).json({ error: 'Invalid join code' });
  if (tx.initiator_id === req.user.id) return res.status(400).json({ error: 'You created this transaction' });
  if (tx.counterparty_id && tx.counterparty_id !== req.user.id) return res.status(400).json({ error: 'Transaction already has a counterparty' });
  if (tx.status !== 'awaiting_counterparty') return res.status(400).json({ error: 'Transaction cannot be joined at this stage' });

  await db.query('UPDATE transactions SET counterparty_id=$1, status=$2, updated_at=NOW() WHERE id=$3',
    [req.user.id, 'awaiting_funding', tx.id]);
  await notify(db, tx.initiator_id, 'Counterparty Joined!',
    `Someone joined your escrow: "${tx.title}". It's ready to be funded.`, 'success', tx.id);
  await notify(db, req.user.id, 'Joined Escrow',
    `You've joined the escrow: "${tx.title}". Waiting for funds.`, 'info', tx.id);

  const { rows: updated } = await db.query('SELECT * FROM transactions WHERE id = $1', [tx.id]);
  res.json(await enrichTransaction(db, updated[0]));
}));

// POST /api/transactions/:id/fund
router.post('/:id/fund', authMiddleware, ah(async (req, res) => {
  const db = getPool();
  const { rows } = await db.query('SELECT * FROM transactions WHERE id = $1', [req.params.id]);
  const tx = rows[0];
  if (!tx) return res.status(404).json({ error: 'Not found' });

  const buyerId = tx.initiator_role === 'buyer' ? tx.initiator_id : tx.counterparty_id;
  if (req.user.id !== buyerId) return res.status(403).json({ error: 'Only the buyer funds this escrow' });
  if (tx.status !== 'awaiting_funding') return res.status(400).json({ error: 'Transaction cannot be funded at this stage' });

  const { rows: wRows } = await db.query('SELECT * FROM wallets WHERE user_id = $1', [req.user.id]);
  const wallet = wRows[0];
  const totalNeeded = parseFloat(tx.amount) + parseFloat(tx.fee_amount);
  if (parseFloat(wallet.balance) < totalNeeded)
    return res.status(400).json({ error: `Insufficient balance. Need ₵${totalNeeded.toFixed(2)} (amount + fee)` });

  const newBalance = parseFloat(wallet.balance) - totalNeeded;
  await db.query('UPDATE wallets SET balance=$1 WHERE id=$2', [newBalance, wallet.id]);
  await db.query(
    'INSERT INTO wallet_transactions (id,wallet_id,type,amount,description,reference,balance_after) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [uuidv4(), wallet.id, 'escrow_lock', -totalNeeded, `Escrow funded: ${tx.title}`, tx.id, newBalance]
  );
  await db.query('UPDATE transactions SET status=$1, funded_at=NOW(), updated_at=NOW() WHERE id=$2', ['funded', tx.id]);

  const sellerId = tx.initiator_role === 'seller' ? tx.initiator_id : tx.counterparty_id;
  await notify(db, sellerId, 'Escrow Funded!',
    `Funds are secured for "${tx.title}". Deliver and mark as shipped.`, 'success', tx.id);
  await notify(db, req.user.id, 'Escrow Funded',
    `₵${parseFloat(tx.amount).toFixed(2)} is now held in escrow for "${tx.title}".`, 'success', tx.id);

  const { rows: updated } = await db.query('SELECT * FROM transactions WHERE id = $1', [tx.id]);
  res.json(await enrichTransaction(db, updated[0]));
}));

// POST /api/transactions/:id/ship
router.post('/:id/ship', authMiddleware, ah(async (req, res) => {
  const { tracking_info } = req.body;
  const db = getPool();
  const { rows } = await db.query('SELECT * FROM transactions WHERE id = $1', [req.params.id]);
  const tx = rows[0];
  if (!tx) return res.status(404).json({ error: 'Not found' });

  const sellerId = tx.initiator_role === 'seller' ? tx.initiator_id : tx.counterparty_id;
  if (req.user.id !== sellerId) return res.status(403).json({ error: 'Only the seller can mark as shipped' });
  if (tx.status !== 'funded') return res.status(400).json({ error: 'Transaction must be funded first' });

  await db.query('UPDATE transactions SET status=$1, shipped_at=NOW(), tracking_info=$2, updated_at=NOW() WHERE id=$3',
    ['shipped', tracking_info || '', tx.id]);

  const buyerId = tx.initiator_role === 'buyer' ? tx.initiator_id : tx.counterparty_id;
  await notify(db, buyerId, 'Item Shipped!',
    `"${tx.title}" has been shipped. Inspect and approve within ${tx.inspection_days} days.`, 'info', tx.id);

  const { rows: updated } = await db.query('SELECT * FROM transactions WHERE id = $1', [tx.id]);
  res.json(await enrichTransaction(db, updated[0]));
}));

// POST /api/transactions/:id/approve
router.post('/:id/approve', authMiddleware, ah(async (req, res) => {
  const db = getPool();
  const { rows } = await db.query('SELECT * FROM transactions WHERE id = $1', [req.params.id]);
  const tx = rows[0];
  if (!tx) return res.status(404).json({ error: 'Not found' });

  const buyerId = tx.initiator_role === 'buyer' ? tx.initiator_id : tx.counterparty_id;
  if (req.user.id !== buyerId) return res.status(403).json({ error: 'Only the buyer can approve' });
  if (!['funded','shipped'].includes(tx.status)) return res.status(400).json({ error: 'Cannot approve at this stage' });

  const sellerId = tx.initiator_role === 'seller' ? tx.initiator_id : tx.counterparty_id;
  const { rows: wRows } = await db.query('SELECT * FROM wallets WHERE user_id = $1', [sellerId]);
  const sellerWallet = wRows[0];
  const payout = parseFloat(tx.amount);
  const newSellerBalance = parseFloat(sellerWallet.balance) + payout;

  await db.query('UPDATE wallets SET balance=$1 WHERE id=$2', [newSellerBalance, sellerWallet.id]);
  await db.query(
    'INSERT INTO wallet_transactions (id,wallet_id,type,amount,description,reference,balance_after) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [uuidv4(), sellerWallet.id, 'escrow_release', payout, `Escrow released: ${tx.title}`, tx.id, newSellerBalance]
  );
  await db.query('UPDATE transactions SET status=$1, approved_at=NOW(), completed_at=NOW(), updated_at=NOW() WHERE id=$2',
    ['completed', tx.id]);

  await notify(db, sellerId, '💰 Funds Released!',
    `₵${payout.toFixed(2)} has been released to your wallet for "${tx.title}".`, 'success', tx.id);
  await notify(db, buyerId, 'Transaction Complete',
    `You've approved "${tx.title}". The deal is complete!`, 'success', tx.id);

  const { rows: updated } = await db.query('SELECT * FROM transactions WHERE id = $1', [tx.id]);
  res.json(await enrichTransaction(db, updated[0]));
}));

// POST /api/transactions/:id/dispute
router.post('/:id/dispute', authMiddleware, ah(async (req, res) => {
  const { reason } = req.body;
  if (!reason) return res.status(400).json({ error: 'Dispute reason required' });

  const db = getPool();
  const { rows } = await db.query('SELECT * FROM transactions WHERE id = $1', [req.params.id]);
  const tx = rows[0];
  if (!tx) return res.status(404).json({ error: 'Not found' });
  if (tx.initiator_id !== req.user.id && tx.counterparty_id !== req.user.id)
    return res.status(403).json({ error: 'Not authorized' });
  if (!['funded','shipped'].includes(tx.status))
    return res.status(400).json({ error: 'Cannot dispute at this stage' });

  await db.query('UPDATE transactions SET status=$1, disputed_at=NOW(), dispute_reason=$2, updated_at=NOW() WHERE id=$3',
    ['disputed', reason, tx.id]);

  const otherId = tx.initiator_id === req.user.id ? tx.counterparty_id : tx.initiator_id;
  if (otherId) await notify(db, otherId, '⚠️ Dispute Raised',
    `A dispute has been opened on "${tx.title}". Our team will review within 48 hours.`, 'warning', tx.id);
  await notify(db, req.user.id, 'Dispute Submitted',
    `Your dispute for "${tx.title}" is under review. We'll contact both parties.`, 'warning', tx.id);

  const { rows: updated } = await db.query('SELECT * FROM transactions WHERE id = $1', [tx.id]);
  res.json(await enrichTransaction(db, updated[0]));
}));

// POST /api/transactions/:id/cancel
router.post('/:id/cancel', authMiddleware, ah(async (req, res) => {
  const db = getPool();
  const { rows } = await db.query('SELECT * FROM transactions WHERE id = $1', [req.params.id]);
  const tx = rows[0];
  if (!tx) return res.status(404).json({ error: 'Not found' });
  if (tx.initiator_id !== req.user.id) return res.status(403).json({ error: 'Only initiator can cancel' });
  if (!['draft','awaiting_counterparty','awaiting_funding'].includes(tx.status))
    return res.status(400).json({ error: 'Cannot cancel a funded transaction — raise a dispute instead' });

  await db.query('UPDATE transactions SET status=$1, cancelled_at=NOW(), updated_at=NOW() WHERE id=$2',
    ['cancelled', tx.id]);
  res.json({ success: true });
}));

// POST /api/transactions/:id/messages
router.post('/:id/messages', authMiddleware, ah(async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });
  if (message.length > 1000) return res.status(400).json({ error: 'Message too long (max 1000 characters)' });

  const db = getPool();
  const { rows } = await db.query('SELECT * FROM transactions WHERE id = $1', [req.params.id]);
  const tx = rows[0];
  if (!tx) return res.status(404).json({ error: 'Not found' });
  if (tx.initiator_id !== req.user.id && tx.counterparty_id !== req.user.id)
    return res.status(403).json({ error: 'Not authorized' });

  const msgId = uuidv4();
  const now = new Date().toISOString();
  await db.query('INSERT INTO transaction_messages (id,transaction_id,sender_id,message) VALUES ($1,$2,$3,$4)',
    [msgId, tx.id, req.user.id, message.trim()]);

  const { rows: sRows } = await db.query('SELECT id,first_name,last_name FROM users WHERE id = $1', [req.user.id]);
  const sender = sRows[0];
  res.status(201).json({
    id: msgId, transaction_id: tx.id, sender_id: req.user.id,
    message: message.trim(), type: 'chat', created_at: now,
    first_name: sender?.first_name || '', last_name: sender?.last_name || '',
  });
}));

// GET /api/transactions/user/notifications
router.get('/user/notifications', authMiddleware, ah(async (req, res) => {
  const db = getPool();
  const { rows } = await db.query(
    'SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30',
    [req.user.id]
  );
  await db.query('UPDATE notifications SET read = 1 WHERE user_id = $1', [req.user.id]);
  res.json(rows);
}));

module.exports = router;
