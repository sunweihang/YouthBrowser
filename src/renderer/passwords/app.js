const api = window.youthPasswords;

const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const searchInput = document.getElementById('searchInput');

function matches(item, q) {
  if (!q) return true;
  return (
    (item.host || '').toLowerCase().includes(q) ||
    (item.origin || '').toLowerCase().includes(q) ||
    (item.username || '').toLowerCase().includes(q)
  );
}

async function render() {
  const q = searchInput.value.trim().toLowerCase();
  const res = await api.list();
  const items = ((res && res.entries) || []).filter((item) => matches(item, q));
  listEl.innerHTML = '';
  emptyEl.classList.toggle('hidden', items.length > 0);
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'row';
    const main = document.createElement('div');
    main.className = 'row-main';
    const title = document.createElement('div');
    title.className = 'row-title';
    title.textContent = item.username || '—';
    const host = document.createElement('div');
    host.className = 'row-url';
    host.textContent = item.host || item.origin || '';
    main.append(title, host);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'row-del';
    del.textContent = '删除';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      await api.remove(item.id);
      render();
    });
    row.append(main, del);
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
