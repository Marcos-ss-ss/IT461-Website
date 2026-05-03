// ============================================================
//  WDS DryCleaning Group 8 — Backend API
//  File: server.js
//  Run with:  node server.js
// ============================================================
 
require('dotenv').config();
const express  = require('express');
const { Pool } = require('pg');
const bcrypt   = require('bcrypt');
const jwt      = require('jsonwebtoken');
const cors     = require('cors');
const nodemailer = require('nodemailer');
 
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
// EMAIL TRANSPORTER  (uses SMTP_* env vars — set in .env / Render)
// ------------------------------------------------------------------
const mailer = nodemailer.createTransport({
  host:   process.env.SMTP_HOST   || 'smtp.gmail.com',
  port:   parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});
 
// Helper: send email (non-blocking — won't crash route if it fails)
async function sendEmail(to, subject, html) {
  try {
    await mailer.sendMail({
      from: `"WDS Drycleaning" <${process.env.SMTP_USER}>`,
      to,
      subject,
      html,
    });
    console.log(`📧 Email sent to ${to}: ${subject}`);
  } catch (err) {
    console.error('❌ Email error:', err.message);
  }
}
 
// ------------------------------------------------------------------
// HARDCODED WORKER CREDENTIALS
// (These bypass the DB — no DB record required)
// ------------------------------------------------------------------
const WORKER_ACCOUNTS = [
  {
    username:  'WDSEmployee1',
    password:  'EmployeePass1',
    role:      'employee',
    first_name:'Employee',
    last_name: 'One',
    email:     process.env.EMPLOYEE_EMAIL || 'employee@wdsdrycleaning.com',
  },
  {
    username:  'WDSOwner1',
    password:  'OwnerPass1',
    role:      'owner',
    first_name:'Owner',
    last_name: 'One',
    email:     process.env.OWNER_EMAIL || 'washingwds@gmail.com',
  },
];
 
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
// HELPER: workerOnly  (employee OR owner)
// ------------------------------------------------------------------
function workerOnly(req, res, next) {
  if (req.user.role !== 'worker' && req.user.role !== 'employee' && req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Worker access only' });
  }
  next();
}
 
// ------------------------------------------------------------------
// HELPER: ownerOnly
// ------------------------------------------------------------------
function ownerOnly(req, res, next) {
  if (req.user.role !== 'owner' && req.user.role !== 'worker') {
    return res.status(403).json({ error: 'Owner access only' });
  }
  next();
}
 
