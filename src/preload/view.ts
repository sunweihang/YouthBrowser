import { contextBridge, ipcRenderer, webFrame } from 'electron';

contextBridge.exposeInMainWorld('youthView', {
  createWatchRequest: (input: {
    url: string;
    reason?: string;
    mid?: string;
    bvid?: string;
    aid?: string;
    title?: string;
  }) => ipcRenderer.invoke('watchRequest:create', input),
});

function isHttpPage(): boolean {
  return location.protocol === 'http:' || location.protocol === 'https:';
}

const FILL_SRC = `function fillSiteLogin(creds) {
  if (!creds || !creds.password) return;
  function visible(el) {
    if (!el) return false;
    const s = window.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function setVal(el, v) {
    if (!el || el.disabled || el.readOnly) return;
    const proto = window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, v);
    else el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const pwds = Array.prototype.slice.call(document.querySelectorAll('input[type="password"]')).filter(visible);
  if (!pwds.length) return;
  const pwd = pwds[0];
  const scope = pwd.form || document;
  const inputs = Array.prototype.slice.call(scope.querySelectorAll('input')).filter(function (el) {
    const t = String(el.type || 'text').toLowerCase();
    return visible(el) && t !== 'password' && t !== 'hidden' && t !== 'submit' && t !== 'button' && t !== 'checkbox' && t !== 'radio' && t !== 'file';
  });
  let user = null;
  for (let i = 0; i < inputs.length; i++) {
    const el = inputs[i];
    const key = (el.name + ' ' + el.id + ' ' + el.autocomplete + ' ' + el.placeholder).toLowerCase();
    const t = String(el.type || 'text').toLowerCase();
    if (t === 'email' || t === 'tel' || /user|email|login|account|phone|mobile|name/.test(key)) {
      user = el;
      break;
    }
  }
  if (!user && inputs.length) user = inputs[0];
  if (user && creds.username && !user.value) setVal(user, creds.username);
  if (pwd && !pwd.value) setVal(pwd, creds.password);
}`;

function collectLogin(): { username: string; password: string } | null {
  const pwds = Array.from(
    document.querySelectorAll<HTMLInputElement>(
      'input[type="password"], input.jx-pw-shown'
    )
  ).filter((el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return (
      s.display !== 'none' &&
      s.visibility !== 'hidden' &&
      r.width > 0 &&
      r.height > 0
    );
  });
  const pwd = pwds[0];
  if (!pwd || !pwd.value) return null;
  const scope: ParentNode = pwd.form || document;
  const inputs = Array.from(scope.querySelectorAll('input')).filter((el) => {
    const t = String(el.type || 'text').toLowerCase();
    return (
      t !== 'password' &&
      t !== 'hidden' &&
      t !== 'submit' &&
      t !== 'button' &&
      t !== 'checkbox' &&
      t !== 'radio' &&
      t !== 'file'
    );
  }) as HTMLInputElement[];
  let user: HTMLInputElement | null = null;
  for (const el of inputs) {
    const key = `${el.name} ${el.id} ${el.autocomplete} ${el.placeholder}`.toLowerCase();
    const t = String(el.type || 'text').toLowerCase();
    if (t === 'email' || t === 'tel' || /user|email|login|account|phone|mobile|name/.test(key)) {
      user = el;
      break;
    }
  }
  if (!user && inputs[0]) user = inputs[0];
  const username = (user?.value || '').trim();
  if (!username) return null;
  return { username, password: pwd.value };
}

let lastReport = '';
let fillTimer: ReturnType<typeof setTimeout> | null = null;

function reportLogin(): void {
  if (!isHttpPage()) return;
  const creds = collectLogin();
  if (!creds) return;
  const key = `${creds.username}\0${creds.password}`;
  if (key === lastReport) return;
  lastReport = key;
  void ipcRenderer.invoke('sitePassword:submitted', creds);
}

