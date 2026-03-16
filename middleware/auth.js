const jwt = require('jsonwebtoken');
require('dotenv').config();

const auth = (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Access denied. No token provided.' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token.' });
  }
};

const platformAdmin = (req, res, next) => {
  if (req.user?.role !== 'platform_admin') {
    return res.status(403).json({ error: 'Platform admin access required.' });
  }
  next();
};

const storeOwner = (req, res, next) => {
  if (!req.user?.ownerId && req.user?.role !== 'platform_admin') {
    return res.status(403).json({ error: 'Store owner access required.' });
  }
  next();
};

const storeStaff = (allowedRoles = []) => (req, res, next) => {
  if (req.user?.role === 'platform_admin') return next();
  if (req.user?.staffRole) {
    if (allowedRoles.length === 0 || allowedRoles.includes(req.user.staffRole)) {
      return next();
    }
  }
  if (req.user?.ownerId) return next();
  return res.status(403).json({ error: 'Insufficient permissions.' });
};

module.exports = { auth, platformAdmin, storeOwner, storeStaff };
