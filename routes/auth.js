const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { auth } = require('../middleware/auth');
const router = express.Router();

// ==================== PLATFORM AUTH ====================

// Store owner registration
router.post('/register', async (req, res) => {
  try {
    const { full_name, email, phone, password, address, city, wilaya } = req.body;
    if (!full_name || !email || !phone || !password) {
      return res.status(400).json({ error: 'All fields are required.' });
    }
    const existing = await pool.query(
      'SELECT id FROM store_owners WHERE email = $1 OR phone = $2', [email, phone]
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Email or phone already registered.' });
    }
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO store_owners (full_name, email, phone, password_hash, address, city, wilaya)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, full_name, email, phone, subscription_plan`,
      [full_name, email, phone, hash, address, city, wilaya]
    );
    const user = result.rows[0];
    const token = jwt.sign(
      { id: user.id, ownerId: user.id, role: 'store_owner', email: user.email },
      process.env.JWT_SECRET, { expiresIn: '7d' }
    );
    res.status(201).json({ user, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// Platform login (admin + store owners)
router.post('/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password) {
      return res.status(400).json({ error: 'Phone and password are required.' });
    }
    // Check if super admin
    if (phone === process.env.ADMIN_PHONE) {
      const admin = await pool.query('SELECT * FROM store_owners WHERE phone = $1', [phone]);
      if (admin.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials.' });
      const valid = await bcrypt.compare(password, admin.rows[0].password_hash);
      if (!valid) return res.status(401).json({ error: 'Invalid credentials.' });
      const token = jwt.sign(
        { id: admin.rows[0].id, role: 'platform_admin', email: admin.rows[0].email },
        process.env.JWT_SECRET, { expiresIn: '7d' }
      );
      return res.json({ user: { ...admin.rows[0], password_hash: undefined, role: 'platform_admin' }, token });
    }
    // Regular store owner login
    const result = await pool.query('SELECT * FROM store_owners WHERE phone = $1', [phone]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials.' });
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials.' });
    if (!user.is_active) return res.status(403).json({ error: 'Account is deactivated.' });
    const token = jwt.sign(
      { id: user.id, ownerId: user.id, role: 'store_owner', email: user.email },
      process.env.JWT_SECRET, { expiresIn: '7d' }
    );
    res.json({ user: { ...user, password_hash: undefined, role: 'store_owner' }, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ==================== STORE STAFF AUTH ====================

// Staff login (select account page)
router.post('/staff/login', async (req, res) => {
  try {
    const { store_id, staff_id, password } = req.body;
    const result = await pool.query(
      'SELECT * FROM store_staff WHERE id = $1 AND store_id = $2', [staff_id, store_id]
    );
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials.' });
    const staff = result.rows[0];
    const valid = await bcrypt.compare(password, staff.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials.' });
    if (!staff.is_active) return res.status(403).json({ error: 'Account deactivated.' });
    await pool.query('UPDATE store_staff SET last_login = NOW() WHERE id = $1', [staff.id]);
    const token = jwt.sign(
      { id: staff.id, storeId: staff.store_id, staffRole: staff.role, name: staff.name },
      process.env.JWT_SECRET, { expiresIn: '12h' }
    );
    res.json({ staff: { ...staff, password_hash: undefined }, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// Get staff list for a store (for "Who's using" screen)
router.get('/staff/list/:store_id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, role, is_active FROM store_staff WHERE store_id = $1 AND is_active = true ORDER BY role`,
      [req.params.store_id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// ==================== CUSTOMER AUTH (per store) ====================

// Customer registration (within a specific store)
router.post('/customer/register', async (req, res) => {
  try {
    const { store_id, full_name, email, phone, password, address, city, wilaya, zip_code } = req.body;
    if (!store_id || !full_name || !phone || !password) {
      return res.status(400).json({ error: 'Required fields missing.' });
    }
    const existing = await pool.query(
      'SELECT id FROM customers WHERE store_id = $1 AND phone = $2', [store_id, phone]
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Phone already registered for this store.' });
    }
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO customers (store_id, full_name, email, phone, password_hash, address, city, wilaya, zip_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, full_name, email, phone`,
      [store_id, full_name, email, phone, hash, address, city, wilaya, zip_code]
    );
    const customer = result.rows[0];
    const token = jwt.sign(
      { id: customer.id, storeId: store_id, role: 'customer', phone: customer.phone },
      process.env.JWT_SECRET, { expiresIn: '30d' }
    );
    res.status(201).json({ customer, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// Customer login (within a specific store)
router.post('/customer/login', async (req, res) => {
  try {
    const { store_id, phone, password } = req.body;
    const result = await pool.query(
      'SELECT * FROM customers WHERE store_id = $1 AND phone = $2', [store_id, phone]
    );
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials.' });
    const customer = result.rows[0];
    const valid = await bcrypt.compare(password, customer.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials.' });
    const token = jwt.sign(
      { id: customer.id, storeId: store_id, role: 'customer', phone: customer.phone },
      process.env.JWT_SECRET, { expiresIn: '30d' }
    );
    res.json({ customer: { ...customer, password_hash: undefined }, token });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// Get current user
router.get('/me', auth, async (req, res) => {
  try {
    if (req.user.role === 'platform_admin' || req.user.role === 'store_owner') {
      const result = await pool.query(
        'SELECT id, full_name, email, phone, subscription_plan, created_at FROM store_owners WHERE id = $1',
        [req.user.id]
      );
      return res.json({ ...result.rows[0], role: req.user.role });
    }
    if (req.user.role === 'customer') {
      const result = await pool.query(
        'SELECT id, full_name, email, phone, address, city, wilaya FROM customers WHERE id = $1',
        [req.user.id]
      );
      return res.json({ ...result.rows[0], role: 'customer' });
    }
    if (req.user.staffRole) {
      const result = await pool.query(
        'SELECT id, name, role, store_id FROM store_staff WHERE id = $1',
        [req.user.id]
      );
      return res.json({ ...result.rows[0], staffRole: result.rows[0]?.role });
    }
    res.status(404).json({ error: 'User not found.' });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
