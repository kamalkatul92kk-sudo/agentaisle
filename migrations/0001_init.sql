-- AgentAisle schema (Cloudflare D1 / SQLite). Money is integer cents (USD).
CREATE TABLE IF NOT EXISTS products (
  sku TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,          -- single_origin | blend | reserve | gear
  roast TEXT,                      -- light | medium | medium_dark | dark | null for gear
  origin TEXT,
  process TEXT,
  tasting_notes TEXT,
  description TEXT NOT NULL,
  weight_oz INTEGER,
  price_cents INTEGER NOT NULL,
  cost_cents INTEGER NOT NULL,
  stock INTEGER NOT NULL,
  negotiable INTEGER NOT NULL DEFAULT 1,
  max_discount_bps INTEGER NOT NULL DEFAULT 1000,
  paypal_product_id TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  display_name TEXT NOT NULL,
  trust TEXT NOT NULL DEFAULT 'new',  -- new | known | blocked
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mandates (
  id TEXT PRIMARY KEY,
  buyer_name TEXT NOT NULL,
  buyer_email TEXT,
  token_hash TEXT NOT NULL UNIQUE,     -- sha256 of the scoped mandate token given to the buyer's agent
  status TEXT NOT NULL,                -- pending | active | revoked
  vault_id TEXT,
  paypal_customer_id TEXT,
  setup_token_id TEXT,
  approve_url TEXT,
  per_order_cap_cents INTEGER NOT NULL,
  monthly_cap_cents INTEGER NOT NULL,
  allowed_categories TEXT NOT NULL,    -- JSON array
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS mandates_setup_token ON mandates(setup_token_id);

CREATE TABLE IF NOT EXISTS checkout_sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  mandate_id TEXT,
  status TEXT NOT NULL,   -- open | requires_buyer_action | on_hold | completed | rejected | canceled | failed
  items TEXT NOT NULL,    -- JSON LineItem[]
  subtotal_cents INTEGER NOT NULL,
  bundle_discount_cents INTEGER NOT NULL,
  negotiated_discount_cents INTEGER NOT NULL,
  shipping_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  negotiation TEXT NOT NULL,  -- JSON NegotiationState
  payment_mode TEXT,          -- mandate | approval_link
  paypal_order_id TEXT,
  capture_id TEXT,
  approve_url TEXT,
  hold_reason TEXT,
  reject_reason TEXT,
  idempotency_key TEXT,
  buyer_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS sessions_agent ON checkout_sessions(agent_id, created_at);
CREATE INDEX IF NOT EXISTS sessions_order ON checkout_sessions(paypal_order_id);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_idem ON checkout_sessions(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  paypal_order_id TEXT NOT NULL,
  capture_id TEXT,
  amount_cents INTEGER NOT NULL,
  refunded_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,   -- completed | pending | refunded | partially_refunded | failed
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS payments_capture ON payments(capture_id);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,       -- order_release | refund | create_product | restock
  status TEXT NOT NULL,     -- pending | executed | rejected | failed
  session_id TEXT,
  payload TEXT NOT NULL,    -- JSON
  reason TEXT NOT NULL,
  requested_by TEXT NOT NULL,  -- risk_policy | ops_agent | merchant
  decided_by TEXT,
  result TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS approvals_status ON approvals(status, created_at);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  session_id TEXT,
  agent_id TEXT,
  type TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_session ON events(session_id, id);

CREATE TABLE IF NOT EXISTS searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  query TEXT NOT NULL,
  normalized TEXT NOT NULL,
  result_count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at TEXT NOT NULL,
  outcome TEXT NOT NULL
);

-- Persistence for the mock PayPal adapter only (local dev without keys).
CREATE TABLE IF NOT EXISTS mock_paypal_objects (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  data TEXT NOT NULL
);
