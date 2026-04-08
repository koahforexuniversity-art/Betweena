const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
  console.warn('\x1b[33m⚠  SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY not set in .env\x1b[0m');
}

// Public client — subject to Row Level Security (RLS).
// Safe to use for operations that match your RLS policies.
const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

// Admin client — bypasses RLS. Only use server-side, NEVER expose to browser.
// Requires SUPABASE_SERVICE_ROLE_KEY in .env (Settings → API → service_role).
const supabaseAdmin = SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : null;

module.exports = { supabase, supabaseAdmin };
