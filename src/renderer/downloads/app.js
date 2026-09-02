const api = window.youthDownloads;

const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const searchInput = document.getElementById('searchInput');

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatTime(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yest = new Date();
  yest.setDate(today.getDate() - 1);
  const key = dayKey(ts);
  if (key === dayKey(today.getTime())) return '今天';
  if (key === dayKey(yest.getTime())) return '昨天';
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(1)} MB`;
  return `${(v / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function stateLabel(item) {
  if (item.state === 'completed') return '已完成';
  if (item.state === 'cancelled') return '已取消';
  if (item.state === 'interrupted') return '已中断';
  if (item.paused) return '已暂停';
  return '下载中';
}

function progressText(item) {
  const rec = Number(item.receivedBytes) || 0;
  const tot = Number(item.totalBytes) || 0;
  if (tot > 0) return `${formatBytes(rec)} / ${formatBytes(tot)}`;
  if (rec > 0) return formatBytes(rec);
  return '';
}

function addAction(parent, label, fn) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = label;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    fn();
  });
  parent.appendChild(btn);
}

async function render() {
  const query = searchInput.value.trim();
  const res = await api.list(query);
  const entries = (res && res.entries) || [];
  listEl.innerHTML = '';
  emptyEl.classList.toggle('hidden', entries.length > 0);
  let lastDay = '';
  for (const item of entries) {
    const day = dayKey(item.startedAt);
    if (day !== lastDay) {
      lastDay = day;
      const label = document.createElement('div');
      label.className = 'day-label';
      label.textContent = dayLabel(item.startedAt);
      listEl.appendChild(label);
    }

    const row = document.createElement('div');
    row.className = `row ${item.state || ''}`;
    row.title = item.filePath || item.url;

    const time = document.createElement('div');
    time.className = 'row-time';
    time.textContent = formatTime(item.startedAt);

    const main = document.createElement('div');
    main.className = 'row-main';
    const title = document.createElement('div');
    title.className = 'row-title';
    title.textContent = item.filename || 'download';
    const meta = document.createElement('div');
    meta.className = 'row-meta';
    const parts = [stateLabel(item), progressText(item)].filter(Boolean);
    meta.textContent = parts.join(' · ');
    main.append(title, meta);
    if (item.state === 'progressing') {
      const bar = document.createElement('div');
      bar.className = 'row-progress';
      const fill = document.createElement('span');
      const tot = Number(item.totalBytes) || 0;
      const rec = Number(item.receivedBytes) || 0;
      fill.style.width = tot > 0 ? `${Math.min(100, (rec / tot) * 100)}%` : '8%';
      bar.appendChild(fill);
      main.appendChild(bar);
    }

    const actions = document.createElement('div');
    actions.className = 'row-actions';
    if (item.state === 'progressing') {
      if (item.paused) addAction(actions, '继续', () => api.resume(item.id));
      else addAction(actions, '暂停', () => api.pause(item.id));
      addAction(actions, '取消', () => api.cancel(item.id));
    }
    if (item.state === 'completed') {
      addAction(actions, '打开', () => api.open(item.id));
      addAction(actions, '文件夹', () => api.show(item.id));
    }
    addAction(actions, '移除', () => api.remove(item.id));

    row.append(time, main, actions);
    if (item.state === 'completed') {
      row.addEventListener('click', () => api.open(item.id));
    }
    listEl.appendChild(row);
  }
}

searchInput.addEventListener('input', () => {
  render();
});

document.getElementById('openFolderBtn').addEventListener('click', () => {
  api.openFolder();
});

document.getElementById('clearBtn').addEventListener('click', async () => {
  await api.clear();
  render();
});

api.onChanged(() => render());
render();
