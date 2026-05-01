// ============================================================
//  WDS DryCleaning Group 8 — Backend API
//  File: server.js
//  Run with:  node server.js
// ============================================================

require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');          
const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

// ------------------------------------------------------------------
// MIDDLEWARE
// ------------------------------------------------------------------
app.use(cors());
app.use(express.json());

// ------------------------------------------------------------------
// DATABASE CONNECTION POOL
// ------------------------------------------------------------------
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
});

// ------------------------------------------------------------------
// HELPER: verifyToken
// ------------------------------------------------------------------
function verifyToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
}

// ------------------------------------------------------------------
// HELPER: workerOnly
// ------------------------------------------------------------------
function workerOnly(req, res, next) {
  if (req.user.role !== 'worker') {
    return res.status(403).json({ error: 'Worker access only' });
  }
  next();
}

// ------------------------------------------------------------------
// HELPER: generateOrderNumber
// ------------------------------------------------------------------
async function generateOrderNumber(firstName, lastName, phone) {
  const initials = (firstName[0] + lastName[0]).toUpperCase();
  const last4    = phone.replace(/\D/g, '').slice(-4);
  const prefix   = initials + last4;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      'SELECT next_seq FROM order_number_seq WHERE prefix = $1 FOR UPDATE',
      [prefix]
    );

    let nextSeq = 1;
    if (rows.length === 0) {
      await client.query(
        'INSERT INTO order_number_seq (prefix, next_seq) VALUES ($1, 2)',
        [prefix]
      );
    } else {
      nextSeq = rows[0].next_seq;
      await client.query(
        'UPDATE order_number_seq SET next_seq = next_seq + 1 WHERE prefix = $1',
        [prefix]
      );
    }

    await client.query('COMMIT');
    return `${prefix}-${String(nextSeq).padStart(4, '0')}`;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ==================================================================
//  AUTH ROUTES
// ==================================================================

