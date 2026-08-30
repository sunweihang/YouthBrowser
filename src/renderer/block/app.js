/* global youthView */
const params = new URLSearchParams(location.search);
const reasonMap = {
  invalid_url: '无效地址',
  host_denied: '网站不在白名单',
  bili_path_denied: 'B 站路径未授权',
  bili_up_denied: '该 UP 主不在允许列表',
  bili_resolve_failed: '无法确认视频作者',
  protocol_denied: '协议不被允许',
};

const originalUrl = params.get('url') || '';
const reason = params.get('reason') || '';
const mid = params.get('mid') || '';
const bvid = params.get('bvid') || '';
const aid = params.get('aid') || '';
const title = params.get('title') || '';

function normalizeHttpUrl(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) return s;
  return `https://${s}`;
}

function isHttpUrl(url) {
  try {
    const u = new URL(normalizeHttpUrl(url));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

document.getElementById('message').textContent =
  params.get('message') || '未授权的网站或内容';
document.getElementById('url').textContent = originalUrl || '—';
document.getElementById('reason').textContent =
  reasonMap[reason] || reason || '—';

// Any blocked http(s) page can request access (except protocol/invalid)
const canApply =
  isHttpUrl(originalUrl) &&
  reason !== 'invalid_url' &&
  reason !== 'protocol_denied';

const applyWrap = document.getElementById('applyWrap');
const applyBtn = document.getElementById('applyBtn');
const applyStatus = document.getElementById('applyStatus');

if (canApply) {
  applyWrap.classList.remove('hidden');
}

applyBtn.addEventListener('click', async () => {
  const api = window.youthView;
  if (!api || !api.createWatchRequest) {
    applyStatus.textContent = '当前环境无法发起申请';
    applyStatus.className = 'apply-status err';
    return;
  }
  applyBtn.disabled = true;
  applyStatus.textContent = '正在提交…';
  applyStatus.className = 'apply-status';
  try {
    const res = await api.createWatchRequest({
      url: normalizeHttpUrl(originalUrl),
      reason: reason || undefined,
      mid: mid || undefined,
      bvid: bvid || undefined,
      aid: aid || undefined,
      title: title || undefined,
    });
    if (!res || !res.ok) {
      applyStatus.textContent = (res && res.error) || '提交失败';
      applyStatus.className = 'apply-status err';
      applyBtn.disabled = false;
      return;
    }
    applyStatus.textContent = '已提交申请';
    applyStatus.className = 'apply-status ok';
    applyBtn.textContent = '已申请';
  } catch (e) {
    applyStatus.textContent = e && e.message ? e.message : '提交失败';
    applyStatus.className = 'apply-status err';
    applyBtn.disabled = false;
  }
});
