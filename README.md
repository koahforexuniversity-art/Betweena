# Betweena MVP — Secure Escrow Platform

> **Protect every online transaction. Betweena holds funds until both parties are satisfied.**

---

## 🚀 Quick Start (5 minutes)

### Prerequisites
- Node.js v16+ ([download](https://nodejs.org))

### 1. Install & Run

```bash
# Navigate to project folder
cd betweena

# Install dependencies
npm install

# Start the server
npm start
```

### 2. Open in Browser
```
http://localhost:3000
```

### 3. Demo Login
| Field | Value |
|-------|-------|
| Email | demo@betweena.com |
| Password | demo1234 |

That's it. The database seeds automatically on first run.

---

## 📁 Project Structure

```
betweena/
├── server.js              # Express app entry point
├── database.js            # JSON database layer (zero native deps)
├── middleware/
│   └── auth.js            # JWT authentication middleware
├── routes/
│   ├── auth.js            # Register, login, profile
│   ├── wallet.js          # Deposit, withdraw, history
│   └── transactions.js    # Full escrow lifecycle
├── public/
│   └── index.html         # Complete SPA frontend
├── betweena.db.json        # Auto-created on first run
├── package.json
└── README.md
```

---

## 🔐 API Reference

### Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Create account |
| POST | `/api/auth/login` | Login, returns JWT |
| GET | `/api/auth/profile` | Get current user |
| PUT | `/api/auth/profile` | Update profile |

**All protected routes require:** `Authorization: Bearer <token>`

### Wallet

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/wallet` | Balance + transaction history |
| POST | `/api/wallet/deposit` | Add funds |
| POST | `/api/wallet/withdraw` | Withdraw funds |

**Deposit body:**
```json
{ "amount": 500, "method": "MTN Mobile Money" }
```

### Transactions (Escrow Lifecycle)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/transactions` | All user transactions |
| GET | `/api/transactions/stats` | Dashboard stats |
| GET | `/api/transactions/:id | Single transaction + messages |
| POST | `/api/transactions/create` | Create escrow |
| POST | `/api/transactions/join` | Join via code |
| POST | `/api/transactions/:id/fund` | Buyer funds escrow |
| POST | `/api/transactions/:id/ship` | Seller marks shipped |
| POST | `/api/transactions/:id/approve` | Buyer approves, releases funds |
| POST | `/api/transactions/:id/dispute` | Raise a dispute |
| POST | `/api/transactions/:id/cancel` | Cancel (pre-funding only) |
| POST | `/api/transactions/:id/messages` | Send chat message |
| GET | `/api/transactions/user/notifications` | Get & mark-read notifications |

**Create transaction body:**
```json
{
  "title": "iPhone 15 Pro — Private Sale",
  "description": "128GB, Space Black, excellent condition",
  "amount": 850,
  "category": "electronics",
  "initiator_role": "buyer",
  "counterparty_email": "seller@example.com",
  "inspection_days": 3
}
```

---

## 💸 Fee Structure

| Transaction Amount | Fee Rate |
|-------------------|----------|
| $0 – $1,000 | 3.5% |
| $1,001 – $10,000 | 2.25% |
| $10,001+ | 1.5% (max $500) |

Fees are deducted from the buyer when funding. Sellers receive the full transaction amount.

---

## 🔄 Escrow Lifecycle

```
CREATED → AWAITING COUNTERPARTY → AWAITING FUNDING → FUNDED → SHIPPED → APPROVED → COMPLETED
                                                          ↘                 ↘
                                                        CANCELLED         DISPUTED
```

| Status | Description |
|--------|-------------|
| `awaiting_counterparty` | Share join code, waiting for other party |
| `awaiting_funding` | Both parties joined, buyer needs to fund |
| `funded` | Money held securely in escrow |
| `shipped` | Seller has marked delivery |
| `completed` | Buyer approved, funds released to seller |
| `disputed` | Under mediation |
| `cancelled` | Cancelled before funding |

---

## 🏗️ Tech Stack

| Layer | Technology |
|-------|------------|
| Backend | Node.js + Express |
| Database | JSON file store (zero native deps) |
| Auth | JWT + bcryptjs |
| Frontend | Vanilla JS SPA (no framework) |
| Styling | Custom CSS (no framework) |

**Why JSON store?** Zero native compilation required — works on every OS and hosting platform without setup. Swap to PostgreSQL or MySQL for production (see Production Guide below).

---

## 🚢 Production Deployment Guide

### Option A: Railway (Recommended, free tier)
```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

### Option B: Render
1. Push to GitHub
2. Connect repo at render.com
3. Set: Build Command `npm install`, Start Command `npm start`

### Option C: VPS (Ubuntu)
```bash
# Install Node
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install nodejs

# Clone & run
git clone your-repo && cd betweena
npm install
npm install -g pm2
pm2 start server.js --name betweena
pm2 save && pm2 startup
```

### Environment Variables (Production)
Create a `.env` file:
```env
PORT=3000
JWT_SECRET=your-super-secret-key-change-this-in-production-minimum-32-chars
NODE_ENV=production
```

Update `server.js` to use `dotenv`:
```bash
npm install dotenv
# Add to top of server.js: require('dotenv').config();
```

---

## 🗄️ Upgrading to PostgreSQL

1. Install: `npm install pg`
2. Replace `database.js` with a PostgreSQL client
3. Use the SQL schema:

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  phone VARCHAR(50),
  password_hash TEXT NOT NULL,
  kyc_status VARCHAR(50) DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID UNIQUE REFERENCES users(id),
  balance DECIMAL(12,2) DEFAULT 0,
  currency VARCHAR(10) DEFAULT 'USD'
);

CREATE TABLE transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(500) NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  status VARCHAR(50) DEFAULT 'awaiting_counterparty',
  initiator_id UUID REFERENCES users(id),
  counterparty_id UUID REFERENCES users(id),
  join_code VARCHAR(20) UNIQUE,
  fee_amount DECIMAL(12,2),
  -- ... etc
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 🔮 Roadmap to Full Production

### Phase 1 (Now — MVP ✅)
- [x] User registration & login with JWT
- [x] Wallet (deposit, withdraw, balance)
- [x] Create escrow transaction
- [x] Join via code
- [x] Fund, ship, approve, dispute flow
- [x] In-transaction messaging
- [x] Notifications system
- [x] Responsive SPA frontend

### Phase 2 (Next 30 days)
- [ ] Email notifications (SendGrid/Nodemailer)
- [ ] Real payment gateway (Paystack for GHS/NGN, Stripe for USD)
- [ ] Mobile Money API integration (MTN, Vodafone, Airtel)
- [ ] KYC document upload (ID verification)
- [ ] Dispute admin panel
- [ ] PostgreSQL production database

### Phase 3 (60-90 days)
- [ ] Native iOS + Android apps
- [ ] Marketplace API (REST + webhooks)
- [ ] Milestone-based escrow for services
- [ ] Two-factor authentication (SMS OTP)
- [ ] Transaction export (PDF receipts)
- [ ] Multi-currency (GHS, NGN, KES, USD)

---

## 🌍 Payment Gateway Integration

### Paystack (Ghana/Nigeria)
```javascript
// npm install paystack
const Paystack = require('paystack')(process.env.PAYSTACK_SECRET);

// Initialize deposit
const response = await Paystack.transaction.initialize({
  email: user.email,
  amount: amount * 100, // kobo/pesewas
  callback_url: 'https://yourdomain.com/payment/callback'
});
// Redirect user to response.data.authorization_url
```

### Stripe (International)
```javascript
// npm install stripe
const stripe = require('stripe')(process.env.STRIPE_SECRET);

const session = await stripe.checkout.sessions.create({
  payment_method_types: ['card'],
  line_items: [{ price_data: { currency: 'usd', product_data: { name: 'Wallet Top-up' }, unit_amount: amount * 100 }, quantity: 1 }],
  mode: 'payment',
  success_url: 'https://yourdomain.com/wallet?success=true',
  cancel_url: 'https://yourdomain.com/wallet',
});
```

---

## 📧 Support

- Website: https://betweena.com
- Email: hello@betweena.com
- License: MIT

---

*Built with ❤️ for safer digital commerce across Africa and beyond.*
