const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');

const router = express.Router();

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غلط' });
  }

  const token = jwt.sign({ userId: user.id, username: user.username }, process.env.JWT_SECRET || 'change-me', {
    expiresIn: '7d'
  });

  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000
  });

  res.json({ ok: true, username: user.username });
});

router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  const token = req.cookies?.token;
  if (!token) return res.json({ loggedIn: false });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || 'change-me');
    res.json({ loggedIn: true, username: payload.username });
  } catch {
    res.json({ loggedIn: false });
  }
});

module.exports = router;