// ------------------------------------------------------------------
// HELPER: generateOrderNumber
// ------------------------------------------------------------------
async function generateOrderNumber(firstName, lastName, phone) {
  const initials = (firstName[0] + lastName[0]).toUpperCase();
  const last4    = (phone || '0000').replace(/\D/g, '').slice(-4);
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
    const existing = await db.query('SELECT id FROM users WHERE phone = $1', [phone]);
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
// Checks hardcoded worker accounts first, then falls through to DB
app.post('/login', async (req, res) => {
  const { identifier, password } = req.body;
  if (!identifier || !password) {
    return res.status(400).json({ error: 'identifier and password are required' });
  }
 
  // ── 1. Check hardcoded worker accounts (username-based) ──
  const workerAccount = WORKER_ACCOUNTS.find(
    a => a.username === identifier && a.password === password
  );
  if (workerAccount) {
    const token = jwt.sign(
      { id: 0, role: workerAccount.role, first_name: workerAccount.first_name,
        last_name: workerAccount.last_name, email: workerAccount.email },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );
    return res.json({
      token,
      role:       workerAccount.role,
      first_name: workerAccount.first_name,
      last_name:  workerAccount.last_name,
      email:      workerAccount.email,
    });
  }
 
  // ── 2. Fall through to DB (customer or legacy worker accounts) ──
  try {
    const cleanIdentifier = identifier.trim().toLowerCase();
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
        last_name: user.last_name, phone: user.phone, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );
 
    res.json({ token, role: user.role, first_name: user.first_name,
               last_name: user.last_name, email: user.email });
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
  const isWorker = ['worker','employee','owner'].includes(req.user.role);
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
      'SELECT first_name, last_name, phone, email FROM users WHERE id = $1',
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
        service_id:   svc.id,
        service_name: svc.service_name,
        quantity:     item.quantity,
        unit_price:   svc.price,
        line_total:   lineTotal,
      });
    }
 
    const orderNumber = await generateOrderNumber(
      customer.first_name, customer.last_name, customer.phone || '0000'
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
 
    if (['worker','employee','owner'].includes(req.user.role)) {
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
// Handles:
//   → "Ready"     → sends customer email notification
//   → "Picked Up" → marks payment as Paid + records payment
app.patch('/orders/:id/status', verifyToken, workerOnly, async (req, res) => {
  const { status } = req.body;
  const validStatuses = ['Pending', 'Confirmed', 'Ready', 'Picked Up', 'Cancelled'];
 
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
  }
 
  const client = await db.connect();
  try {
    await client.query('BEGIN');
 
    // Fetch current order info + customer
    const orderRes = await client.query(
      `SELECT o.*, u.first_name, u.last_name, u.email AS customer_email, u.phone AS customer_phone
       FROM orders o JOIN users u ON o.user_id = u.id WHERE o.id = $1`,
      [req.params.id]
    );
    if (orderRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }
    const order = orderRes.rows[0];
 
    // Update status
    await client.query('UPDATE orders SET status = $1 WHERE id = $2', [status, req.params.id]);
 
    // ── AUTOMATION 1: Email customer when Ready for Pick-Up ──
    if (status === 'Ready' && order.customer_email) {
      const html = `
        <div style="font-family:Arial,sans-serif;max-width:500px;margin:auto;padding:20px;">
          <img src="https://wds-drycleaning-group-8.onrender.com/WDS-Logo.png"
               alt="WDS" style="width:120px;margin-bottom:16px;">
          <h2 style="color:#0d1b2a;">Your Order Is Ready! 🎉</h2>
          <p>Hi <strong>${order.first_name}</strong>,</p>
          <p>Your dry cleaning order <strong>#${order.order_number}</strong> is ready for pick-up at WDS Drycleaning.</p>
          <table style="border-collapse:collapse;width:100%;margin:16px 0;">
            <tr><td style="padding:8px;font-weight:bold;color:#555;">Order #</td>
                <td style="padding:8px;">${order.order_number}</td></tr>
            <tr style="background:#f5f7fa;"><td style="padding:8px;font-weight:bold;color:#555;">Total</td>
                <td style="padding:8px;">$${parseFloat(order.total_cost).toFixed(2)}</td></tr>
            ${order.pickup_date ? `<tr><td style="padding:8px;font-weight:bold;color:#555;">Pickup Date</td>
                <td style="padding:8px;">${order.pickup_date}</td></tr>` : ''}
          </table>
          <p style="color:#555;font-size:0.9rem;">Please bring this confirmation when picking up your items.</p>
          <p style="color:#0d1b2a;font-weight:bold;">Thank you for choosing WDS Drycleaning!</p>
        </div>`;
      sendEmail(order.customer_email, `Your Order #${order.order_number} is Ready for Pick-Up!`, html);
    }
 
    // ── When Picked Up: mark payment as Paid + insert payment record ──
    if (status === 'Picked Up') {
      await client.query(
        `UPDATE orders SET payment_status = 'Paid' WHERE id = $1`,
        [req.params.id]
      );
      // Record in payments table
      await client.query(
        `INSERT INTO payments (order_id, payment_method, amount_paid)
         VALUES ($1, 'In-Store', $2)`,
        [req.params.id, order.total_cost]
      );
    }
 
    // ── When Cancelled: delete the order entirely ──
    if (status === 'Cancelled') {
      await client.query('DELETE FROM order_items WHERE order_id = $1', [req.params.id]);
      await client.query('DELETE FROM payments WHERE order_id = $1', [req.params.id]);
      await client.query('DELETE FROM orders WHERE id = $1', [req.params.id]);
      await client.query('COMMIT');
      return res.json({ message: 'Order cancelled and deleted' });
    }
 
    await client.query('COMMIT');
    res.json({ message: 'Status updated' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});
 
// ==================================================================
//  SERVICES ROUTE
// ==================================================================
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
    const result = await db.query('SELECT * FROM v_customer_totals ORDER BY lifetime_spend DESC');
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
       FROM inventory i JOIN vendors v ON i.vendor_id = v.id ORDER BY i.item_name`
    );
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
 
// ==================================================================
//  VENDOR ORDERS ROUTES  (new)
// ==================================================================
 
// POST /vendor-orders  — create a new vendor order
// AUTOMATION 2: Emails owner + vendor contact on creation
app.post('/vendor-orders', verifyToken, ownerOnly, async (req, res) => {
  const { vendor_id, item_name, quantity, unit_cost } = req.body;
 
  if (!vendor_id || !item_name || !quantity) {
    return res.status(400).json({ error: 'vendor_id, item_name, and quantity are required' });
  }
 
  try {
    const vendorRes = await db.query(
      'SELECT * FROM vendors WHERE id = $1',
      [vendor_id]
    );
    if (vendorRes.rows.length === 0) {
      return res.status(404).json({ error: 'Vendor not found' });
    }
    const vendor = vendorRes.rows[0];
 
    const cost = parseFloat(unit_cost || 0);
    const total = cost * parseInt(quantity);
 
    const result = await db.query(
      `INSERT INTO vendor_orders (vendor_id, item_name, quantity, unit_cost, total_cost, order_date)
       VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING *`,
      [vendor_id, item_name, parseInt(quantity), cost, total]
    );
    const newOrder = result.rows[0];
 
    // ── AUTOMATION 2: Email owner + vendor contact ──
    const ownerEmail = process.env.OWNER_EMAIL || 'washingwds@gmail.com';
    const orderDate  = new Date(newOrder.order_date).toLocaleDateString();
 
    const emailHtml = `
      <div style="font-family:Arial,sans-serif;max-width:500px;margin:auto;padding:20px;">
        <h2 style="color:#0d1b2a;">New Vendor Order Placed 📦</h2>
        <table style="border-collapse:collapse;width:100%;margin:16px 0;">
          <tr><td style="padding:8px;font-weight:bold;color:#555;">Vendor</td>
              <td style="padding:8px;">${vendor.vendor_name}</td></tr>
          <tr style="background:#f5f7fa;"><td style="padding:8px;font-weight:bold;color:#555;">Item</td>
              <td style="padding:8px;">${item_name}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;color:#555;">Quantity</td>
              <td style="padding:8px;">${quantity}</td></tr>
          <tr style="background:#f5f7fa;"><td style="padding:8px;font-weight:bold;color:#555;">Unit Cost</td>
              <td style="padding:8px;">$${cost.toFixed(2)}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;color:#555;">Total Cost</td>
              <td style="padding:8px;font-weight:bold;">$${total.toFixed(2)}</td></tr>
          <tr style="background:#f5f7fa;"><td style="padding:8px;font-weight:bold;color:#555;">Order Date</td>
              <td style="padding:8px;">${orderDate}</td></tr>
        </table>
        <p style="color:#555;font-size:0.9rem;">This is an automated notification from WDS Drycleaning.</p>
      </div>`;
 
    sendEmail(ownerEmail, `New Vendor Order — ${vendor.vendor_name}: ${item_name}`, emailHtml);
    if (vendor.email) {
      sendEmail(vendor.email, `Order Received from WDS Drycleaning — ${item_name}`, emailHtml);
    }
 
    res.status(201).json({ message: 'Vendor order created', order: newOrder });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});
 
// GET /vendor-orders — list all vendor orders (newest first)
app.get('/vendor-orders', verifyToken, ownerOnly, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT vo.*, v.vendor_name, v.contact_name, v.email AS vendor_email
       FROM vendor_orders vo
       JOIN vendors v ON vo.vendor_id = v.id
       ORDER BY vo.order_date DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});
 
// GET /vendor-orders/search?vendor_id=X
app.get('/vendor-orders/search', verifyToken, ownerOnly, async (req, res) => {
  const { vendor_id, search } = req.query;
  try {
    let query = `
      SELECT vo.*, v.vendor_name, v.contact_name
      FROM vendor_orders vo
      JOIN vendors v ON vo.vendor_id = v.id
      WHERE 1=1`;
    const params = [];
 
    if (vendor_id) {
      params.push(vendor_id);
      query += ` AND vo.vendor_id = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      query += ` AND (vo.item_name ILIKE $${params.length} OR v.vendor_name ILIKE $${params.length})`;
    }
    query += ' ORDER BY vo.order_date DESC';
 
    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});
 
// GET /inventory-items?vendor_id=X — items from inventory for a specific vendor (for dropdown)
app.get('/inventory-items', verifyToken, ownerOnly, async (req, res) => {
  const { vendor_id } = req.query;
  try {
    let query = 'SELECT * FROM inventory';
    const params = [];
    if (vendor_id) {
      query += ' WHERE vendor_id = $1';
      params.push(vendor_id);
    }
    query += ' ORDER BY item_name';
    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});
 
// ==================================================================
//  REVENUE / REPORTS
// ==================================================================
 
// GET /reports/revenue
app.get('/reports/revenue', verifyToken, workerOnly, async (req, res) => {
  const range = req.query.range || 'monthly';
  try {
    let query;
    if (range === 'daily') {
      query = `SELECT payment_date::date AS period,
               SUM(amount_paid) AS total_revenue, COUNT(DISTINCT order_id) AS orders_paid
               FROM payments GROUP BY payment_date::date ORDER BY period`;
    } else if (range === 'quarterly') {
      query = `SELECT EXTRACT(YEAR FROM payment_date) AS year,
               EXTRACT(QUARTER FROM payment_date) AS quarter,
               SUM(amount_paid) AS total_revenue, COUNT(DISTINCT order_id) AS orders_paid
               FROM payments GROUP BY year, quarter ORDER BY year, quarter`;
    } else {
      query = `SELECT TO_CHAR(payment_date, 'YYYY-MM') AS period,
               SUM(amount_paid) AS total_revenue, COUNT(DISTINCT order_id) AS orders_paid
               FROM payments GROUP BY TO_CHAR(payment_date, 'YYYY-MM') ORDER BY period`;
    }
    const result = await db.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});
 
// POST /reports/send-revenue  — AUTOMATION 3: Email revenue report to owner
app.post('/reports/send-revenue', verifyToken, ownerOnly, async (req, res) => {
  try {
    // Pull summary stats
    const totalRes = await db.query(
      `SELECT COALESCE(SUM(amount_paid),0) AS all_time_total,
              COUNT(DISTINCT order_id) AS total_orders
       FROM payments`
    );
    const monthRes = await db.query(
      `SELECT COALESCE(SUM(amount_paid),0) AS monthly_total,
              COUNT(DISTINCT order_id) AS monthly_orders
       FROM payments
       WHERE payment_date >= date_trunc('month', NOW())`
    );
    const recentRes = await db.query(
      `SELECT TO_CHAR(payment_date,'YYYY-MM') AS period,
              SUM(amount_paid) AS revenue, COUNT(DISTINCT order_id) AS orders
       FROM payments
       GROUP BY period ORDER BY period DESC LIMIT 6`
    );
 
    const stats    = totalRes.rows[0];
    const monthly  = monthRes.rows[0];
    const recent   = recentRes.rows;
 
    const rows = recent.map(r =>
      `<tr>
        <td style="padding:8px;border:1px solid #ddd;">${r.period}</td>
        <td style="padding:8px;border:1px solid #ddd;">$${parseFloat(r.revenue).toFixed(2)}</td>
        <td style="padding:8px;border:1px solid #ddd;">${r.orders}</td>
       </tr>`
    ).join('');
 
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:20px;">
        <h2 style="color:#0d1b2a;">WDS Drycleaning — Revenue Report 📊</h2>
        <p style="color:#555;">Generated: ${new Date().toLocaleString()}</p>
 
        <table style="border-collapse:collapse;width:100%;margin:16px 0;">
          <tr style="background:#0d1b2a;color:#fff;">
            <td style="padding:10px;font-weight:bold;">Metric</td>
            <td style="padding:10px;font-weight:bold;">Value</td>
          </tr>
          <tr>
            <td style="padding:8px;border:1px solid #ddd;">All-Time Revenue</td>
            <td style="padding:8px;border:1px solid #ddd;font-weight:bold;">$${parseFloat(stats.all_time_total).toFixed(2)}</td>
          </tr>
          <tr style="background:#f5f7fa;">
            <td style="padding:8px;border:1px solid #ddd;">All-Time Orders Paid</td>
            <td style="padding:8px;border:1px solid #ddd;">${stats.total_orders}</td>
          </tr>
          <tr>
            <td style="padding:8px;border:1px solid #ddd;">This Month Revenue</td>
            <td style="padding:8px;border:1px solid #ddd;font-weight:bold;">$${parseFloat(monthly.monthly_total).toFixed(2)}</td>
          </tr>
          <tr style="background:#f5f7fa;">
            <td style="padding:8px;border:1px solid #ddd;">This Month Orders</td>
            <td style="padding:8px;border:1px solid #ddd;">${monthly.monthly_orders}</td>
          </tr>
        </table>
 
        <h3 style="color:#0d1b2a;margin-top:24px;">Recent Monthly Breakdown</h3>
        <table style="border-collapse:collapse;width:100%;">
          <tr style="background:#1565c0;color:#fff;">
            <th style="padding:8px;border:1px solid #ddd;text-align:left;">Month</th>
            <th style="padding:8px;border:1px solid #ddd;text-align:left;">Revenue</th>
            <th style="padding:8px;border:1px solid #ddd;text-align:left;">Orders</th>
          </tr>
          ${rows || '<tr><td colspan="3" style="padding:8px;text-align:center;">No payment data yet</td></tr>'}
        </table>
 
        <p style="margin-top:20px;color:#555;font-size:0.85rem;">
          This report was sent from WDS Drycleaning management system.
        </p>
      </div>`;
 
    const ownerEmail = process.env.OWNER_EMAIL || 'washingwds@gmail.com';
    await sendEmail(ownerEmail, `WDS Revenue Report — ${new Date().toLocaleDateString()}`, html);
 
    res.json({ message: 'Revenue report sent to ' + ownerEmail });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});
 
// ==================================================================
//  START SERVER
// ==================================================================
app.listen(PORT, () => {
  console.log(`\n WDS DryCleaning API running on http://localhost:${PORT}`);
  console.log('\n Worker Accounts:');
  WORKER_ACCOUNTS.forEach(a =>
    console.log(`   ${a.role.toUpperCase()}: ${a.username} / ${a.password}`)
  );
  console.log('\n Routes:');
  console.log('   POST   /register');
  console.log('   POST   /login');
  console.log('   GET    /services');
  console.log('   POST   /orders                (login required)');
  console.log('   GET    /orders                (login required)');
  console.log('   GET    /orders/:id            (login required)');
  console.log('   PATCH  /orders/:id/status     (worker only)');
  console.log('   GET    /customers             (worker only)');
  console.log('   GET    /customers/search      (worker only)');
  console.log('   GET    /inventory             (worker only)');
  console.log('   GET    /vendors               (worker only)');
  console.log('   POST   /vendor-orders         (owner only)');
  console.log('   GET    /vendor-orders         (owner only)');
  console.log('   GET    /vendor-orders/search  (owner only)');
  console.log('   GET    /inventory-items       (owner only)');
  console.log('   GET    /reports/revenue       (worker only)');
  console.log('   POST   /reports/send-revenue  (owner only)\n');
});
