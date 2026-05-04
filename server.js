// ============================================================
//  WDS DryCleaning Group 8 — Backend API  (server.js)
//  Run:  node server.js
// ============================================================
 
require('dotenv').config();
const express    = require('express');
const { Pool }   = require('pg');
const bcrypt     = require('bcrypt');
const jwt        = require('jsonwebtoken');
const cors       = require('cors');
const nodemailer = require('nodemailer');
 
const app  = express();
const PORT = process.env.PORT || 3000;
 
// ── Middleware ────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
 
// ── Database pool ─────────────────────────────────────────────
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});
 
// ── Email transporter ─────────────────────────────────────────
const mailer = nodemailer.createTransport({
  host:   process.env.SMTP_HOST   || 'smtp.gmail.com',
  port:   parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});
 
// Revenue report always goes to BOTH addresses
const REPORT_RECIPIENTS = [
  process.env.OWNER_EMAIL || 'washingwds@gmail.com',
  'wds.drycleaning@gmail.com',
];
 
async function sendEmail(to, subject, html) {
  try {
    const recipients = Array.isArray(to) ? to.join(', ') : to;
    await mailer.sendMail({
      from: `"WDS Drycleaning" <${process.env.SMTP_USER}>`,
      to: recipients,
      subject,
      html,
    });
    console.log(`Email sent to ${recipients}`);
  } catch (err) {
    console.error('Email error:', err.message);
  }
}
 
// ── Hardcoded staff accounts ──────────────────────────────────
const STAFF_ACCOUNTS = [
  {
    username:   'WDSEmployee1',
    password:   'EmployeePass1',
    role:       'employee',
    first_name: 'Employee',
    last_name:  'One',
    email:      process.env.EMPLOYEE_EMAIL || 'employee@wdsdrycleaning.com',
  },
  {
    username:   'WDSOwner1',
    password:   'OwnerPass1',
    role:       'owner',
    first_name: 'Owner',
    last_name:  'One',
    email:      process.env.OWNER_EMAIL || 'washingwds@gmail.com',
  },
];
 
// ── Auth middleware ───────────────────────────────────────────
function verifyToken(req, res, next) {
  const header = req.headers['authorization'];
  const token  = header && header.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
}
 
