require('dotenv').config();

// Force IPv4 DNS — Railway cannot reach Supabase via IPv6
const dns = require('dns');
if (dns.setDefaultResultOrder) dns.setDefaultResultOrder('ipv4first');

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { initDb } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Security headers
app.use(helmet({ contentSecurityPolicy: false }));

// CORS
const allowedOrigins = (process.env.ALLOWED_ORIGIN || '*')
  .split(',').map(o => o.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    // allow non-browser requests (curl, Postman, server-to-server)
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Rate limiters
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// Dev request logger
if (NODE_ENV === 'development') {
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - start;
      const color = res.statusCode >= 400 ? '\x1b[31m' : res.statusCode >= 300 ? '\x1b[33m' : '\x1b[32m';
      console.log(`${color}${req.method}\x1b[0m ${req.path} \x1b[2m${res.statusCode} · ${ms}ms\x1b[0m`);
    });
    next();
  });
}

// Static frontend (Railway serves this; Vercel is the fast CDN path)
app.use(express.static(path.join(__dirname, 'public')));

// API Routes
app.use('/api/auth', authLimiter, require('./routes/auth'));
app.use('/api/wallet', require('./routes/wallet'));
app.use('/api/transactions', require('./routes/transactions'));
app.use('/api/fundraisers', require('./routes/fundraisers'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', env: NODE_ENV, timestamp: new Date().toISOString() });
});

// 404 for unknown API routes
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: `Route ${req.path} not found` });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('\x1b[31mServer Error:\x1b[0m', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// Wait for DB tables before accepting traffic
async function start() {
  try {
    await initDb();
    app.listen(PORT, () => {
      console.log('\n\x1b[32m✓\x1b[0m \x1b[1mBetweena\x1b[0m is running');
      console.log(`  \x1b[2mLocal:\x1b[0m   \x1b[36mhttp://localhost:${PORT}\x1b[0m`);
      console.log(`  \x1b[2mEnv:\x1b[0m     ${NODE_ENV}`);
      console.log(`  \x1b[2mDemo:\x1b[0m    demo@betweena.com / demo1234`);
      console.log(`  \x1b[2mAPI:\x1b[0m     http://localhost:${PORT}/api`);
      console.log('');
    });
  } catch (err) {
    console.error('\x1b[31m✗ Failed to start:\x1b[0m', err.message);
    process.exit(1);
  }
}

start();

module.exports = app;
