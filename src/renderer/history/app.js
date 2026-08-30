const api = window.youthHistory;

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

async function render() {
  const query = searchInput.value.trim();
  const res = await api.list(query);
  const entries = (res && res.entries) || [];
  listEl.innerHTML = '';
  emptyEl.classList.toggle('hidden', entries.length > 0);
  let lastDay = '';
  for (const item of entries) {
    const day = dayKey(item.visitedAt);
    if (day !== lastDay) {
      lastDay = day;
      const label = document.createElement('div');
      label.className = 'day-label';
      label.textContent = dayLabel(item.visitedAt);
      listEl.appendChild(label);
    }
    const row = document.createElement('div');
    row.className = 'row';
    row.title = item.url;

    const time = document.createElement('div');
    time.className = 'row-time';
    time.textContent = formatTime(item.visitedAt);

    const main = document.createElement('div');
    main.className = 'row-main';
    const title = document.createElement('div');
    title.className = 'row-title';
    title.textContent = item.title || item.host || item.url;
    const host = document.createElement('div');
    host.className = 'row-url';
    host.textContent = item.host || '';
    main.appendChild(title);
    main.appendChild(host);

    row.appendChild(time);
    row.appendChild(main);
    row.addEventListener('click', () => api.open(item.id));
    listEl.appendChild(row);
  }
}

searchInput.addEventListener('input', () => {
  render();
});

api.appVersion().then((v) => {
  document.getElementById('appVersion').textContent = v ? `v${v}` : 'v—';
});
api.onChanged(() => render());
render();
