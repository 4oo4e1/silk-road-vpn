-- ════════════════════════════════════════════════════════════
--  Silk Road VPN — Database Schema
--  Cloudflare D1 (SQLite)
--
--  Apply the schema (use the database name from your wrangler.toml):
--    wrangler d1 execute YOUR_DB_NAME --remote --file=schema.sql
--
--  For local development:
--    wrangler d1 execute YOUR_DB_NAME --local --file=schema.sql
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT UNIQUE NOT NULL,
  username TEXT,
  full_name TEXT,
  wallet INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  is_banned INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  price INTEGER NOT NULL,
  duration_days INTEGER NOT NULL,
  is_unlimited INTEGER DEFAULT 0,
  gb_limit INTEGER,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vpn_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_email TEXT NOT NULL,
  dashboard_password TEXT NOT NULL,
  subscription_url TEXT NOT NULL,
  dashboard_url TEXT NOT NULL,
  status TEXT DEFAULT 'available',          -- available | assigned | expired | disabled
  assigned_user_id INTEGER,
  assigned_order_id INTEGER,
  assigned_at TEXT,
  FOREIGN KEY (assigned_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number TEXT UNIQUE NOT NULL,        -- SR-YYYY-NNNNNN
  user_id INTEGER NOT NULL,
  plan_id INTEGER NOT NULL,
  price INTEGER NOT NULL,
  payment_method TEXT NOT NULL,             -- wallet | card
  status TEXT DEFAULT 'pending_payment',    -- pending_payment | pending_approval | paid | completed | rejected | expired
  vpn_account_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  paid_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (plan_id) REFERENCES plans(id)
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  order_id INTEGER NOT NULL,
  vpn_account_id INTEGER NOT NULL,
  plan_id INTEGER NOT NULL,
  status TEXT DEFAULT 'active',             -- active | expired | disabled
  started_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,                  -- positive = credit, negative = debit
  type TEXT NOT NULL,                       -- purchase | recharge | refund | admin_credit | admin_debit
  description TEXT,
  order_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS payment_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  order_id INTEGER,
  type TEXT NOT NULL,                       -- wallet | order
  telegram_file_id TEXT,
  amount INTEGER,
  status TEXT DEFAULT 'pending',            -- pending | approved | rejected
  reviewed_by INTEGER,
  reviewed_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  subject TEXT NOT NULL,
  status TEXT DEFAULT 'open',               -- open | answered | closed
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ticket_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  sender_type TEXT NOT NULL,                -- user | admin
  sender_id INTEGER NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (ticket_id) REFERENCES tickets(id)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- ── Indexes ─────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_users_telegram_id          ON users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_orders_user_id             ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status              ON orders(status);
CREATE INDEX IF NOT EXISTS idx_vpn_accounts_status        ON vpn_accounts(status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id      ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status       ON subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user_id ON wallet_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_tickets_user_id            ON tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_receipts_status    ON payment_receipts(status);

-- ════════════════════════════════════════════════════════════
--  Seed data
-- ════════════════════════════════════════════════════════════

-- A sample plan so the shop is not empty on first launch.
-- Edit, delete, or add plans later from the admin panel.
INSERT OR IGNORE INTO plans (name, description, price, duration_days, is_unlimited)
VALUES ('Unlimited 1-Month', 'Unlimited traffic — standard conditions', 500000, 30, 1);

-- Runtime settings.
--   ⚠️  REPLACE the placeholder values below with YOUR OWN values,
--       OR leave them and set them later:
--         • card_number / card_owner / channel_id → from the admin panel
--         • admin_ids                             → see the command in the README
--
--   card_number  = the card number shown to customers for card-to-card payment
--   card_owner   = the card holder name shown next to the card number
--   channel_id   = your public Telegram channel handle (e.g. @YourChannel)
--   admin_ids    = JSON array of Telegram numeric IDs allowed into the admin panel.
--                  Get your numeric ID from @userinfobot on Telegram.
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('card_number', 'YOUR_CARD_NUMBER'),
  ('card_owner',  'YOUR_CARD_OWNER_NAME'),
  ('channel_id',  '@YourChannel'),
  ('admin_ids',   '["YOUR_ADMIN_TELEGRAM_ID"]');
