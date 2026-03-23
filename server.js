// ============================================================
//  DryClean Business — Backend API
//  File: server.js
//  Run with:  node server.js
// ============================================================

require('dotenv').config();           // loads your .env file
const express    = require('express');
const mysql      = require('mysql2/promise');
const bcrypt     = require('bcrypt');
const jwt        = require('jsonwebtoken');
const cors       = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

// ------------------------------------------------------------------
// MIDDLEWARE
// These lines run on every request before your route code.
// cors()        → allows your GitHub website to call this API
// express.json()→ lets the API read JSON data sent from the website
// ------------------------------------------------------------------
app.use(cors());
app.use(express.json());

// ------------------------------------------------------------------
// DATABASE CONNECTION POOL
// A "pool" keeps several connections open so multiple requests
// don't have to wait for each other.
// ------------------------------------------------------------------
const db = mysql.createPool({
  host:     process.env.DB_HOST,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit:    10,
});

// ------------------------------------------------------------------
// HELPER: verifyToken
// This middleware checks that the user is logged in before
// allowing access to protected routes.
// It reads the token from the Authorization header.
// ------------------------------------------------------------------
function verifyToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // "Bearer <token>"
  if (!token) return res.status(401).json({ error: 'No token provided' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { id, role, first_name, last_name, phone }
    next();
  } catch {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
}

// ------------------------------------------------------------------
// HELPER: workerOnly
// Use this on routes that only workers/employees should access.
// Always use AFTER verifyToken.
// ------------------------------------------------------------------
function workerOnly(req, res, next) {
  if (req.user.role !== 'worker') {
    return res.status(403).json({ error: 'Worker access only' });
  }
  next();
}

// ------------------------------------------------------------------
// HELPER: generateOrderNumber
// Builds the custom order number: FL4321-0001
//   F = first name initial
//   L = last name initial
//   4321 = last 4 digits of phone
//   0001 = next sequence number for this customer
// ------------------------------------------------------------------
async function generateOrderNumber(firstName, lastName, phone) {
  const initials = (firstName[0] + lastName[0]).toUpperCase();
  const last4    = phone.replace(/\D/g, '').slice(-4); // digits only, last 4
  const prefix   = initials + last4;                   // e.g. "JD1234"

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // Get or create the sequence row for this prefix
    const [rows] = await conn.query(
      'SELECT next_seq FROM order_number_seq WHERE prefix = ? FOR UPDATE',
      [prefix]
    );

    let nextSeq = 1;
    if (rows.length === 0) {
      await conn.query(
        'INSERT INTO order_number_seq (prefix, next_seq) VALUES (?, 2)',
        [prefix]
      );
    } else {
      nextSeq = rows[0].next_seq;
      await conn.query(
        'UPDATE order_number_seq SET next_seq = next_seq + 1 WHERE prefix = ?',
        [prefix]
      );
    }

    await conn.commit();
    // Pad to 4 digits: 1 → "0001", 23 → "0023"
    return `${prefix}-${String(nextSeq).padStart(4, '0')}`;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// ==================================================================
//  AUTH ROUTES
// ==================================================================

// ------------------------------------------------------------------
// POST /register
// Creates a new customer account.
// Body: { first_name, last_name, phone, email (optional), password }
// ------------------------------------------------------------------
app.post('/register', async (req, res) => {
  const { first_name, last_name, phone, email, password } = req.body;

  if (!first_name || !last_name || !phone || !password) {
    return res.status(400).json({ error: 'first_name, last_name, phone, and password are required' });
  }

  try {
    // Check if phone already registered
    const [existing] = await db.query(
      'SELECT id FROM users WHERE phone = ?', [phone]
    );
    if (existing.length > 0) {
      return res.status(409).json({ error: 'Phone number already registered' });
    }

    // Hash the password -- never store plain text
    const password_hash = await bcrypt.hash(password, 10);

    const [result] = await db.query(
      `INSERT INTO users (first_name, last_name, phone, email, password_hash, role)
       VALUES (?, ?, ?, ?, ?, 'customer')`,
      [first_name, last_name, phone, email || null, password_hash]
    );

    res.status(201).json({ message: 'Account created', userId: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ------------------------------------------------------------------
// POST /login
// Handles both customer login (phone + password)
// and worker login (email + password).
// Returns a JWT token the frontend stores and sends with every request.
// Body: { identifier, password }
//   identifier = phone number for customers, email for workers
// ------------------------------------------------------------------
app.post('/login', async (req, res) => {
  const { identifier, password } = req.body;
  if (!identifier || !password) {
    return res.status(400).json({ error: 'identifier and password are required' });
  }

  try {
    // Determine if it looks like a phone or email
    const isPhone = /^\d+$/.test(identifier.replace(/\D/g, '')) && identifier.length >= 7;
    const field   = isPhone ? 'phone' : 'email';

    const [rows] = await db.query(
      `SELECT id, first_name, last_name, phone, email, password_hash, role
       FROM users WHERE ${field} = ?`,
      [identifier]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user  = rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Create a JWT token valid for 8 hours
    const token = jwt.sign(
      {
        id:         user.id,
        role:       user.role,
        first_name: user.first_name,
        last_name:  user.last_name,
        phone:      user.phone,
      },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({
      token,
      role:       user.role,
      first_name: user.first_name,
      last_name:  user.last_name,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================================================================
//  ORDER ROUTES
// ==================================================================

// ------------------------------------------------------------------
// POST /orders
// Creates a new order.
// Customers can only create orders for themselves.
// Workers can create orders for any user (walk-ins).
//
// Body (customer): { pickup_date, pickup_time, special_notes, items }
// Body (worker):   { user_id, pickup_date, pickup_time, special_notes, items }
//
// items = array of: { service_id, quantity }
// ------------------------------------------------------------------
app.post('/orders', verifyToken, async (req, res) => {
  const isWorker = req.user.role === 'worker';
  let targetUserId = req.user.id;

  // Workers can pass a different user_id to create an order for a walk-in customer
  if (isWorker && req.body.user_id) {
    targetUserId = req.body.user_id;
  }

  const { pickup_date, pickup_time, special_notes, items } = req.body;

  if (!items || items.length === 0) {
    return res.status(400).json({ error: 'Order must have at least one item' });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // Look up the customer to build the order number
    const [userRows] = await conn.query(
      'SELECT first_name, last_name, phone FROM users WHERE id = ?',
      [targetUserId]
    );
    if (userRows.length === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    const customer = userRows[0];

    // Get current prices for each service from the services table
    let totalCost = 0;
    const enrichedItems = [];

    for (const item of items) {
      const [svcRows] = await conn.query(
        'SELECT id, service_name, price FROM services WHERE id = ?',
        [item.service_id]
      );
      if (svcRows.length === 0) {
        await conn.rollback();
        return res.status(400).json({ error: `Service ID ${item.service_id} not found` });
      }
      const svc       = svcRows[0];
      const lineTotal = svc.price * item.quantity;
      totalCost      += lineTotal;
      enrichedItems.push({
        service_id: svc.id,
        quantity:   item.quantity,
        unit_price: svc.price,
        line_total: lineTotal,
      });
    }

    // Generate the custom order number
    const orderNumber = await generateOrderNumber(
      customer.first_name, customer.last_name, customer.phone
    );

    // Insert the order
    const [orderResult] = await conn.query(
      `INSERT INTO orders
         (order_number, user_id, pickup_date, pickup_time,
          special_notes, total_cost, created_by_worker)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [orderNumber, targetUserId, pickup_date || null, pickup_time || null,
       special_notes || null, totalCost, isWorker ? 1 : 0]
    );
    const orderId = orderResult.insertId;

    // Insert each order item
    for (const item of enrichedItems) {
      await conn.query(
        `INSERT INTO order_items
           (order_id, service_id, quantity, unit_price, line_total)
         VALUES (?, ?, ?, ?, ?)`,
        [orderId, item.service_id, item.quantity, item.unit_price, item.line_total]
      );
    }

    await conn.commit();

    res.status(201).json({
      message:      'Order created',
      order_id:     orderId,
      order_number: orderNumber,
      total_cost:   totalCost,
    });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    conn.release();
  }
});

// ------------------------------------------------------------------
// GET /orders
// Customers: returns only their own orders.
// Workers:   returns all orders (with optional ?status= filter).
// ------------------------------------------------------------------
app.get('/orders', verifyToken, async (req, res) => {
  try {
    let query, params;

    if (req.user.role === 'worker') {
      // Workers see everything; optional filter by status
      const statusFilter = req.query.status;
      if (statusFilter) {
        query  = 'SELECT * FROM v_order_summary WHERE status = ? ORDER BY created_at DESC';
        params = [statusFilter];
      } else {
        query  = 'SELECT * FROM v_order_summary ORDER BY created_at DESC';
        params = [];
      }
    } else {
      // Customers only see their own orders
      query  = 'SELECT * FROM v_order_summary WHERE customer_phone = ? ORDER BY created_at DESC';
      params = [req.user.phone];
    }

    const [rows] = await db.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ------------------------------------------------------------------
// GET /orders/:id
// Returns a single order with all its items.
// Customers can only view their own orders.
// ------------------------------------------------------------------
app.get('/orders/:id', verifyToken, async (req, res) => {
  try {
    const [orderRows] = await db.query(
      'SELECT * FROM v_order_summary WHERE order_id = ?',
      [req.params.id]
    );

    if (orderRows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderRows[0];

    // Customers can only see their own order
    if (req.user.role === 'customer' && order.customer_phone !== req.user.phone) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get the line items
    const [items] = await db.query(
      `SELECT oi.quantity, oi.unit_price, oi.line_total, s.service_name
       FROM order_items oi
       JOIN services s ON oi.service_id = s.id
       WHERE oi.order_id = ?`,
      [req.params.id]
    );

    res.json({ ...order, items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ------------------------------------------------------------------
// PATCH /orders/:id/status    [WORKER ONLY]
// Updates order status (Pending → Confirmed → Ready → Picked Up)
// Body: { status }
// ------------------------------------------------------------------
app.patch('/orders/:id/status', verifyToken, workerOnly, async (req, res) => {
  const { status } = req.body;
  const validStatuses = ['Pending', 'Confirmed', 'Ready', 'Picked Up', 'Cancelled'];

  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
  }

  try {
    await db.query('UPDATE orders SET status = ? WHERE id = ?', [status, req.params.id]);
    res.json({ message: 'Status updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================================================================
//  SERVICES ROUTE  (the price menu)
// ==================================================================

// ------------------------------------------------------------------
// GET /services
// Returns the full list of services and prices.
// No login required — customers need to see this on the order form.
// ------------------------------------------------------------------
app.get('/services', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM services ORDER BY service_name');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================================================================
//  WORKER-ONLY ROUTES
// ==================================================================

// ------------------------------------------------------------------
// GET /customers                [WORKER ONLY]
// Returns all customers with their total orders and spend.
// ------------------------------------------------------------------
app.get('/customers', verifyToken, workerOnly, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT * FROM v_customer_totals ORDER BY lifetime_spend DESC'
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ------------------------------------------------------------------
// GET /customers/search         [WORKER ONLY]
// Search for a customer by phone number (for walk-in lookup)
// Query: ?phone=6175551234
// ------------------------------------------------------------------
app.get('/customers/search', verifyToken, workerOnly, async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: 'phone query parameter required' });

  try {
    const [rows] = await db.query(
      `SELECT id, first_name, last_name, phone, email
       FROM users WHERE phone LIKE ? AND role = 'customer'`,
      [`%${phone}%`]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ------------------------------------------------------------------
// GET /inventory                [WORKER ONLY]
// Returns all inventory items with vendor info.
// ------------------------------------------------------------------
app.get('/inventory', verifyToken, workerOnly, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT i.*, v.vendor_name, v.phone AS vendor_phone, v.email AS vendor_email
       FROM inventory i
       JOIN vendors v ON i.vendor_id = v.id
       ORDER BY i.item_name`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ------------------------------------------------------------------
// GET /inventory/low            [WORKER ONLY]
// Returns items that are at or below reorder level (low stock alert)
// ------------------------------------------------------------------
app.get('/inventory/low', verifyToken, workerOnly, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM v_low_inventory');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ------------------------------------------------------------------
// GET /vendors                  [WORKER ONLY]
// ------------------------------------------------------------------
app.get('/vendors', verifyToken, workerOnly, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM vendors ORDER BY vendor_name');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ------------------------------------------------------------------
// GET /reports/revenue          [WORKER ONLY]
// Query params: ?range=daily | monthly | quarterly
// Returns aggregated revenue data for Metabase-style reports.
// ------------------------------------------------------------------
app.get('/reports/revenue', verifyToken, workerOnly, async (req, res) => {
  const range = req.query.range || 'monthly';

  let groupBy, dateFormat;
  if (range === 'daily') {
    groupBy    = 'DATE(p.payment_date)';
    dateFormat = '%Y-%m-%d';
  } else if (range === 'quarterly') {
    groupBy    = 'YEAR(p.payment_date), QUARTER(p.payment_date)';
    dateFormat = null; // handled separately below
  } else {
    // monthly (default)
    groupBy    = 'YEAR(p.payment_date), MONTH(p.payment_date)';
    dateFormat = '%Y-%m';
  }

  try {
    let query;
    if (range === 'quarterly') {
      query = `
        SELECT
          YEAR(p.payment_date)    AS year,
          QUARTER(p.payment_date) AS quarter,
          SUM(p.amount_paid)      AS total_revenue,
          COUNT(DISTINCT p.order_id) AS orders_paid
        FROM payments p
        GROUP BY YEAR(p.payment_date), QUARTER(p.payment_date)
        ORDER BY year, quarter`;
    } else {
      query = `
        SELECT
          DATE_FORMAT(p.payment_date, '${dateFormat}') AS period,
          SUM(p.amount_paid)      AS total_revenue,
          COUNT(DISTINCT p.order_id) AS orders_paid
        FROM payments p
        GROUP BY ${groupBy}
        ORDER BY period`;
    }

    const [rows] = await db.query(query);
    res.json(rows);
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