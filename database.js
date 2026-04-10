const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

let pool;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    });
  }
  return pool;
}

async function createTables() {
  const db = getPool();
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            UUID PRIMARY KEY,
      first_name    TEXT NOT NULL,
      last_name     TEXT NOT NULL,
      email         TEXT UNIQUE NOT NULL,
      phone         TEXT,
      password_hash TEXT NOT NULL,
      kyc_status    TEXT DEFAULT 'verified',
      role          TEXT DEFAULT 'user',
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS wallets (
      id         UUID PRIMARY KEY,
      user_id    UUID REFERENCES users(id),
      balance    NUMERIC(15,2) DEFAULT 0,
      currency   TEXT DEFAULT 'GHS',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id            UUID PRIMARY KEY,
      wallet_id     UUID REFERENCES wallets(id),
      type          TEXT NOT NULL,
      amount        NUMERIC(15,2) NOT NULL,
      description   TEXT,
      reference     TEXT,
      balance_after NUMERIC(15,2),
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id                 UUID PRIMARY KEY,
      title              TEXT NOT NULL,
      description        TEXT,
      amount             NUMERIC(15,2) NOT NULL,
      currency           TEXT DEFAULT 'GHS',
      category           TEXT,
      initiator_id       UUID REFERENCES users(id),
      initiator_role     TEXT,
      counterparty_id    UUID REFERENCES users(id),
      counterparty_email TEXT,
      join_code          TEXT UNIQUE,
      status             TEXT DEFAULT 'awaiting_counterparty',
      fee_amount         NUMERIC(15,2),
      fee_rate           NUMERIC(10,6),
      inspection_days    INTEGER DEFAULT 3,
      notes              TEXT,
      tracking_info      TEXT,
      funded_at          TIMESTAMPTZ,
      shipped_at         TIMESTAMPTZ,
      delivered_at       TIMESTAMPTZ,
      approved_at        TIMESTAMPTZ,
      disputed_at        TIMESTAMPTZ,
      completed_at       TIMESTAMPTZ,
      cancelled_at       TIMESTAMPTZ,
      dispute_reason     TEXT,
      dispute_resolution TEXT,
      created_at         TIMESTAMPTZ DEFAULT NOW(),
      updated_at         TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS transaction_messages (
      id             UUID PRIMARY KEY,
      transaction_id UUID REFERENCES transactions(id),
      sender_id      UUID REFERENCES users(id),
      message        TEXT NOT NULL,
      type           TEXT DEFAULT 'chat',
      created_at     TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id             UUID PRIMARY KEY,
      user_id        UUID REFERENCES users(id),
      title          TEXT NOT NULL,
      message        TEXT NOT NULL,
      type           TEXT DEFAULT 'info',
      transaction_id UUID,
      read           INTEGER DEFAULT 0,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS fundraisers (
      id                UUID PRIMARY KEY,
      title             TEXT NOT NULL,
      description       TEXT,
      goal_amount       NUMERIC(15,2) NOT NULL,
      raised_amount     NUMERIC(15,2) DEFAULT 0,
      currency          TEXT DEFAULT 'GHS',
      category          TEXT,
      creator_id        UUID REFERENCES users(id),
      organization_name TEXT,
      end_date          TIMESTAMPTZ,
      status            TEXT DEFAULT 'active',
      donor_count       INTEGER DEFAULT 0,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS fundraiser_donations (
      id            UUID PRIMARY KEY,
      fundraiser_id UUID REFERENCES fundraisers(id),
      donor_id      UUID REFERENCES users(id),
      amount        NUMERIC(15,2) NOT NULL,
      message       TEXT,
      anonymous     BOOLEAN DEFAULT FALSE,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  // Migrations — safe to run on every startup
  await db.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS otp_code TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS otp_expires_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_id_type TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_id_number TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_dob DATE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_submitted_at TIMESTAMPTZ;
  `);
}

function calcSeedFee(amount) {
  if (amount <= 15000)  return amount * 0.035;
  if (amount <= 150000) return amount * 0.0225;
  return Math.min(amount * 0.015, 7500);
}

async function initDb() {
  const db = getPool();
  await createTables();

  const { rows } = await db.query('SELECT COUNT(*) FROM users');
  if (parseInt(rows[0].count) > 0) return; // already seeded

  const hash = bcrypt.hashSync('demo1234', 10);
  const did = uuidv4(), sid = uuidv4();

  await db.query(
    'INSERT INTO users (id,first_name,last_name,email,phone,password_hash,kyc_status) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [did, 'Kwame', 'Asante', 'demo@betweena.com', '+233201234567', hash, 'verified']
  );
  await db.query('INSERT INTO wallets (id,user_id,balance) VALUES ($1,$2,$3)', [uuidv4(), did, 37500.00]);

  await db.query(
    'INSERT INTO users (id,first_name,last_name,email,phone,password_hash,kyc_status) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [sid, 'Ama', 'Darko', 'seller@betweena.com', '+233209876543', hash, 'verified']
  );
  await db.query('INSERT INTO wallets (id,user_id,balance) VALUES ($1,$2,$3)', [uuidv4(), sid, 12000.00]);

  const seeds = [
    { title: 'iPhone 15 Pro — Private Sale',   amount: 12750,  status: 'funded',               counter: sid,  role: 'buyer', cat: 'electronics' },
    { title: 'Logo Design — Freelance Project', amount: 4800,   status: 'completed',             counter: sid,  role: 'buyer', cat: 'services'    },
    { title: 'Toyota Camry 2019 — Vehicle',    amount: 107500, status: 'disputed',              counter: sid,  role: 'buyer', cat: 'vehicles'    },
    { title: 'Bulk Fabric Order (500kg)',       amount: 46500,  status: 'awaiting_counterparty', counter: null, role: 'buyer', cat: 'goods'       },
  ];
  for (const s of seeds) {
    const tid = uuidv4(), jc = Math.random().toString(36).substr(2, 8).toUpperCase();
    const fee = calcSeedFee(s.amount);
    const ago = n => new Date(Date.now() - 864e5 * n).toISOString();
    await db.query(
      `INSERT INTO transactions
        (id,title,description,amount,currency,category,initiator_id,initiator_role,counterparty_id,
         join_code,status,fee_amount,fee_rate,inspection_days,notes,
         funded_at,disputed_at,completed_at,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [tid, s.title, '', s.amount, 'GHS', s.cat, did, s.role, s.counter || null, jc, s.status,
       fee, fee / s.amount, 3, '',
       ['funded','completed','disputed'].includes(s.status) ? ago(3) : null,
       s.status === 'disputed'  ? ago(2) : null,
       s.status === 'completed' ? ago(1) : null,
       ago(5), new Date().toISOString()]
    );
  }

  await db.query(
    'INSERT INTO notifications (id,user_id,title,message,type) VALUES ($1,$2,$3,$4,$5)',
    [uuidv4(), did, 'Welcome to Betweena!', 'Your account is set up. Add funds and start your first secure transaction.', 'success']
  );

  const fseeds = [
    { title: 'School Feeding Programme — Northern Ghana', org: 'Nkosuo Education Foundation',
      desc: 'Help us feed 500 schoolchildren daily so they stay in class and learn. Hunger is the #1 reason for school dropouts in our community.',
      goal: 75000,  cat: 'education', raised: 38250,  donors: 47,  days: 30 },
    { title: 'Clean Water Boreholes — Volta Region', org: 'WaterLife Ghana NGO',
      desc: 'Drilling 3 boreholes to bring safe drinking water to 3 villages that currently walk 8km daily to the nearest water source.',
      goal: 120000, cat: 'health',    raised: 62400,  donors: 89,  days: 45 },
    { title: 'Flood Relief — Accra Disaster Response', org: 'Ghana Red Crescent Aid',
      desc: 'Emergency relief for 1,200 families displaced by the recent Accra floods. Funds cover food, shelter kits, and hygiene supplies.',
      goal: 200000, cat: 'disaster',  raised: 184500, donors: 312, days: 15 },
  ];
  for (const fs of fseeds) {
    const fid = uuidv4();
    const end = new Date(Date.now() + fs.days * 864e5).toISOString();
    await db.query(
      `INSERT INTO fundraisers
        (id,title,description,goal_amount,raised_amount,currency,category,creator_id,organization_name,end_date,donor_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [fid, fs.title, fs.desc, fs.goal, fs.raised, 'GHS', fs.cat, sid, fs.org, end, fs.donors]
    );
  }

  console.log('✅ Seeded. Login: demo@betweena.com / demo1234');
}

module.exports = { getPool, initDb };
