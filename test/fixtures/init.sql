-- =============================================================================
-- Hakkyra Test Fixtures: Database Schema
-- Models a funeral home CRM platform with ~15 tables covering all Hasura features
-- =============================================================================

-- ─── Enums ──────────────────────────────────────────────────────────────────

CREATE TYPE client_status AS ENUM ('active', 'on_hold', 'inactive', 'archived');
CREATE TYPE invoice_state AS ENUM ('draft', 'sent', 'paid', 'overdue', 'cancelled');
CREATE TYPE ledger_type AS ENUM ('payment', 'refund', 'deposit', 'adjustment', 'writeoff', 'credit');
CREATE TYPE plan_state AS ENUM ('draft', 'scheduled', 'active', 'paused', 'completed', 'cancelled');
CREATE TYPE service_status AS ENUM ('pending', 'scheduled', 'in_progress', 'completed', 'cancelled');

-- ─── Reference tables ───────────────────────────────────────────────────────

CREATE TABLE branch (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL UNIQUE,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE currency (
  id TEXT PRIMARY KEY,  -- 'EUR', 'USD', etc.
  name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  decimal_places INT DEFAULT 2
);

CREATE TABLE country (
  id TEXT PRIMARY KEY,  -- 'FI', 'US', etc.
  name TEXT NOT NULL
);

CREATE TABLE language (
  id TEXT PRIMARY KEY,  -- 'en', 'fi', etc.
  name TEXT NOT NULL
);

CREATE TABLE role (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT
);

-- Hasura-style table-based enum (is_enum: true)
CREATE TABLE priority_type (
  value TEXT PRIMARY KEY,
  description TEXT
);
INSERT INTO priority_type (value, description) VALUES
  ('low', 'Low priority'),
  ('normal', 'Normal priority'),
  ('high', 'High priority'),
  ('urgent', 'Urgent priority');

-- ─── Core entities ──────────────────────────────────────────────────────────

CREATE TABLE client (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  status client_status DEFAULT 'active',
  branch_id UUID NOT NULL REFERENCES branch(id),
  currency_id TEXT NOT NULL REFERENCES currency(id),
  country_id TEXT REFERENCES country(id),
  language_id TEXT DEFAULT 'en' REFERENCES language(id),
  trust_level INT DEFAULT 0,
  on_hold BOOLEAN DEFAULT false,
  tags JSONB DEFAULT '[]'::jsonb,
  metadata JSONB DEFAULT '{}'::jsonb,
  last_contact_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE client_data (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES client(id),
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(client_id, key)
);

CREATE TABLE account (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES client(id),
  currency_id TEXT NOT NULL REFERENCES currency(id),
  balance NUMERIC(20,4) DEFAULT 0,
  credit_balance NUMERIC(20,4) DEFAULT 0,
  pending_balance NUMERIC(20,4) DEFAULT 0,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(client_id, currency_id)
);

CREATE TABLE invoice (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES client(id),
  account_id UUID REFERENCES account(id),
  currency_id TEXT NOT NULL REFERENCES currency(id),
  amount NUMERIC(20,4) NOT NULL,
  state invoice_state DEFAULT 'draft',
  type ledger_type NOT NULL,
  provider TEXT,
  external_id TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE ledger_entry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID REFERENCES invoice(id),
  client_id UUID NOT NULL REFERENCES client(id),
  account_id UUID NOT NULL REFERENCES account(id),
  type ledger_type NOT NULL,
  amount NUMERIC(20,4) NOT NULL,
  balance_before NUMERIC(20,4),
  balance_after NUMERIC(20,4),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ─── Product tables ───────────────────────────────────────────────────────

CREATE TABLE supplier (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL UNIQUE,
  active BOOLEAN DEFAULT true,
  tags text[] DEFAULT '{}',
  ratings int[] DEFAULT '{}'
);

CREATE TABLE product (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id UUID NOT NULL REFERENCES supplier(id),
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  category TEXT,
  tags JSONB DEFAULT '[]'::jsonb,
  active BOOLEAN DEFAULT true,
  margin NUMERIC(5,2),
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE appointment (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES client(id),
  product_id UUID NOT NULL REFERENCES product(id),
  branch_id UUID NOT NULL REFERENCES branch(id),
  currency_id TEXT NOT NULL REFERENCES currency(id),
  priority TEXT NOT NULL DEFAULT 'normal' REFERENCES priority_type(value),
  notes TEXT,
  active BOOLEAN DEFAULT true,
  discount_rate NUMERIC(20,8) DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ─── Service Plan / Plan Item tables ──────────────────────────────────────

CREATE TABLE service_plan (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  branch_id UUID NOT NULL REFERENCES branch(id),
  state plan_state DEFAULT 'draft',
  review_schedule TEXT,
  start_at TIMESTAMPTZ,
  end_at TIMESTAMPTZ,
  config JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE plan_item (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_plan_id UUID REFERENCES service_plan(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL,  -- 'service', 'discount', 'addon'
  value JSONB NOT NULL,  -- { sessions: 5, includes: 'consultation' } or { percentage: 10, max_amount: 500 }
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE service_plan_client (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_plan_id UUID NOT NULL REFERENCES service_plan(id),
  client_id UUID NOT NULL REFERENCES client(id),
  state TEXT DEFAULT 'enrolled',
  enrolled_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(service_plan_id, client_id)
);

CREATE TABLE client_service (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES client(id),
  plan_item_id UUID NOT NULL REFERENCES plan_item(id),
  service_plan_client_id UUID REFERENCES service_plan_client(id),
  currency_id TEXT NOT NULL REFERENCES currency(id),
  status service_status DEFAULT 'pending',
  amount NUMERIC(20,4),
  service_cost NUMERIC(20,4) DEFAULT 0,
  amount_paid NUMERIC(20,4) DEFAULT 0,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ─── Admin tables ───────────────────────────────────────────────────────────

CREATE TABLE "user" (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role_id INT REFERENCES role(id),
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ─── Materialized view ─────────────────────────────────────────────────────

CREATE MATERIALIZED VIEW client_summary AS
SELECT
  c.id as client_id,
  c.username,
  c.branch_id,
  c.status,
  c.created_at,
  COALESCE(SUM(a.balance), 0) as total_balance,
  COUNT(DISTINCT inv.id) FILTER (WHERE inv.type = 'payment') as payment_count,
  COALESCE(SUM(inv.amount) FILTER (WHERE inv.type = 'payment' AND inv.state = 'paid'), 0) as total_payments,
  COUNT(DISTINCT ap.id) as total_appointments
FROM client c
LEFT JOIN account a ON a.client_id = c.id AND a.active = true
LEFT JOIN invoice inv ON inv.client_id = c.id
LEFT JOIN appointment ap ON ap.client_id = c.id
GROUP BY c.id, c.username, c.branch_id, c.status, c.created_at;

CREATE UNIQUE INDEX idx_client_summary_id ON client_summary(client_id);

-- ─── Computed field functions ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION client_total_balance(client_row client)
RETURNS NUMERIC AS $$
  SELECT COALESCE(SUM(balance + credit_balance), 0)
  FROM account
  WHERE client_id = client_row.id AND active = true
$$ LANGUAGE SQL STABLE;

CREATE OR REPLACE FUNCTION account_total(account_row account)
RETURNS NUMERIC AS $$
  SELECT account_row.balance + account_row.credit_balance
$$ LANGUAGE SQL IMMUTABLE;

CREATE OR REPLACE FUNCTION client_service_outcome(cs client_service)
RETURNS TEXT AS $$
  SELECT CASE
    WHEN cs.status = 'cancelled' THEN 'cancelled'
    WHEN cs.status = 'completed' THEN 'completed'
    WHEN cs.status = 'in_progress' AND cs.service_cost > 0 AND cs.amount_paid >= cs.service_cost THEN 'payment_complete'
    WHEN cs.status = 'in_progress' AND cs.service_cost > 0 THEN 'payment_in_progress'
    ELSE 'pending'
  END
$$ LANGUAGE SQL IMMUTABLE;

-- ─── Tracked function: SETOF query ───────────────────────────────────────

CREATE OR REPLACE FUNCTION search_clients(search_term text)
RETURNS SETOF client AS $$
  SELECT * FROM client WHERE first_name ILIKE '%' || search_term || '%' OR last_name ILIKE '%' || search_term || '%' OR username ILIKE '%' || search_term || '%' OR email ILIKE '%' || search_term || '%'
$$ LANGUAGE SQL STABLE;

-- ─── Tracked function: mutation (single row) ────────────────────────────

CREATE OR REPLACE FUNCTION deactivate_client(client_uuid uuid)
RETURNS client AS $$
  UPDATE client SET status = 'inactive' WHERE id = client_uuid RETURNING *
$$ LANGUAGE SQL VOLATILE;

-- ─── Indexes ────────────────────────────────────────────────────────────────

CREATE INDEX idx_client_branch ON client(branch_id);
CREATE INDEX idx_client_status ON client(status);
CREATE INDEX idx_client_email ON client(email);
CREATE INDEX idx_invoice_client ON invoice(client_id);
CREATE INDEX idx_invoice_state ON invoice(state);
CREATE INDEX idx_ledger_entry_client ON ledger_entry(client_id);
CREATE INDEX idx_ledger_entry_account ON ledger_entry(account_id);
CREATE INDEX idx_appointment_client ON appointment(client_id);
CREATE INDEX idx_service_plan_client_client ON service_plan_client(client_id);
CREATE INDEX idx_client_service_client ON client_service(client_id);
CREATE INDEX idx_client_data_client ON client_data(client_id);
CREATE INDEX idx_account_client ON account(client_id);

-- ─── Seed data ──────────────────────────────────────────────────────────────

INSERT INTO branch (id, name, code) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'TestBranch', 'MAIN'),
  ('a0000000-0000-0000-0000-000000000002', 'OtherBranch', 'EAST');

INSERT INTO currency (id, name, symbol) VALUES
  ('EUR', 'Euro', '€'),
  ('USD', 'US Dollar', '$'),
  ('GBP', 'British Pound', '£');

INSERT INTO country (id, name) VALUES
  ('FI', 'Finland'),
  ('US', 'United States'),
  ('GB', 'United Kingdom');

INSERT INTO language (id, name) VALUES
  ('en', 'English'),
  ('fi', 'Finnish');

INSERT INTO role (id, name) VALUES
  (1, 'admin'),
  (2, 'support'),
  (3, 'viewer');

INSERT INTO supplier (id, name, code, tags, ratings) VALUES
  ('b0000000-0000-0000-0000-000000000001', 'TestSupplier', 'TEST_SUP', '{"premium","verified"}', '{5,4,5}');

INSERT INTO product (id, supplier_id, name, code, category, margin) VALUES
  ('c0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 'Premium Casket', 'premium-casket', 'caskets', 35.50),
  ('c0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000001', 'Memorial Wreath', 'memorial-wreath', 'flowers', 42.30);

-- Clients with different statuses
INSERT INTO client (id, username, email, status, branch_id, currency_id, country_id, trust_level, tags) VALUES
  ('d0000000-0000-0000-0000-000000000001', 'alice', 'alice@test.com', 'active', 'a0000000-0000-0000-0000-000000000001', 'EUR', 'FI', 2, '["vip", "verified"]'),
  ('d0000000-0000-0000-0000-000000000002', 'bob', 'bob@test.com', 'active', 'a0000000-0000-0000-0000-000000000001', 'USD', 'US', 1, '["new"]'),
  ('d0000000-0000-0000-0000-000000000003', 'charlie', 'charlie@test.com', 'on_hold', 'a0000000-0000-0000-0000-000000000002', 'EUR', 'FI', 0, '[]'),
  ('d0000000-0000-0000-0000-000000000004', 'diana', 'diana@test.com', 'active', 'a0000000-0000-0000-0000-000000000002', 'GBP', 'GB', 3, '["preneed", "vip"]');

-- Accounts
INSERT INTO account (id, client_id, currency_id, balance, credit_balance) VALUES
  ('e0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'EUR', 1500.00, 200.00),
  ('e0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000002', 'USD', 500.00, 0),
  ('e0000000-0000-0000-0000-000000000003', 'd0000000-0000-0000-0000-000000000003', 'EUR', 0, 0),
  ('e0000000-0000-0000-0000-000000000004', 'd0000000-0000-0000-0000-000000000004', 'GBP', 25000.00, 500.00);

-- Invoices
INSERT INTO invoice (id, client_id, account_id, currency_id, amount, state, type) VALUES
  ('f0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001', 'EUR', 100.00, 'paid', 'payment'),
  ('f0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001', 'EUR', 50.00, 'draft', 'refund'),
  ('f0000000-0000-0000-0000-000000000003', 'd0000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-000000000002', 'USD', 200.00, 'paid', 'payment'),
  ('f0000000-0000-0000-0000-000000000004', 'd0000000-0000-0000-0000-000000000004', 'e0000000-0000-0000-0000-000000000004', 'GBP', 5000.00, 'paid', 'payment');

-- Ledger entries
INSERT INTO ledger_entry (client_id, account_id, type, amount, balance_before, balance_after) VALUES
  ('d0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001', 'payment', 100.00, 1400.00, 1500.00),
  ('d0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001', 'adjustment', -25.00, 1500.00, 1475.00),
  ('d0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001', 'credit', 50.00, 1475.00, 1525.00);

-- Client data
INSERT INTO client_data (client_id, key, value) VALUES
  ('d0000000-0000-0000-0000-000000000001', 'preferences', '{"theme": "dark", "notifications": true}'),
  ('d0000000-0000-0000-0000-000000000001', 'address', '{"city": "Helsinki", "country": "FI"}');

-- Service plans + plan items
INSERT INTO service_plan (id, name, branch_id, state, start_at, end_at) VALUES
  ('aa000000-0000-0000-0000-000000000001', 'Welcome Package', 'a0000000-0000-0000-0000-000000000001', 'active', now() - interval '30 days', now() + interval '30 days'),
  ('aa000000-0000-0000-0000-000000000002', 'VIP Memorial Plan', 'a0000000-0000-0000-0000-000000000001', 'active', now(), null);

INSERT INTO plan_item (id, service_plan_id, name, type, value) VALUES
  ('bb000000-0000-0000-0000-000000000001', 'aa000000-0000-0000-0000-000000000001', 'Basic Funeral Service', 'service', '{"sessions": 5, "includes": "consultation"}'),
  ('bb000000-0000-0000-0000-000000000002', 'aa000000-0000-0000-0000-000000000002', '10% Loyalty Discount', 'discount', '{"percentage": 10, "max_amount": 500}');

INSERT INTO service_plan_client (service_plan_id, client_id) VALUES
  ('aa000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001'),
  ('aa000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000002');

INSERT INTO client_service (client_id, plan_item_id, currency_id, status, amount, service_cost, amount_paid) VALUES
  ('d0000000-0000-0000-0000-000000000001', 'bb000000-0000-0000-0000-000000000001', 'EUR', 'scheduled', 50.00, 2000.00, 750.00),
  ('d0000000-0000-0000-0000-000000000002', 'bb000000-0000-0000-0000-000000000001', 'USD', 'pending', 50.00, 2000.00, 0);

-- Appointments
INSERT INTO appointment (client_id, product_id, branch_id, currency_id, priority, active) VALUES
  ('d0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'EUR', 'high', false),
  ('d0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'EUR', 'normal', true);

-- Admin users
INSERT INTO "user" (email, name, role_id) VALUES
  ('admin@test.com', 'Admin User', 1),
  ('support@test.com', 'Support User', 2);

-- Refresh materialized view
REFRESH MATERIALIZED VIEW client_summary;
