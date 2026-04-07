const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

function enrichFundraiser(db, f) {
  const creator = db.prepare('SELECT id, first_name, last_name, email FROM users WHERE id = ?').get(f.creator_id);
  const pct = f.goal_amount > 0 ? Math.min(100, Math.round((f.raised_amount / f.goal_amount) * 100)) : 0;
  const daysLeft = Math.max(0, Math.ceil((new Date(f.end_date) - Date.now()) / 864e5));
  return { ...f, creator, percent: pct, days_left: daysLeft };
}

// GET /api/fundraisers — all active campaigns
router.get('/', (req, res) => {
  const db = getDb();
  const list = db.prepare('SELECT * FROM fundraisers').all();
  res.json(list.map(f => enrichFundraiser(db, f)));
});

// GET /api/fundraisers/mine — campaigns created by the logged-in user
router.get('/mine', authMiddleware, (req, res) => {
  const db = getDb();
  const list = db.prepare('SELECT * FROM fundraisers WHERE creator_id = ?').all(req.user.id);
  res.json(list.map(f => enrichFundraiser(db, f)));
});

// GET /api/fundraisers/:id — single campaign with donations
router.get('/:id', (req, res) => {
  const db = getDb();
  const f = db.prepare('SELECT * FROM fundraisers WHERE id = ?').get(req.params.id);
  if (!f) return res.status(404).json({ error: 'Campaign not found' });
  const donations = db.prepare('SELECT * FROM fundraiser_donations WHERE fundraiser_id = ?').all(f.id);
  res.json({ ...enrichFundraiser(db, f), donations });
});

// POST /api/fundraisers/create
router.post('/create', authMiddleware, (req, res) => {
  const { title, description, goal_amount, category, organization_name, end_date } = req.body;
  if (!title || !goal_amount || !end_date) return res.status(400).json({ error: 'Title, goal amount, and end date required' });
  if (parseFloat(goal_amount) <= 0) return res.status(400).json({ error: 'Goal must be greater than 0' });
  if (new Date(end_date) <= new Date()) return res.status(400).json({ error: 'End date must be in the future' });

  const db = getDb();
  const id = uuidv4();
  db.prepare('INSERT INTO fundraisers (id,title,description,goal_amount,currency,category,creator_id,organization_name,end_date) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, title.trim(), description || '', parseFloat(goal_amount), 'GHS', category || 'other', req.user.id, organization_name || '', end_date);

  db.prepare('INSERT INTO notifications (id,user_id,title,message,type,transaction_id) VALUES (?,?,?,?,?,?)')
    .run(uuidv4(), req.user.id, 'Campaign Created!', `Your fundraiser "${title}" is now live.`, 'success', null);

  const f = db.prepare('SELECT * FROM fundraisers WHERE id = ?').get(id);
  res.status(201).json(enrichFundraiser(db, f));
});

// POST /api/fundraisers/:id/donate
router.post('/:id/donate', authMiddleware, (req, res) => {
  const { message, anonymous } = req.body;
  const amount = parseFloat(req.body.amount);
  if (!amount || isNaN(amount) || amount <= 0) return res.status(400).json({ error: 'Valid amount required' });

  const db = getDb();
  const f = db.prepare('SELECT * FROM fundraisers WHERE id = ?').get(req.params.id);
  if (!f) return res.status(404).json({ error: 'Campaign not found' });
  if (f.status !== 'active') return res.status(400).json({ error: 'Campaign is no longer active' });
  if (new Date(f.end_date) < new Date()) return res.status(400).json({ error: 'Campaign has ended' });

  const wallet = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(req.user.id);
  if (!wallet || wallet.balance < amount) return res.status(400).json({ error: `Insufficient balance. You need ${amount.toFixed(2)} GHS` });

  // Deduct from donor wallet
  const newBalance = wallet.balance - amount;
  db.prepare('UPDATE wallets SET balance = ? WHERE id = ?').run(newBalance, wallet.id);
  db.prepare('INSERT INTO wallet_transactions (id,wallet_id,type,amount,description,reference,balance_after) VALUES (?,?,?,?,?,?,?)')
    .run(uuidv4(), wallet.id, 'donation', -amount, `Donation to: ${f.title}`, f.id, newBalance);

  // Record donation
  db.prepare('INSERT INTO fundraiser_donations (id,fundraiser_id,donor_id,amount,message,anonymous) VALUES (?,?,?,?,?,?)')
    .run(uuidv4(), f.id, req.user.id, amount, message || '', anonymous ? 1 : 0);

  // Update fundraiser totals
  const newRaised = f.raised_amount + amount;
  const newCount = f.donor_count + 1;
  db.prepare('UPDATE fundraisers SET raised_amount = ?, donor_count = ? WHERE id = ?').run(newRaised, newCount, f.id);

  // Notify creator
  const donor = db.prepare('SELECT first_name, last_name FROM users WHERE id = ?').get(req.user.id);
  const donorName = anonymous ? 'Someone' : `${donor?.first_name} ${donor?.last_name}`;
  db.prepare('INSERT INTO notifications (id,user_id,title,message,type,transaction_id) VALUES (?,?,?,?,?,?)')
    .run(uuidv4(), f.creator_id, 'New Donation!', `${donorName} donated ₵${amount.toFixed(2)} to "${f.title}".`, 'success', null);

  // Auto-complete if goal reached
  if (newRaised >= f.goal_amount) {
    db.prepare('UPDATE fundraisers SET status = ? WHERE id = ?').run('completed', f.id);
    db.prepare('INSERT INTO notifications (id,user_id,title,message,type,transaction_id) VALUES (?,?,?,?,?,?)')
      .run(uuidv4(), f.creator_id, '🎉 Goal Reached!', `Your campaign "${f.title}" has reached its fundraising goal!`, 'success', null);
  }

  const updated = db.prepare('SELECT * FROM fundraisers WHERE id = ?').get(f.id);
  res.json({ balance: newBalance, fundraiser: enrichFundraiser(db, updated) });
});

// POST /api/fundraisers/:id/close — creator closes campaign
router.post('/:id/close', authMiddleware, (req, res) => {
  const db = getDb();
  const f = db.prepare('SELECT * FROM fundraisers WHERE id = ?').get(req.params.id);
  if (!f) return res.status(404).json({ error: 'Campaign not found' });
  if (f.creator_id !== req.user.id) return res.status(403).json({ error: 'Only the campaign creator can close it' });
  db.prepare('UPDATE fundraisers SET status = ? WHERE id = ?').run('completed', f.id);
  res.json({ success: true });
});

module.exports = router;
