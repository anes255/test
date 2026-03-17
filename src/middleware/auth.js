const jwt = require('jsonwebtoken');
require('dotenv').config();

const authMiddleware = (allowedRoles = []) => {
  return (req, res, next) => {
    try {
      const token = req.headers.authorization?.split(' ')[1];
      if (!token) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = decoded;

      if (allowedRoles.length > 0 && !allowedRoles.includes(decoded.role)) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }

      next();
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Token expired' });
      }
      return res.status(401).json({ error: 'Invalid token' });
    }
  };
};

const storeMiddleware = (req, res, next) => {
  const storeSlug = req.params.storeSlug || req.headers['x-store-slug'];
  if (!storeSlug) {
    return res.status(400).json({ error: 'Store identifier required' });
  }
  req.storeSlug = storeSlug;
  next();
};

const generateToken = (payload, expiresIn = '24h') => {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn });
};

const generateRefreshToken = (payload) => {
  return jwt.sign(payload, process.env.JWT_REFRESH_SECRET, { expiresIn: '30d' });
};

module.exports = { authMiddleware, storeMiddleware, generateToken, generateRefreshToken };
