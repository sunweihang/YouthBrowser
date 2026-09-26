/**
 * SMTP 发信（无额外依赖，支持 QQ/163 等 465 SSL）。
 * 配置：DATA_DIR/mail.json 或环境变量 SMTP_*
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');

let cachedConfig = null;

function readJsonIfExists(file) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (err) {
    console.error('[mail] 读取配置失败', file, err.message);
  }
  return null;
}

function loadConfig(dataDir) {
  const files = [
    path.join(dataDir, 'mail.json'),
    path.join(__dirname, 'mail.json'),
  ];
  let fileCfg = null;
  for (const file of files) {
    fileCfg = readJsonIfExists(file);
    if (fileCfg) break;
  }
  fileCfg = fileCfg || {};

  const port = Number(process.env.SMTP_PORT || fileCfg.port || 465);
  const secureEnv = process.env.SMTP_SECURE;
  const secure =
    secureEnv != null
      ? !['0', 'false', 'no'].includes(String(secureEnv).toLowerCase())
      : fileCfg.secure != null
        ? Boolean(fileCfg.secure)
        : port === 465;

  return {
    host: String(process.env.SMTP_HOST || fileCfg.host || '').trim(),
    port,
    secure,
    user: String(process.env.SMTP_USER || fileCfg.user || '').trim(),
    pass: String(process.env.SMTP_PASS || fileCfg.pass || '').trim(),
    from: String(process.env.SMTP_FROM || fileCfg.from || '').trim(),
    name:
      String(process.env.SMTP_FROM_NAME || fileCfg.name || '简行浏览器').trim() ||
      '简行浏览器',
  };
}

function getConfig(dataDir) {
  if (!cachedConfig) cachedConfig = loadConfig(dataDir);
  return cachedConfig;
}

function isPlaceholder(value) {
  return /你的|授权码|example\.com|changeme|replace-me/i.test(String(value || ''));
}

function isConfigured(dataDir) {
  const cfg = getConfig(dataDir);
  if (!cfg.host || isPlaceholder(cfg.host)) return false;
  if (!cfg.user || !cfg.pass || !cfg.user.includes('@')) return false;
  if (isPlaceholder(cfg.user) || isPlaceholder(cfg.pass)) return false;
  return true;
}

function getFromAddress(cfg) {
  if (cfg.from) return cfg.from;
  if (cfg.user) return `${cfg.name} <${cfg.user}>`;
  return `${cfg.name} <noreply@localhost>`;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function b64(s) {
  return Buffer.from(String(s), 'utf8').toString('base64');
}

function connectSmtp(cfg) {
  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    if (cfg.secure) {
      const socket = tls.connect(
        { host: cfg.host, port: cfg.port, servername: cfg.host },
        () => resolve(socket)
      );
      socket.once('error', onError);
      return;
    }
    const socket = net.connect({ host: cfg.host, port: cfg.port }, () => {
      resolve(socket);
    });
    socket.once('error', onError);
  });
}

function createLineReader(socket) {
  let buf = '';
  const queue = [];
  let pending = null;

  function tryResolve() {
    if (!pending || !queue.length) return;
    const line = queue.shift();
    const { resolve } = pending;
    pending = null;
    resolve(line);
  }

  socket.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      let line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      queue.push(line);
      tryResolve();
    }
  });

  return function readLine() {
    return new Promise((resolve, reject) => {
      if (queue.length) {
        resolve(queue.shift());
        return;
      }
      pending = { resolve, reject };
    });
  };
}

async function expectCode(readLine, codes) {
  const want = Array.isArray(codes) ? codes : [codes];
  let last = '';
  for (;;) {
    const line = await readLine();
    last = line;
    const code = Number(line.slice(0, 3));
    const cont = line.charAt(3) === '-';
    if (!cont) {
      if (!want.includes(code)) {
        throw new Error(`SMTP 异常响应: ${line}`);
      }
      return { code, line: last };
    }
  }
}

async function sendCommand(socket, readLine, cmd, codes) {
  socket.write(`${cmd}\r\n`);
  return expectCode(readLine, codes);
}

async function maybeStartTls(socket, readLine, cfg) {
  if (cfg.secure) return socket;
  await sendCommand(socket, readLine, 'STARTTLS', 220);
  return new Promise((resolve, reject) => {
    const secure = tls.connect(
      { socket, servername: cfg.host },
      () => resolve(secure)
    );
    secure.once('error', reject);
  });
}

async function sendMail(dataDir, { to, subject, text, html }) {
  if (!isConfigured(dataDir)) {
    const err = new Error('邮件服务未配置');
    err.status = 503;
    throw err;
  }
  const cfg = getConfig(dataDir);
  let socket = await connectSmtp(cfg);
  let readLine = createLineReader(socket);
  await expectCode(readLine, 220);
  await sendCommand(socket, readLine, `EHLO simplygo`, [250]);
  if (!cfg.secure) {
    socket = await maybeStartTls(socket, readLine, cfg);
    readLine = createLineReader(socket);
    await sendCommand(socket, readLine, `EHLO simplygo`, [250]);
  }
  await sendCommand(socket, readLine, 'AUTH LOGIN', [334]);
  await sendCommand(socket, readLine, b64(cfg.user), [334]);
  await sendCommand(socket, readLine, b64(cfg.pass), [235]);
  const fromAddr = (cfg.from.match(/<([^>]+)>/) || [, cfg.user])[1] || cfg.user;
  await sendCommand(socket, readLine, `MAIL FROM:<${fromAddr}>`, [250]);
  await sendCommand(socket, readLine, `RCPT TO:<${to}>`, [250, 251]);
  await sendCommand(socket, readLine, 'DATA', [354]);

  const boundary = `b${Date.now()}${Math.random().toString(16).slice(2)}`;
  const headers = [
    `From: ${getFromAddress(cfg)}`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${b64(subject)}?=`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(text),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(html || text),
    `--${boundary}--`,
    '.',
  ].join('\r\n');
  socket.write(`${headers}\r\n`);
  await expectCode(readLine, 250);
  try {
    await sendCommand(socket, readLine, 'QUIT', [221]);
  } catch {
    /* ignore */
  }
  socket.end();
  console.log('[mail] sent', to);
}

async function sendPasswordResetCode(dataDir, to, username, code) {
  const safeName = username || '用户';
  const subject = '简行浏览器密码重置验证码';
  const text = [
    `${safeName}，你好：`,
    '',
    `你正在重置简行浏览器密码，验证码为：${code}`,
    '验证码 10 分钟内有效。',
    '如非本人操作，请忽略本邮件。',
  ].join('\n');
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111827;">
      <h2 style="margin:0 0 16px;color:#0f766e;">简行浏览器</h2>
      <p style="margin:0 0 12px;">${escapeHtml(safeName)}，你好：</p>
      <p style="margin:0 0 12px;">你正在重置密码，验证码为：</p>
      <p style="margin:16px 0;font-size:32px;letter-spacing:8px;font-weight:700;color:#115e59;">${escapeHtml(code)}</p>
      <p style="margin:0 0 8px;color:#6b7280;">验证码 10 分钟内有效。如非本人操作，请忽略本邮件。</p>
    </div>
  `;
  return sendMail(dataDir, { to, subject, text, html });
}

module.exports = {
  isConfigured,
  sendMail,
  sendPasswordResetCode,
  clearCache() {
    cachedConfig = null;
  },
};