// POST /register
app.post('/register', async (req, res) => {
  const { first_name, last_name, phone, email, password } = req.body;

  if (!first_name || !last_name || !phone || !password) {
    return res.status(400).json({ error: 'first_name, last_name, phone, and password are required' });
  }

  try {
        const existing = await db.query(
      'SELECT id FROM users WHERE phone = $1', [phone]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Phone number already registered' });
    }

    const password_hash = await bcrypt.hash(password, 10);

        const result = await db.query(
      `INSERT INTO users (first_name, last_name, phone, email, password_hash, role)
       VALUES ($1, $2, $3, $4, $5, 'customer') RETURNING id`,
      [first_name, last_name, phone, email || null, password_hash]
    );

    res.status(201).json({ message: 'Account created', userId: result.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /login
app.post('/login', async (req, res) => {
  const { identifier, password } = req.body;
  const cleanIdentifier = identifier.trim().toLowerCase();
  if (!identifier || !password) {
    return res.status(400).json({ error: 'identifier and password are required' });
  }

  try {
    const isPhone = /^\d+$/.test(identifier.replace(/\D/g, '')) && identifier.length >= 7;
    const field   = isPhone ? 'phone' : 'email';

        const result = await db.query(
      `SELECT id, first_name, last_name, phone, email, password_hash, role
       FROM users WHERE LOWER(${field}) = LOWER($1)`,
      [cleanIdentifier]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user  = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: user.id, role: user.role, first_name: user.first_name,
        last_name: user.last_name, phone: user.phone },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({ token, role: user.role, first_name: user.first_name, last_name: user.last_name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================================================================
//  ORDER ROUTES
// ==================================================================

// POST /orders
app.post('/orders', verifyToken, async (req, res) => {
  const isWorker = req.user.role === 'worker';
  let targetUserId = req.user.id;

  if (isWorker && req.body.user_id) {
    targetUserId = req.body.user_id;
  }

  const { pickup_date, pickup_time, special_notes, items } = req.body;

  if (!items || items.length === 0) {
    return res.status(400).json({ error: 'Order must have at least one item' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const userResult = await client.query(
      'SELECT first_name, last_name, phone FROM users WHERE id = $1',
      [targetUserId]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    const customer = userResult.rows[0];

    let totalCost = 0;
    const enrichedItems = [];

    for (const item of items) {
      const svcResult = await client.query(
        'SELECT id, service_name, price FROM services WHERE id = $1',
        [item.service_id]
      );
      if (svcResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Service ID ${item.service_id} not found` });
      }
      const svc       = svcResult.rows[0];
      const lineTotal = svc.price * item.quantity;
      totalCost      += lineTotal;
      enrichedItems.push({
        service_id: svc.id,
        quantity:   item.quantity,
        unit_price: svc.price,
        line_total: lineTotal,
      });
    }

    const orderNumber = await generateOrderNumber(
      customer.first_name, customer.last_name, customer.phone
    );

    const orderResult = await client.query(
      `INSERT INTO orders
         (order_number, user_id, pickup_date, pickup_time,
          special_notes, total_cost, created_by_worker)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [orderNumber, targetUserId, pickup_date || null, pickup_time || null,
       special_notes || null, totalCost, isWorker]
    );
    const orderId = orderResult.rows[0].id;

    for (const item of enrichedItems) {
      await client.query(
        `INSERT INTO order_items
           (order_id, service_id, quantity, unit_price, line_total)
         VALUES ($1, $2, $3, $4, $5)`,
        [orderId, item.service_id, item.quantity, item.unit_price, item.line_total]
      );
    }

    await client.query('COMMIT');

    res.status(201).json({
      message:      'Order created',
      order_id:     orderId,
      order_number: orderNumber,
      total_cost:   totalCost,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// GET /orders
app.get('/orders', verifyToken, async (req, res) => {
  try {
    let query, params;

    if (req.user.role === 'worker') {
      const statusFilter = req.query.status;
      if (statusFilter) {
        query  = 'SELECT * FROM v_order_summary WHERE status = $1 ORDER BY created_at DESC';
        params = [statusFilter];
      } else {
        query  = 'SELECT * FROM v_order_summary ORDER BY created_at DESC';
        params = [];
      }
    } else {
      query  = 'SELECT * FROM v_order_summary WHERE customer_phone = $1 ORDER BY created_at DESC';
      params = [req.user.phone];
    }

    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /orders/:id
app.get('/orders/:id', verifyToken, async (req, res) => {
  try {
    const orderResult = await db.query(
      'SELECT * FROM v_order_summary WHERE order_id = $1',
      [req.params.id]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderResult.rows[0];

    if (req.user.role === 'customer' && order.customer_phone !== req.user.phone) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const itemsResult = await db.query(
      `SELECT oi.quantity, oi.unit_price, oi.line_total, s.service_name
       FROM order_items oi
       JOIN services s ON oi.service_id = s.id
       WHERE oi.order_id = $1`,
      [req.params.id]
    );

    res.json({ ...order, items: itemsResult.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /orders/:id/status  [WORKER ONLY]
app.patch('/orders/:id/status', verifyToken, workerOnly, async (req, res) => {
  const { status } = req.body;
  const validStatuses = ['Pending', 'Confirmed', 'Ready', 'Picked Up', 'Cancelled'];

  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
  }

  try {
    await db.query(
      `UPDATE orders
       SET status = $1,
           payment_status = CASE
             WHEN $1 = 'Picked Up' THEN 'Paid'
             ELSE payment_status
           END
       WHERE id = $2`,
      [status, req.params.id]
    );

    res.json({ message: 'Status updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================================================================
//  SERVICES ROUTE
// ==================================================================

// GET /services
app.get('/services', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM services ORDER BY service_name');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================================================================
//  WORKER-ONLY ROUTES
// ==================================================================

// GET /customers
app.get('/customers', verifyToken, workerOnly, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM v_customer_totals ORDER BY lifetime_spend DESC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /customers/search
app.get('/customers/search', verifyToken, workerOnly, async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: 'phone query parameter required' });

  try {
    const result = await db.query(
      `SELECT id, first_name, last_name, phone, email
       FROM users WHERE phone LIKE $1 AND role = 'customer'`,
      [`%${phone}%`]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /inventory
app.get('/inventory', verifyToken, workerOnly, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT i.*, v.vendor_name, v.phone AS vendor_phone, v.email AS vendor_email
       FROM inventory i
       JOIN vendors v ON i.vendor_id = v.id
       ORDER BY i.item_name`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /inventory/low
app.get('/inventory/low', verifyToken, workerOnly, async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM v_low_inventory');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /vendors
app.get('/vendors', verifyToken, workerOnly, async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM vendors ORDER BY vendor_name');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /reports/revenue  [WORKER ONLY]
app.get('/reports/revenue', verifyToken, workerOnly, async (req, res) => {
  const range = req.query.range || 'monthly';

  try {
    let query;
    if (range === 'daily') {
      query = `
        SELECT
          payment_date::date           AS period,
          SUM(amount_paid)             AS total_revenue,
          COUNT(DISTINCT order_id)     AS orders_paid
        FROM payments
        GROUP BY payment_date::date
        ORDER BY period`;
    } else if (range === 'quarterly') {
      query = `
        SELECT
          EXTRACT(YEAR FROM payment_date)    AS year,
          EXTRACT(QUARTER FROM payment_date) AS quarter,
          SUM(amount_paid)                   AS total_revenue,
          COUNT(DISTINCT order_id)           AS orders_paid
        FROM payments
        GROUP BY year, quarter
        ORDER BY year, quarter`;
    } else {
      // monthly (default)
      query = `
        SELECT
          TO_CHAR(payment_date, 'YYYY-MM')  AS period,
          SUM(amount_paid)                  AS total_revenue,
          COUNT(DISTINCT order_id)          AS orders_paid
        FROM payments
        GROUP BY TO_CHAR(payment_date, 'YYYY-MM')
        ORDER BY period`;
    }

    const result = await db.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================================================================
//  START SERVER
// ==================================================================
app.listen(PORT, () => {
  console.log(`\n DryClean API running on http://localhost:${PORT}`);
  console.log(' Routes available:');
  console.log('   POST   /register');
  console.log('   POST   /login');
  console.log('   GET    /services');
  console.log('   POST   /orders          (login required)');
  console.log('   GET    /orders          (login required)');
  console.log('   GET    /orders/:id      (login required)');
  console.log('   PATCH  /orders/:id/status  (worker only)');
  console.log('   GET    /customers       (worker only)');
  console.log('   GET    /customers/search   (worker only)');
  console.log('   GET    /inventory       (worker only)');
  console.log('   GET    /inventory/low   (worker only)');
  console.log('   GET    /vendors         (worker only)');
  console.log('   GET    /reports/revenue (worker only)\n');
});