async function tryFill(): Promise<void> {
  if (!isHttpPage()) return;
  const creds = await ipcRenderer.invoke('sitePassword:lookup');
  if (!creds) return;
  try {
    await webFrame.executeJavaScript(
      `(${FILL_SRC})(${JSON.stringify(creds)})`,
      true
    );
  } catch {
    // page may have navigated
  }
}

function scheduleFill(): void {
  if (fillTimer) clearTimeout(fillTimer);
  fillTimer = setTimeout(() => {
    void tryFill();
    attachPasswordEyes();
  }, 200);
}

const EYE_OPEN =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3l18 18"/><path d="M10.6 10.6a2 2 0 0 0 2.8 2.8"/><path d="M9.4 5.1A10.8 10.8 0 0 1 12 5c6.5 0 10 7 10 7a17.7 17.7 0 0 1-3.3 4.6"/><path d="M6.1 6.1C3.7 7.8 2 12 2 12s3.5 7 10 7a10.6 10.6 0 0 0 4.2-.8"/></svg>';

const eyedInputs = new Set<HTMLInputElement>();

function placeEyeBtn(input: HTMLInputElement, btn: HTMLButtonElement): void {
  const r = input.getBoundingClientRect();
  const size = 20;
  const visible =
    r.width >= 48 &&
    r.height >= 18 &&
    r.bottom > 0 &&
    r.top < window.innerHeight &&
    r.right > 0 &&
    r.left < window.innerWidth;
  btn.style.display = visible ? 'grid' : 'none';
  if (!visible) return;
  btn.style.left = `${Math.round(r.right - size - 6)}px`;
  btn.style.top = `${Math.round(r.top + (r.height - size) / 2)}px`;
}

function attachPasswordEyes(): void {
  if (!isHttpPage()) return;
  const fields = Array.from(
    document.querySelectorAll<HTMLInputElement>('input[type="password"], input.jx-pw-shown')
  );
  for (const input of fields) {
    if (eyedInputs.has(input)) continue;
    eyedInputs.add(input);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'jx-pw-eye';
    btn.tabIndex = -1;
    btn.setAttribute('aria-label', '显示密码');
    btn.innerHTML = EYE_OPEN;
    Object.assign(btn.style, {
      position: 'fixed',
      zIndex: '2147483646',
      width: '20px',
      height: '20px',
      padding: '0',
      margin: '0',
      border: 'none',
      borderRadius: '4px',
      background: 'transparent',
      color: '#667',
      cursor: 'pointer',
      display: 'grid',
      placeItems: 'center',
    } as Partial<CSSStyleDeclaration>);
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      input.classList.toggle('jx-pw-shown', show);
      btn.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
      btn.innerHTML = show ? EYE_OFF : EYE_OPEN;
      placeEyeBtn(input, btn);
    });
    document.documentElement.appendChild(btn);
    const sync = () => {
      if (!input.isConnected) {
        btn.remove();
        eyedInputs.delete(input);
        return;
      }
      placeEyeBtn(input, btn);
    };
    window.addEventListener('scroll', sync, true);
    window.addEventListener('resize', sync);
    new MutationObserver(sync).observe(input, { attributes: true, attributeFilter: ['style', 'class'] });
    sync();
  }
}

function initSitePasswords(): void {
  if (!isHttpPage()) return;
  void tryFill();
  attachPasswordEyes();
  document.addEventListener('submit', () => reportLogin(), true);
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Enter' && (e.target as HTMLInputElement | null)?.type === 'password') {
        setTimeout(reportLogin, 0);
      }
    },
    true
  );
  document.addEventListener(
    'click',
    (e) => {
      const t = (e.target as Element | null)?.closest?.(
        'button, input[type="submit"], input[type="button"], [role="button"]'
      );
      if (!t || (t as HTMLElement).classList?.contains('jx-pw-eye')) return;
      setTimeout(reportLogin, 80);
    },
    true
  );
  const root = document.documentElement;
  if (root) {
    new MutationObserver(() => scheduleFill()).observe(root, {
      childList: true,
      subtree: true,
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSitePasswords, { once: true });
} else {
  initSitePasswords();
}