function staffOnly(req, res, next) {
  if (!['worker', 'employee', 'owner'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Staff access only' });
  }
  next();
}
 
function ownerOnly(req, res, next) {
  if (!['owner', 'worker'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Owner access only' });
  }
  next();
}
 
// ── Order number generator ────────────────────────────────────
async function generateOrderNumber(firstName, lastName, phone) {
  const initials = (firstName[0] + lastName[0]).toUpperCase();
  const last4    = (phone || '0000').replace(/\D/g, '').slice(-4);
  const prefix   = initials + last4;
 
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT next_seq FROM order_number_seq WHERE prefix = $1 FOR UPDATE', [prefix]
    );
    let nextSeq = 1;
    if (rows.length === 0) {
      await client.query('INSERT INTO order_number_seq (prefix, next_seq) VALUES ($1, 2)', [prefix]);
    } else {
      nextSeq = rows[0].next_seq;
      await client.query('UPDATE order_number_seq SET next_seq = next_seq + 1 WHERE prefix = $1', [prefix]);
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
 
// ── Date filter helper ────────────────────────────────────────
function rangeFilter(range, tableAlias) {
  const col = tableAlias ? `${tableAlias}.created_at` : 'created_at';
  switch (range) {
    case 'weekly':    return `${col} >= date_trunc('week',    NOW())`;
    case 'quarterly': return `${col} >= date_trunc('quarter', NOW())`;
    case 'yearly':    return `${col} >= date_trunc('year',    NOW())`;
    default:          return `${col} >= date_trunc('month',   NOW())`;  // monthly
  }
}
 
function vendorRangeFilter(range) {
  switch (range) {
    case 'weekly':    return `order_date >= date_trunc('week',    NOW())`;
    case 'quarterly': return `order_date >= date_trunc('quarter', NOW())`;
    case 'yearly':    return `order_date >= date_trunc('year',    NOW())`;
    default:          return `order_date >= date_trunc('month',   NOW())`;
  }
}
 
// ==================================================================
//  AUTH
// ==================================================================
 
app.post('/register', async (req, res) => {
  const { first_name, last_name, phone, email, password } = req.body;
  if (!first_name || !last_name || !phone || !password) {
    return res.status(400).json({ error: 'first_name, last_name, phone, and password are required' });
  }
  try {
    const existing = await db.query('SELECT id FROM users WHERE phone = $1', [phone]);
    if (existing.rows.length > 0) return res.status(409).json({ error: 'Phone number already registered' });
 
    const password_hash = await bcrypt.hash(password, 10);
    const result = await db.query(
      `INSERT INTO users (first_name, last_name, phone, email, password_hash, role)
       VALUES ($1,$2,$3,$4,$5,'customer') RETURNING id`,
      [first_name, last_name, phone, email || null, password_hash]
    );
    res.status(201).json({ message: 'Account created', userId: result.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});
 
app.post('/login', async (req, res) => {
  const { identifier, password } = req.body;
  if (!identifier || !password) {
    return res.status(400).json({ error: 'identifier and password are required' });
  }
 
  // 1. Hardcoded staff check (username match)
  const staff = STAFF_ACCOUNTS.find(a => a.username === identifier && a.password === password);
  if (staff) {
    const token = jwt.sign(
      { id: 0, role: staff.role, first_name: staff.first_name,
        last_name: staff.last_name, email: staff.email },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );
    return res.json({ token, role: staff.role, first_name: staff.first_name,
                      last_name: staff.last_name, email: staff.email });
  }
 
  // 2. DB login (customers)
  try {
    const clean   = identifier.trim().toLowerCase();
    const isPhone = /^\d+$/.test(identifier.replace(/\D/g, '')) && identifier.length >= 7;
    const field   = isPhone ? 'phone' : 'email';
 
    const result = await db.query(
      `SELECT id, first_name, last_name, phone, email, password_hash, role
       FROM users WHERE LOWER(${field}) = $1`,
      [clean]
    );
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
 
    const user  = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });
 
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
//  ORDERS
// ==================================================================
 
app.post('/orders', verifyToken, async (req, res) => {
  const isStaff      = ['worker','employee','owner'].includes(req.user.role);
  let   targetUserId = req.user.id;
  if (isStaff && req.body.user_id) targetUserId = req.body.user_id;
 
  const { pickup_date, pickup_time, special_notes, items } = req.body;
  if (!items || items.length === 0) {
    return res.status(400).json({ error: 'Order must have at least one item' });
  }
 
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const userRes = await client.query(
      'SELECT first_name, last_name, phone, email FROM users WHERE id = $1', [targetUserId]
    );
    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    const customer = userRes.rows[0];
 
    let totalCost = 0;
    const enriched = [];
    for (const item of items) {
      const svcRes = await client.query('SELECT id, price FROM services WHERE id = $1', [item.service_id]);
      if (svcRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Service ${item.service_id} not found` });
      }
      const svc       = svcRes.rows[0];
      const lineTotal = svc.price * item.quantity;
      totalCost      += lineTotal;
      enriched.push({ service_id: svc.id, quantity: item.quantity,
                      unit_price: svc.price, line_total: lineTotal });
    }
 
    const orderNumber = await generateOrderNumber(
      customer.first_name, customer.last_name, customer.phone || '0000'
    );
 
    const orderRes = await client.query(
      `INSERT INTO orders (order_number, user_id, pickup_date, pickup_time,
         special_notes, total_cost, created_by_worker)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [orderNumber, targetUserId, pickup_date||null, pickup_time||null,
       special_notes||null, totalCost, isStaff]
    );
    const orderId = orderRes.rows[0].id;
 
    for (const item of enriched) {
      await client.query(
        `INSERT INTO order_items (order_id, service_id, quantity, unit_price, line_total)
         VALUES ($1,$2,$3,$4,$5)`,
        [orderId, item.service_id, item.quantity, item.unit_price, item.line_total]
      );
    }
 
    await client.query('COMMIT');
    res.status(201).json({ message:'Order created', order_id:orderId,
                           order_number:orderNumber, total_cost:totalCost });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});
 
app.get('/orders', verifyToken, async (req, res) => {
  try {
    let query, params;
    if (['worker','employee','owner'].includes(req.user.role)) {
      const sf = req.query.status;
      query  = sf
        ? 'SELECT * FROM v_order_summary WHERE status = $1 ORDER BY created_at DESC'
        : 'SELECT * FROM v_order_summary ORDER BY created_at DESC';
      params = sf ? [sf] : [];
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
 
app.get('/orders/:id', verifyToken, async (req, res) => {
  try {
    const orderRes = await db.query('SELECT * FROM v_order_summary WHERE order_id = $1', [req.params.id]);
    if (orderRes.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const order = orderRes.rows[0];
    if (req.user.role === 'customer' && order.customer_phone !== req.user.phone) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const itemsRes = await db.query(
      `SELECT oi.quantity, oi.unit_price, oi.line_total, s.service_name
       FROM order_items oi JOIN services s ON oi.service_id = s.id WHERE oi.order_id = $1`,
      [req.params.id]
    );
    res.json({ ...order, items: itemsRes.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});
 
app.patch('/orders/:id/status', verifyToken, staffOnly, async (req, res) => {
  const { status } = req.body;
  const valid = ['Pending', 'Confirmed', 'Ready', 'Picked Up', 'Cancelled'];
  if (!valid.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${valid.join(', ')}` });
  }
 
  const client = await db.connect();
  try {
    await client.query('BEGIN');
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
 
    if (status === 'Cancelled') {
      await client.query('DELETE FROM order_items WHERE order_id = $1', [req.params.id]);
      await client.query('DELETE FROM payments   WHERE order_id = $1', [req.params.id]);
      await client.query('DELETE FROM orders     WHERE id = $1',       [req.params.id]);
      await client.query('COMMIT');
      return res.json({ message: 'Order cancelled and deleted' });
    }
 
    await client.query('UPDATE orders SET status = $1 WHERE id = $2', [status, req.params.id]);
 
    if (status === 'Ready' && order.customer_email) {
      const html = `
        <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px;">
          <h2 style="color:#0d1b2a;">Your Order Is Ready for Pick-Up!</h2>
          <p>Hi <strong>${order.first_name}</strong>, order <strong>#${order.order_number}</strong> is ready.</p>
          <p><strong>Total: $${parseFloat(order.total_cost).toFixed(2)}</strong></p>
          ${order.pickup_date ? `<p>Pickup Date: ${order.pickup_date}</p>` : ''}
          <p style="color:#555;">Thank you for choosing WDS Drycleaning!</p>
        </div>`;
      sendEmail(order.customer_email, `Order #${order.order_number} Ready for Pick-Up!`, html);
    }
 
    if (status === 'Picked Up') {
      await client.query(`UPDATE orders SET payment_status = 'Paid' WHERE id = $1`, [req.params.id]);
      const existingPmt = await client.query('SELECT id FROM payments WHERE order_id = $1', [req.params.id]);
      if (existingPmt.rows.length === 0) {
        await client.query(
          `INSERT INTO payments (order_id, payment_method, amount_paid) VALUES ($1,'In-Store',$2)`,
          [req.params.id, order.total_cost]
        );
      }
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
//  SERVICES
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
//  CUSTOMERS
// ==================================================================
app.get('/customers', verifyToken, staffOnly, async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM v_customer_totals ORDER BY lifetime_spend DESC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});
 
app.get('/customers/search', verifyToken, staffOnly, async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  try {
    const result = await db.query(
      `SELECT id, first_name, last_name, phone, email FROM users
       WHERE phone LIKE $1 AND role = 'customer'`,
      [`%${phone}%`]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});
 
// ==================================================================
//  INVENTORY & VENDORS
// ==================================================================
app.get('/inventory', verifyToken, staffOnly, async (req, res) => {
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
 
app.get('/vendors', verifyToken, staffOnly, async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM vendors ORDER BY vendor_name');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});
 
// ==================================================================
//  VENDOR ORDERS
// ==================================================================
app.post('/vendor-orders', verifyToken, ownerOnly, async (req, res) => {
  const { vendor_id, item_name, quantity, unit_cost } = req.body;
  if (!vendor_id || !item_name || !quantity) {
    return res.status(400).json({ error: 'vendor_id, item_name, and quantity are required' });
  }
  try {
    const vendorRes = await db.query('SELECT * FROM vendors WHERE id = $1', [vendor_id]);
    if (vendorRes.rows.length === 0) return res.status(404).json({ error: 'Vendor not found' });
    const vendor = vendorRes.rows[0];
    const cost   = parseFloat(unit_cost || 0);
    const total  = cost * parseInt(quantity);
 
    const result = await db.query(
      `INSERT INTO vendor_orders (vendor_id, item_name, quantity, unit_cost, total_cost, order_date)
       VALUES ($1,$2,$3,$4,$5,NOW()) RETURNING *`,
      [vendor_id, item_name, parseInt(quantity), cost, total]
    );
    const newOrder = result.rows[0];
    const orderDate = new Date(newOrder.order_date).toLocaleDateString();
 
    const emailHtml = `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px;">
        <h2 style="color:#0d1b2a;">New Vendor Order Placed</h2>
        <p><strong>Vendor:</strong> ${vendor.vendor_name}</p>
        <p><strong>Item:</strong> ${item_name}</p>
        <p><strong>Qty:</strong> ${quantity} &nbsp; <strong>Unit:</strong> $${cost.toFixed(2)}</p>
        <p><strong>Total:</strong> $${total.toFixed(2)}</p>
        <p><strong>Date:</strong> ${orderDate}</p>
      </div>`;
 
    const ownerEmail = process.env.OWNER_EMAIL || 'washingwds@gmail.com';
    sendEmail(ownerEmail, `Vendor Order — ${vendor.vendor_name}: ${item_name}`, emailHtml);
    if (vendor.email) sendEmail(vendor.email, `Order from WDS Drycleaning — ${item_name}`, emailHtml);
 
    res.status(201).json({ message: 'Vendor order created', order: newOrder });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});
 
app.get('/vendor-orders', verifyToken, ownerOnly, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT vo.*, v.vendor_name, v.contact_name, v.email AS vendor_email
       FROM vendor_orders vo JOIN vendors v ON vo.vendor_id = v.id ORDER BY vo.order_date DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});
 
app.get('/vendor-orders/search', verifyToken, ownerOnly, async (req, res) => {
  const { vendor_id, search } = req.query;
  try {
    let query  = `SELECT vo.*, v.vendor_name, v.contact_name FROM vendor_orders vo
                  JOIN vendors v ON vo.vendor_id = v.id WHERE 1=1`;
    const params = [];
    if (vendor_id) { params.push(vendor_id);     query += ` AND vo.vendor_id = $${params.length}`; }
    if (search)    { params.push(`%${search}%`); query += ` AND (vo.item_name ILIKE $${params.length} OR v.vendor_name ILIKE $${params.length})`; }
    query += ' ORDER BY vo.order_date DESC';
    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});
 
app.get('/inventory-items', verifyToken, ownerOnly, async (req, res) => {
  const { vendor_id } = req.query;
  try {
    let query = 'SELECT * FROM inventory';
    const params = [];
    if (vendor_id) { query += ' WHERE vendor_id = $1'; params.push(vendor_id); }
    query += ' ORDER BY item_name';
    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});
 
// ==================================================================
//  REVENUE & ANALYTICS  (owner only)
//
//  IMPORTANT: Revenue is pulled from the ORDERS table (total_cost),
//  NOT the payments table, so data shows even before payments are
//  fully recorded. Vendor costs come from vendor_orders.total_cost.
// ==================================================================
 
// GET /reports/summary?range=weekly|monthly|quarterly|yearly
// KPI cards: period revenue, profit, orders, top service, all-time
app.get('/reports/summary', verifyToken, ownerOnly, async (req, res) => {
  const range = req.query.range || 'monthly';
  const oFilter = rangeFilter(range, 'o');
  const vFilter = vendorRangeFilter(range);
 
  try {
    const [periodRes, allTimeRes, costRes, topSvcRes] = await Promise.all([
      // Revenue for the selected period
      db.query(
        `SELECT COALESCE(SUM(o.total_cost),0) AS period_revenue,
                COUNT(o.id)                    AS period_orders
         FROM orders o WHERE ${oFilter} AND o.status != 'Cancelled'`
      ),
      // All-time revenue
      db.query(
        `SELECT COALESCE(SUM(total_cost),0) AS all_time_revenue,
                COUNT(id)                    AS all_time_orders
         FROM orders WHERE status != 'Cancelled'`
      ),
      // Vendor costs for same period
      db.query(`SELECT COALESCE(SUM(total_cost),0) AS vendor_costs FROM vendor_orders WHERE ${vFilter}`),
      // Top service this period
      db.query(
        `SELECT s.service_name,
                SUM(oi.quantity)   AS total_qty,
                SUM(oi.line_total) AS total_revenue
         FROM order_items oi
         JOIN orders   o ON oi.order_id   = o.id
         JOIN services s ON oi.service_id = s.id
         WHERE ${oFilter} AND o.status != 'Cancelled'
         GROUP BY s.service_name ORDER BY total_revenue DESC LIMIT 1`
      ),
    ]);
 
    const period  = periodRes.rows[0];
    const allTime = allTimeRes.rows[0];
    const costs   = costRes.rows[0];
    const topSvc  = topSvcRes.rows[0];
    const profit  = parseFloat(period.period_revenue) - parseFloat(costs.vendor_costs);
 
    res.json({
      period_revenue:   parseFloat(period.period_revenue).toFixed(2),
      period_orders:    parseInt(period.period_orders),
      all_time_revenue: parseFloat(allTime.all_time_revenue).toFixed(2),
      all_time_orders:  parseInt(allTime.all_time_orders),
      vendor_costs:     parseFloat(costs.vendor_costs).toFixed(2),
      estimated_profit: profit.toFixed(2),
      top_service: topSvc
        ? { name: topSvc.service_name, qty: parseInt(topSvc.total_qty),
            revenue: parseFloat(topSvc.total_revenue).toFixed(2) }
        : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});
 
// GET /reports/revenue?range=weekly|monthly|quarterly|yearly
// Period-by-period rows for timeline chart + breakdown table
app.get('/reports/revenue', verifyToken, ownerOnly, async (req, res) => {
  const range = req.query.range || 'monthly';
 
  // How to group the date column into a readable label
  let periodExpr;
  switch (range) {
    case 'weekly':    periodExpr = `TO_CHAR(o.created_at, 'Dy MM/DD')`;       break;
    case 'quarterly': periodExpr = `'W' || TO_CHAR(o.created_at, 'IW YYYY')`; break;
    case 'yearly':    periodExpr = `TO_CHAR(o.created_at, 'Mon YYYY')`;        break;
    default:          periodExpr = `TO_CHAR(o.created_at, 'MM/DD')`;           break;
  }
 
  let vPeriodExpr;
  switch (range) {
    case 'weekly':    vPeriodExpr = `TO_CHAR(order_date, 'Dy MM/DD')`;        break;
    case 'quarterly': vPeriodExpr = `'W' || TO_CHAR(order_date, 'IW YYYY')`;  break;
    case 'yearly':    vPeriodExpr = `TO_CHAR(order_date, 'Mon YYYY')`;          break;
    default:          vPeriodExpr = `TO_CHAR(order_date, 'MM/DD')`;             break;
  }
 
  try {
    const [revRes, costRes] = await Promise.all([
      db.query(
        `SELECT ${periodExpr}         AS period,
                MIN(o.created_at)::date AS sort_date,
                SUM(o.total_cost)     AS revenue,
                COUNT(o.id)           AS orders
         FROM orders o
         WHERE o.status != 'Cancelled'
         GROUP BY period ORDER BY sort_date ASC`
      ),
      db.query(
        `SELECT ${vPeriodExpr} AS period, SUM(total_cost) AS vendor_costs
         FROM vendor_orders GROUP BY period`
      ),
    ]);
 
    const costMap = {};
    costRes.rows.forEach(r => { costMap[r.period] = parseFloat(r.vendor_costs || 0); });
 
    const rows = revRes.rows.map(r => {
      const rev   = parseFloat(r.revenue || 0);
      const costs = costMap[r.period] || 0;
      return {
        period:       r.period,
        revenue:      rev.toFixed(2),
        orders:       parseInt(r.orders),
        vendor_costs: costs.toFixed(2),
        profit:       (rev - costs).toFixed(2),
      };
    });
 
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});
 
// GET /reports/services?range=...
// Revenue + qty by service for pie / bar charts
app.get('/reports/services', verifyToken, ownerOnly, async (req, res) => {
  const range  = req.query.range || 'monthly';
  const filter = rangeFilter(range, 'o');
  try {
    const result = await db.query(
      `SELECT s.service_name,
              SUM(oi.quantity)   AS total_qty,
              SUM(oi.line_total) AS total_revenue
       FROM order_items oi
       JOIN orders   o ON oi.order_id   = o.id
       JOIN services s ON oi.service_id = s.id
       WHERE ${filter} AND o.status != 'Cancelled'
       GROUP BY s.service_name ORDER BY total_revenue DESC`
    );
    res.json(result.rows.map(r => ({
      service_name:  r.service_name,
      total_qty:     parseInt(r.total_qty),
      total_revenue: parseFloat(r.total_revenue).toFixed(2),
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});
 
// GET /reports/clv?phone=XXXX
// Without phone → top 3 spenders; with phone → search result
app.get('/reports/clv', verifyToken, ownerOnly, async (req, res) => {
  const { phone } = req.query;
  try {
    const wherePhone = phone ? `AND u.phone LIKE $1` : '';
    const params     = phone ? [`%${phone}%`] : [];
 
    const result = await db.query(
      `SELECT u.first_name, u.last_name, u.phone, u.email,
              COUNT(o.id)                    AS total_orders,
              COALESCE(SUM(o.total_cost), 0) AS lifetime_spend,
              MAX(o.created_at)              AS last_order_date
       FROM users u
       LEFT JOIN orders o ON o.user_id = u.id AND o.status != 'Cancelled'
       WHERE u.role = 'customer' ${wherePhone}
       GROUP BY u.id, u.first_name, u.last_name, u.phone, u.email
       ORDER BY lifetime_spend DESC
       LIMIT ${phone ? 10 : 3}`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});
 
// POST /reports/send-revenue
// Emails full HTML report + CSV attachment to BOTH addresses
app.post('/reports/send-revenue', verifyToken, ownerOnly, async (req, res) => {
  try {
    const [monthlyRes, allTimeRes, topSvcRes, vendorCostRes] = await Promise.all([
      db.query(
        `SELECT TO_CHAR(o.created_at, 'YYYY-MM') AS month,
                SUM(o.total_cost) AS revenue, COUNT(o.id) AS orders
         FROM orders o WHERE o.status != 'Cancelled'
         GROUP BY month ORDER BY month DESC LIMIT 24`
      ),
      db.query(
        `SELECT COALESCE(SUM(total_cost),0) AS total, COUNT(id) AS orders
         FROM orders WHERE status != 'Cancelled'`
      ),
      db.query(
        `SELECT s.service_name, SUM(oi.quantity) AS qty, SUM(oi.line_total) AS rev
         FROM order_items oi
         JOIN orders   o ON oi.order_id   = o.id
         JOIN services s ON oi.service_id = s.id
         WHERE o.status != 'Cancelled'
         GROUP BY s.service_name ORDER BY rev DESC LIMIT 5`
      ),
      db.query(`SELECT COALESCE(SUM(total_cost),0) AS total FROM vendor_orders`),
    ]);
 
    const allTime     = allTimeRes.rows[0];
    const vendorCosts = parseFloat(vendorCostRes.rows[0].total);
    const totalRev    = parseFloat(allTime.total);
    const profit      = totalRev - vendorCosts;
    const generated   = new Date().toLocaleString();
 
    // Build CSV
    const csv = 'Month,Revenue,Orders\n' +
      monthlyRes.rows.map(r =>
        `${r.month},$${parseFloat(r.revenue).toFixed(2)},${r.orders}`
      ).join('\n');
 
    // Build HTML table rows
    const tableRows = monthlyRes.rows.map((r, i) =>
      `<tr style="background:${i%2===0?'#fff':'#f9f9f9'}">
        <td style="padding:8px 12px;border:1px solid #e0e0e0;">${r.month}</td>
        <td style="padding:8px 12px;border:1px solid #e0e0e0;font-weight:700;">$${parseFloat(r.revenue).toFixed(2)}</td>
        <td style="padding:8px 12px;border:1px solid #e0e0e0;">${r.orders}</td>
       </tr>`
    ).join('');
 
    const svcRows = topSvcRes.rows.map(r =>
      `<tr>
        <td style="padding:6px 12px;border:1px solid #e0e0e0;">${r.service_name}</td>
        <td style="padding:6px 12px;border:1px solid #e0e0e0;">${r.qty}</td>
        <td style="padding:6px 12px;border:1px solid #e0e0e0;font-weight:700;">$${parseFloat(r.rev).toFixed(2)}</td>
       </tr>`
    ).join('');
 
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:680px;margin:auto;padding:28px;color:#1a1a2e;">
        <h1 style="color:#0d1b2a;margin-bottom:4px;">WDS Drycleaning — Revenue Report</h1>
        <p style="color:#888;font-size:0.85rem;margin-bottom:24px;">Generated: ${generated}</p>
 
        <table style="border-collapse:collapse;width:100%;margin-bottom:28px;">
          <tr style="background:#0d1b2a;color:#fff;">
            <td style="padding:10px 14px;font-weight:bold;" colspan="2">Summary</td></tr>
          <tr><td style="padding:8px 14px;border:1px solid #e0e0e0;">All-Time Revenue</td>
              <td style="padding:8px 14px;border:1px solid #e0e0e0;font-weight:bold;">$${totalRev.toFixed(2)}</td></tr>
          <tr style="background:#f5f7fa;">
              <td style="padding:8px 14px;border:1px solid #e0e0e0;">Total Orders</td>
              <td style="padding:8px 14px;border:1px solid #e0e0e0;">${allTime.orders}</td></tr>
          <tr><td style="padding:8px 14px;border:1px solid #e0e0e0;">Total Vendor Costs</td>
              <td style="padding:8px 14px;border:1px solid #e0e0e0;color:#c0392b;">$${vendorCosts.toFixed(2)}</td></tr>
          <tr style="background:#f5f7fa;">
              <td style="padding:8px 14px;border:1px solid #e0e0e0;font-weight:bold;">Estimated Profit</td>
              <td style="padding:8px 14px;border:1px solid #e0e0e0;font-weight:bold;color:${profit>=0?'#2e7d32':'#c0392b'};">$${profit.toFixed(2)}</td></tr>
        </table>
 
        <h3 style="color:#0d1b2a;margin-bottom:10px;">Monthly Breakdown</h3>
        <table style="border-collapse:collapse;width:100%;margin-bottom:28px;">
          <tr style="background:#1565c0;color:#fff;">
            <th style="padding:8px 12px;text-align:left;">Month</th>
            <th style="padding:8px 12px;text-align:left;">Revenue</th>
            <th style="padding:8px 12px;text-align:left;">Orders</th></tr>
          ${tableRows || '<tr><td colspan="3" style="padding:10px;text-align:center;color:#888;">No data yet</td></tr>'}
        </table>
 
        <h3 style="color:#0d1b2a;margin-bottom:10px;">Top Services</h3>
        <table style="border-collapse:collapse;width:100%;margin-bottom:24px;">
          <tr style="background:#1565c0;color:#fff;">
            <th style="padding:8px 12px;text-align:left;">Service</th>
            <th style="padding:8px 12px;text-align:left;">Qty</th>
            <th style="padding:8px 12px;text-align:left;">Revenue</th></tr>
          ${svcRows || '<tr><td colspan="3" style="padding:10px;text-align:center;color:#888;">No data yet</td></tr>'}
        </table>
 
        <p style="font-size:0.8rem;color:#aaa;">CSV export attached. — WDS Drycleaning System</p>
      </div>`;
 
    await mailer.sendMail({
      from:        `"WDS Drycleaning" <${process.env.SMTP_USER}>`,
      to:          REPORT_RECIPIENTS.join(', '),
      subject:     `WDS Revenue Report — ${new Date().toLocaleDateString()}`,
      html,
      attachments: [{
        filename:    `WDS_Revenue_${new Date().toISOString().slice(0,10)}.csv`,
        content:     csv,
        contentType: 'text/csv',
      }],
    });
 
    res.json({ message: `Report sent to ${REPORT_RECIPIENTS.join(' & ')}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});
 
// ==================================================================
//  START SERVER
// ==================================================================
app.listen(PORT, () => {
  console.log(`\n WDS DryCleaning API — http://localhost:${PORT}\n`);
  console.log(' Staff accounts:');
  STAFF_ACCOUNTS.forEach(a =>
    console.log(`   [${a.role}]  ${a.username} / ${a.password}`)
  );
  console.log('\n Report recipients:', REPORT_RECIPIENTS.join(', '));
  console.log('\n All routes ready.\n');
});
 
