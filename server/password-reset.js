const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_INTERVAL_MS = 60 * 1000;
const MAX_SENDS_PER_HOUR = 5;
const MAX_ATTEMPTS = 5;

function createPasswordReset(dataDir) {
  const file = () => path.join(dataDir, 'password_resets.json');

  function now() {
    return Date.now();
  }

  function readStore() {
    try {
      if (fs.existsSync(file())) {
        return JSON.parse(fs.readFileSync(file(), 'utf8')) || {};
      }
    } catch {
      // ignore
    }
    return {};
  }

  function writeStore(store) {
    fs.mkdirSync(dataDir, { recursive: true });
    const cutoff = now() - 24 * 60 * 60 * 1000;
    for (const [key, item] of Object.entries(store)) {
      if (!item || (item.expiresAt && item.expiresAt < cutoff)) {
        delete store[key];
      }
    }
    fs.writeFileSync(file(), JSON.stringify(store, null, 2), 'utf8');
  }

  function storeKey(purpose, userId) {
    return `${purpose}:${userId}`;
  }

  function hashCode(userId, code) {
    return crypto.createHash('sha256').update(`${userId}:${code}`).digest('hex');
  }

  function generateCode() {
    return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  }

  function createChallenge(userId, email, purpose) {
    const store = readStore();
    const key = storeKey(purpose, userId);
    const item = store[key];
    const ts = now();
    if (item) {
      if (ts - (item.lastSentAt || 0) < RESEND_INTERVAL_MS) {
        const wait = Math.ceil((RESEND_INTERVAL_MS - (ts - item.lastSentAt)) / 1000);
        const err = new Error(`请 ${wait} 秒后再获取验证码`);
        err.status = 429;
        err.error = err.message;
        throw err;
      }
      const recent = (item.sendTimes || []).filter((t) => ts - t < 60 * 60 * 1000);
      if (recent.length >= MAX_SENDS_PER_HOUR) {
        const err = new Error('验证码发送过于频繁，请一小时后再试');
        err.status = 429;
        err.error = err.message;
        throw err;
      }
    }

    const code = generateCode();
    const sendTimes = (item?.sendTimes || []).filter((t) => ts - t < 60 * 60 * 1000);
    sendTimes.push(ts);
    store[key] = {
      email,
      purpose,
      userId,
      codeHash: hashCode(userId, code),
      expiresAt: ts + CODE_TTL_MS,
      lastSentAt: ts,
      sendTimes,
      attempts: 0,
    };
    writeStore(store);
    return { code };
  }

  function verifyChallenge(userId, email, purpose, code) {
    const store = readStore();
    const key = storeKey(purpose, userId);
    const item = store[key];
    if (!item) {
      return { ok: false, error: '请先获取邮箱验证码' };
    }
    const ts = now();
    if (item.expiresAt < ts) {
      delete store[key];
      writeStore(store);
      return { ok: false, error: '验证码已过期，请重新获取' };
    }
    if ((item.email || '') !== email) {
      return { ok: false, error: '邮箱与验证码不匹配' };
    }
    item.attempts = (item.attempts || 0) + 1;
    if (item.attempts > MAX_ATTEMPTS) {
      delete store[key];
      writeStore(store);
      return { ok: false, error: '验证码错误次数过多，请重新获取' };
    }
    const expected = item.codeHash;
    const actual = hashCode(userId, String(code || '').trim());
    if (
      expected.length !== actual.length ||
      !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual))
    ) {
      writeStore(store);
      return { ok: false, error: '验证码不正确' };
    }
    delete store[key];
    writeStore(store);
    return { ok: true };
  }

  return { createChallenge, verifyChallenge };
}

module.exports = { createPasswordReset };
