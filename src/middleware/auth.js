const jwt = require('jsonwebtoken');

function requireAuth(req, res, next) {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ error: 'محتاج تسجيل دخول' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || 'change-me');
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'الجلسة منتهية، سجّل دخول تاني' });
  }
}

module.exports = { requireAuth };
