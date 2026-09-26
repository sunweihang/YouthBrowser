/**
 * 在服务器上为已有账号补绑邮箱或重置密码（需 SSH 登录后执行）：
 *
 *   DATA_DIR=/home/lijin/jianxing-browser/sync-data \
 *   node /home/lijin/jianxing-browser/admin-set-email.js <username> <email> [newPassword]
 *
 * 例：node admin-set-email.js sxy_demo you@qq.com MyNewPass123
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, SCRYPT);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function normalizeEmail(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase();
}

function isValidEmail(email) {
  return (
    email.length >= 5 &&
    email.length <= 120 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  );
}

const username = String(process.argv[2] || '')
  .trim()
  .toLowerCase();
const email = normalizeEmail(process.argv[3]);
const newPassword = process.argv[4] ? String(process.argv[4]) : '';

if (!username || !isValidEmail(email)) {
  console.error('用法: node admin-set-email.js <username> <email> [newPassword]');
  process.exit(1);
}

const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
if (!users[username]) {
  console.error('用户不存在:', username);
  console.error('现有用户:', Object.keys(users).join(', ') || '(无)');
  process.exit(1);
}

for (const [u, row] of Object.entries(users)) {
  if (u !== username && row && normalizeEmail(row.email) === email) {
    console.error('邮箱已被占用:', u);
    process.exit(1);
  }
}

users[username].email = email;
if (newPassword) {
  if (newPassword.length < 6) {
    console.error('密码至少 6 位');
    process.exit(1);
  }
  users[username].passwordHash = hashPassword(newPassword);
}
fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
console.log('已更新', username, 'email=', email, newPassword ? '(密码已重置)' : '');
