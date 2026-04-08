const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getPool } = require('../database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
const ah = fn => (req, res, next) => fn(req, res, next).catch(next);

async function enrichFundraiser(db, f) {
  const { rows } = await db.query('SELECT id,first_name,last_name,email FROM users WHERE id = $1', [f.creator_id]);
  const creator = rows[0] || null;
  const goal   = parseFloat(f.goal_amount);
  const raised = parseFloat(f.raised_amount);
  const pct      = goal > 0 ? Math.min(100, Math.round((raised / goal) * 100)) : 0;
  const daysLeft = Math.max(0, Math.ceil((new Date(f.end_date) - Date.now()) / 864e5));
  return { ...f, goal_amount: goal, raised_amount: raised, creator, percent: pct, days_left: daysLeft };
}

// GET /api/fundraisers
router.get('/', ah(async (req, res) => {
  const db = getPool();
  const { rows } = await db.query("SELECT * FROM fundraisers WHERE status = 'active' ORDER BY created_at DESC");
  res.json(await Promise.all(rows.map(f => enrichFundraiser(db, f))));
}));

// GET /api/fundraisers/mine
router.get('/mine', authMiddleware, ah(async (req, res) => {
  const db = getPool();
  const { rows } = await db.query('SELECT * FROM fundraisers WHERE creator_id = $1 ORDER BY created_at DESC', [req.user.id]);
  res.json(await Promise.all(rows.map(f => enrichFundraiser(db, f))));
}));

// GET /api/fundraisers/:id
router.get('/:id', ah(async (req, res) => {
  const db = getPool();
  const { rows } = await db.query('SELECT * FROM fundraisers WHERE id = $1', [req.params.id]);
  const f = rows[0];
  if (!f) return res.status(404).json({ error: 'Campaign not found' });

  const { rows: donations } = await db.query(
    `SELECT fd.*,
       CASE WHEN fd.anonymous THEN 'Anonymous'
            ELSE TRIM(u.first_name || ' ' || u.last_name)
       END AS donor_name
     FROM fundraiser_donations fd
     LEFT JOIN users u ON fd.donor_id = u.id
     WHERE fd.fundraiser_id = $1
     ORDER BY fd.created_at DESC`,
    [f.id]
  );
  res.json({ ...(await enrichFundraiser(db, f)), donations });
}));

// POST /api/fundraisers/create
router.post('/create', authMiddleware, ah(async (req, res) => {
  const { title, description, goal_amount, category, organization_name, end_date } = req.body;
  if (!title || !goal_amount || !end_date)
    return res.status(400).json({ error: 'Title, goal amount, and end date required' });
  if (parseFloat(goal_amount) <= 0)
    return res.status(400).json({ error: 'Goal must be greater than 0' });
  if (new Date(end_date) <= new Date())
    return res.status(400).json({ error: 'End date must be in the future' });

  const db = getPool();
  const id = uuidv4();
  await db.query(
    `INSERT INTO fundraisers
      (id,title,description,goal_amount,currency,category,creator_id,organization_name,end_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, title.trim(), description || '', parseFloat(goal_amount), 'GHS',
     category || 'other', req.user.id, organization_name || '', end_date]
  );
  await db.query(
    'INSERT INTO notifications (id,user_id,title,message,type) VALUES ($1,$2,$3,$4,$5)',
    [uuidv4(), req.user.id, 'Campaign Created!', `Your fundraiser "${title}" is now live.`, 'success']
  );

  const { rows } = await db.query('SELECT * FROM fundraisers WHERE id = $1', [id]);
  res.status(201).json(await enrichFundraiser(db, rows[0]));
}));

// POST /api/fundraisers/:id/donate
router.post('/:id/donate', authMiddleware, ah(async (req, res) => {
  const { message, anonymous } = req.body;
  const amount = parseFloat(req.body.amount);
  if (!amount || isNaN(amount) || amount <= 0)
    return res.status(400).json({ error: 'Valid amount required' });

  const db = getPool();
  const { rows: fRows } = await db.query('SELECT * FROM fundraisers WHERE id = $1', [req.params.id]);
  const f = fRows[0];
  if (!f) return res.status(404).json({ error: 'Campaign not found' });
  if (f.status !== 'active') return res.status(400).json({ error: 'Campaign is no longer active' });
  if (new Date(f.end_date) < new Date()) return res.status(400).json({ error: 'Campaign has ended' });

  const { rows: wRows } = await db.query('SELECT * FROM wallets WHERE user_id = $1', [req.user.id]);
  const wallet = wRows[0];
  if (!wallet || parseFloat(wallet.balance) < amount)
    return res.status(400).json({ error: `Insufficient balance. You need ₵${amount.toFixed(2)}` });

  const newBalance = parseFloat(wallet.balance) - amount;
  await db.query('UPDATE wallets SET balance=$1 WHERE id=$2', [newBalance, wallet.id]);
  await db.query(
    'INSERT INTO wallet_transactions (id,wallet_id,type,amount,description,reference,balance_after) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [uuidv4(), wallet.id, 'donation', -amount, `Donation to: ${f.title}`, f.id, newBalance]
  );
  await db.query(
    'INSERT INTO fundraiser_donations (id,fundraiser_id,donor_id,amount,message,anonymous) VALUES ($1,$2,$3,$4,$5,$6)',
    [uuidv4(), f.id, req.user.id, amount, message || '', !!anonymous]
  );

  const newRaised = parseFloat(f.raised_amount) + amount;
  const newCount  = parseInt(f.donor_count) + 1;
  await db.query('UPDATE fundraisers SET raised_amount=$1, donor_count=$2, updated_at=NOW() WHERE id=$3',
    [newRaised, newCount, f.id]);

  const { rows: dRows } = await db.query('SELECT first_name,last_name FROM users WHERE id = $1', [req.user.id]);
  const donor = dRows[0];
  const donorName = anonymous ? 'Someone' : `${donor?.first_name} ${donor?.last_name}`;
  await db.query(
    'INSERT INTO notifications (id,user_id,title,message,type) VALUES ($1,$2,$3,$4,$5)',
    [uuidv4(), f.creator_id, 'New Donation!', `${donorName} donated ₵${amount.toFixed(2)} to "${f.title}".`, 'success']
  );

  if (newRaised >= parseFloat(f.goal_amount)) {
    await db.query("UPDATE fundraisers SET status='completed', updated_at=NOW() WHERE id=$1", [f.id]);
    await db.query(
      'INSERT INTO notifications (id,user_id,title,message,type) VALUES ($1,$2,$3,$4,$5)',
      [uuidv4(), f.creator_id, '🎉 Goal Reached!', `Your campaign "${f.title}" has reached its fundraising goal!`, 'success']
    );
  }

  const { rows: updated } = await db.query('SELECT * FROM fundraisers WHERE id = $1', [f.id]);
  res.json({ balance: newBalance, fundraiser: await enrichFundraiser(db, updated[0]) });
}));

// POST /api/fundraisers/:id/close
router.post('/:id/close', authMiddleware, ah(async (req, res) => {
  const db = getPool();
  const { rows } = await db.query('SELECT * FROM fundraisers WHERE id = $1', [req.params.id]);
  const f = rows[0];
  if (!f) return res.status(404).json({ error: 'Campaign not found' });
  if (f.creator_id !== req.user.id) return res.status(403).json({ error: 'Only the campaign creator can close it' });
  await db.query("UPDATE fundraisers SET status='completed', updated_at=NOW() WHERE id=$1", [f.id]);
  res.json({ success: true });
}));

module.exports = router;
