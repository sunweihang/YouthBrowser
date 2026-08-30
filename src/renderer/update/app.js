const api = window.youthUpdate;

const updCurrent = document.getElementById('updCurrent');
const updLatest = document.getElementById('updLatest');
const updMsg = document.getElementById('updMsg');
const updProgressFill = document.getElementById('updProgressFill');
const updPercent = document.getElementById('updPercent');
const updSize = document.getElementById('updSize');
const updError = document.getElementById('updError');
const updCheckBtn = document.getElementById('updCheckBtn');
const updInstallBtn = document.getElementById('updInstallBtn');

function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / (1024 * 1024)).toFixed(1)} MB`;
}

function render(st) {
  if (!st) return;
  updCurrent.textContent = st.currentVersion ? `v${st.currentVersion}` : '—';
  updLatest.textContent = st.latestVersion ? `v${st.latestVersion}` : '—';
  updMsg.textContent = st.message || '—';

  const pct = Math.max(0, Math.min(100, Number(st.percent) || 0));
  updProgressFill.style.width = `${pct}%`;
  updPercent.textContent = `${pct.toFixed(0)}%`;
  if (st.total > 0) {
    updSize.textContent = `${formatBytes(st.transferred)} / ${formatBytes(st.total)}`;
  } else if (st.status === 'downloading') {
    updSize.textContent = formatBytes(st.transferred);
  } else {
    updSize.textContent = '—';
  }

  if (st.error) {
    updError.textContent = st.error;
    updError.classList.remove('hidden');
  } else {
    updError.classList.add('hidden');
  }

  updInstallBtn.classList.toggle('hidden', st.status !== 'ready');
  updCheckBtn.disabled = st.status === 'checking' || st.status === 'downloading';
  updCheckBtn.textContent =
    st.status === 'checking'
      ? '检查中…'
      : st.status === 'downloading'
        ? '下载中…'
        : '检查更新';
}

updCheckBtn.addEventListener('click', async () => {
  updCheckBtn.disabled = true;
  render(await api.check());
});

updInstallBtn.addEventListener('click', async () => {
  const res = await api.install();
  if (res && !res.ok) {
    updError.textContent = res.error || '安装失败';
    updError.classList.remove('hidden');
  }
});

api.onStatus(render);
api.getStatus().then(render);
