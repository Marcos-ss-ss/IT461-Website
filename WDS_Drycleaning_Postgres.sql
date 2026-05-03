-- ============================================================
-- WDS Drycleaning Schema (IT461) -
-- ============================================================

DO $$ BEGIN
  CREATE TYPE order_status AS ENUM ('Pending', 'Confirmed', 'Ready', 'Picked Up', 'Cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE payment_status AS ENUM ('Unpaid', 'Paid', 'Partial');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('customer', 'worker');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ------------------------------------------------------------
-- vendors (no dependencies, create first)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vendors (
  id               SERIAL PRIMARY KEY,
  vendor_name      VARCHAR(100) NOT NULL,
  contact_name     VARCHAR(100),
  phone            VARCHAR(20),
  email            VARCHAR(100),
  address          VARCHAR(150)
);

-- ------------------------------------------------------------
-- users
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id             SERIAL PRIMARY KEY,
  first_name     VARCHAR(50) NOT NULL,
  last_name      VARCHAR(50) NOT NULL,
  phone          VARCHAR(15) UNIQUE,
  email          VARCHAR(100) UNIQUE,
  password_hash  VARCHAR(255) NOT NULL,
  role           user_role NOT NULL DEFAULT 'customer',
  date_created   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ------------------------------------------------------------
-- services (pricing)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS services (
  id            SERIAL PRIMARY KEY,
  service_name  VARCHAR(50) NOT NULL,
  price         DECIMAL(10,2) NOT NULL,
  description   VARCHAR(150)
);

-- ------------------------------------------------------------
-- orders
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id                 SERIAL PRIMARY KEY,
  order_number       VARCHAR(20) UNIQUE,
  user_id            INT NOT NULL REFERENCES users(id),
  pickup_date        DATE,
  pickup_time        VARCHAR(20),
  special_notes      TEXT,
  status             order_status NOT NULL DEFAULT 'Pending',
  total_cost         DECIMAL(10,2) DEFAULT 0.00,
  payment_status     payment_status NOT NULL DEFAULT 'Unpaid',
  created_by_worker  BOOLEAN DEFAULT FALSE,
  created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ------------------------------------------------------------
-- order_items
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_items (
  id          SERIAL PRIMARY KEY,
  order_id    INT NOT NULL REFERENCES orders(id),
  service_id  INT NOT NULL REFERENCES services(id),
  quantity    INT NOT NULL,
  unit_price  DECIMAL(10,2) NOT NULL,
  line_total  DECIMAL(10,2) NOT NULL
);

-- ------------------------------------------------------------
-- inventory
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory (
  id                SERIAL PRIMARY KEY,
  vendor_id         INT NOT NULL REFERENCES vendors(id),
  item_name         VARCHAR(100) NOT NULL,
  quantity_in_stock INT NOT NULL DEFAULT 0,
  reorder_level     INT NOT NULL DEFAULT 0,
  unit_cost         DECIMAL(10,2) NOT NULL DEFAULT 0.00
);

-- ------------------------------------------------------------
-- payments
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
  id              SERIAL PRIMARY KEY,
  order_id        INT NOT NULL REFERENCES orders(id),
  payment_date    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  payment_method  VARCHAR(30) NOT NULL,
  amount_paid     DECIMAL(10,2) NOT NULL
);

-- ------------------------------------------------------------
-- order_number_seq  (custom sequence tracker)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_number_seq (
  prefix    VARCHAR(10) PRIMARY KEY,
  next_seq  INT NOT NULL DEFAULT 1
);

-- ------------------------------------------------------------
-- Seed data: services
-- ------------------------------------------------------------
INSERT INTO services (id, service_name, price, description) VALUES
  (1, 'Dry Clean - Shirt',      5.99,  'Standard Dry Clean for Dress Shirts'),
  (2, 'Dry Clean - Pants',      6.99,  'Standard Dry Clean for Trousers'),
  (3, 'Dry Clean - Suit(2pc)',  18.99, 'Standard Dry Clean for Jacket and Trousers'),
  (4, 'Dry Clean - Dress',      12.99, 'Standard Dry Clean for Dress or Skirt'),
  (5, 'Dry Clean - Coat',       19.99, 'Standard Dry Clean for Overcoat'),
  (6, 'Press Only - Shirt',     3.50,  'Steam Press Only, No Dry Cleaning'),
  (7, 'Press Only - Pants',     3.50,  'Steam Press Only, No Dry Cleaning'),
  (8, 'Press Only - Suit(2pc)', 18.99, 'Steam Press Only, No Dry Cleaning'),
  (9, 'Press Only - Dress',     12.99, 'Steam Press Only, No Dry Cleaning'),
  (10, 'Press Only - Coat',     19.99, 'Steam Press Only, No Dry Cleaning'),
ON CONFLICT (id) DO NOTHING;

SELECT setval('services_id_seq', 7);

-- ------------------------------------------------------------
-- Seed data: admin worker account
-- NOTE: Replace password_hash with a real bcrypt hash before deploying
-- ------------------------------------------------------------
INSERT INTO users (first_name, last_name, email, password_hash, role) VALUES
  ('Worker', 'Admin', 'washingwds@gmail.com', '$2b$10$TgT81MRrB61U0SjIWtQVduVZQj0oE9zC1sljgqN0wSRKC.WcKcvWu', 'worker')
ON CONFLICT (email) DO NOTHING;

-- ------------------------------------------------------------
-- Views (Business Analytics - used by Metabase)
-- ------------------------------------------------------------

CREATE OR REPLACE VIEW v_order_summary AS
SELECT
  o.id              AS order_id,
  o.order_number,
  o.status,
  o.payment_status,
  o.total_cost,
  o.created_at,
  o.pickup_date,
  u.first_name || ' ' || u.last_name  AS customer_name,
  u.phone                              AS customer_phone,
  u.email                              AS customer_email
FROM orders o
JOIN users u ON o.user_id = u.id;

CREATE OR REPLACE VIEW v_customer_totals AS
SELECT
  u.id                                  AS user_id,
  u.first_name || ' ' || u.last_name    AS customer_name,
  u.phone,
  COUNT(o.id)                           AS total_orders,
  COALESCE(SUM(o.total_cost), 0)        AS lifetime_spend
FROM users u
LEFT JOIN orders o ON u.id = o.user_id
WHERE u.role = 'customer'
GROUP BY u.id, u.first_name, u.last_name, u.phone;

CREATE OR REPLACE VIEW v_daily_revenue AS
SELECT
  payment_date::date       AS report_date,
  SUM(amount_paid)         AS total_revenue,
  COUNT(DISTINCT order_id) AS orders_paid
FROM payments
GROUP BY payment_date::date;

CREATE OR REPLACE VIEW v_low_inventory AS
SELECT
  i.id,
  i.item_name,
  i.quantity_in_stock,
  i.reorder_level,
  v.vendor_name,
  v.phone  AS vendor_phone
FROM inventory i
JOIN vendors v ON i.vendor_id = v.id
WHERE i.quantity_in_stock <= i.reorder_level;
