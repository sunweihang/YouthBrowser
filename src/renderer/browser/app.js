/* global API from preload */
const api = window.youthBrowser;

const tabsEl = document.getElementById('tabs');
const urlInput = document.getElementById('urlInput');
const backBtn = document.getElementById('back');
const forwardBtn = document.getElementById('forward');
const reloadBtn = document.getElementById('reload');
const newTabBtn = document.getElementById('newTab');
const parentBtn = document.getElementById('parentBtn');
const bookmarkBtn = document.getElementById('bookmarkBtn');
const bookmarksBar = document.getElementById('bookmarksBar');
const bookmarksItems = document.getElementById('bookmarksItems');
const manageBookmarks = document.getElementById('manageBookmarks');
const navForm = document.getElementById('navForm');

let lastActive = null;

function extractDroppedUrl(dt) {
  const uriList = (dt.getData('text/uri-list') || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => s && !s.startsWith('#'));
  if (uriList && /^https?:\/\//i.test(uriList)) return uriList;

  const plain = (dt.getData('text/plain') || '').trim();
  if (/^https?:\/\//i.test(plain)) return plain.split(/\s+/)[0];

  const html = dt.getData('text/html') || '';
  const m = html.match(/href=["'](https?:[^"']+)["']/i);
  if (m) return m[1];
  return null;
}

function titleFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || url;
  } catch {
    return url;
  }
}

async function dropOntoFolder(folderId, dt) {
  const moveId = dt.getData('application/x-jianxing-bookmark');
  if (moveId) {
    await api.moveBookmark(moveId, folderId);
    return;
  }
  const url = extractDroppedUrl(dt);
  if (!url) return;
  const title =
    (dt.getData('text/x-jianxing-title') || '').trim() ||
    (lastActive && lastActive.url === url ? lastActive.title : '') ||
    titleFromUrl(url);
  await api.addBookmark({ title, url, parentId: folderId });
}

function wireDropTarget(el, folderId) {
  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    el.classList.add('drop-hover');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-hover'));
  el.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove('drop-hover');
    await dropOntoFolder(folderId, e.dataTransfer);
  });
}

function renderBookmarks(toolbar) {
  bookmarksItems.innerHTML = '';
  const items = Array.isArray(toolbar) ? toolbar : [];
  if (items.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'bookmarks-empty';
    empty.textContent =
      '把地址栏网址拖到这里，或打开网页后点☆；也可点「管理」建文件夹';
    bookmarksItems.appendChild(empty);
    return;
  }
  for (const bm of items) {
    const chip = document.createElement('div');
    chip.className = 'bookmark-chip' + (bm.type === 'folder' ? ' folder' : '');
    chip.title =
      bm.type === 'folder'
        ? `${bm.title}（点击打开书签列表）`
        : bm.url || bm.title;

    const label = document.createElement('span');
    label.textContent =
      bm.type === 'folder' ? bm.title : bm.title || bm.url || '';
    chip.appendChild(label);

    if (bm.type === 'folder') {
      const caret = document.createElement('span');
      caret.className = 'folder-caret';
      caret.textContent = '▾';
      chip.appendChild(caret);
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        const rect = chip.getBoundingClientRect();
        api.popupBookmarkFolder(
          bm.id,
          Math.round(rect.left),
          Math.round(rect.bottom)
        );
      });
      wireDropTarget(chip, bm.id);
    } else {
      chip.draggable = true;
      chip.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('application/x-jianxing-bookmark', bm.id);
        if (bm.url) {
          e.dataTransfer.setData('text/uri-list', bm.url);
          e.dataTransfer.setData('text/plain', bm.url);
          e.dataTransfer.setData('text/x-jianxing-title', bm.title || '');
        }
        e.dataTransfer.effectAllowed = 'copyMove';
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'bm-remove';
      remove.title = '取消收藏';
      remove.textContent = '×';
      remove.addEventListener('click', (e) => {
        e.stopPropagation();
        api.removeBookmark(bm.id);
      });
      chip.appendChild(remove);
      chip.addEventListener('click', () => api.openBookmark(bm.id));
    }

    bookmarksItems.appendChild(chip);
  }
}

function render(state) {
  if (!state) return;
  tabsEl.innerHTML = '';
  for (const tab of state.tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (tab.id === state.activeTabId ? ' active' : '');
    el.title = tab.url || tab.title;

    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = tab.loading ? '加载中…' : tab.title || '新标签页';
    el.appendChild(title);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tab-close';
    close.textContent = '×';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      api.closeTab(tab.id);
    });
    el.appendChild(close);

    el.addEventListener('click', () => api.activateTab(tab.id));
    tabsEl.appendChild(el);
  }

  const active = state.active;
  lastActive = active;
  if (active) {
    const showUrl =
      active.url && active.url.startsWith('file:') ? '' : active.url || '';
    if (document.activeElement !== urlInput) {
      urlInput.value = showUrl;
    }
    const canDragUrl =
      active.url &&
      (active.url.startsWith('http://') || active.url.startsWith('https://'));
    urlInput.draggable = Boolean(canDragUrl);
    backBtn.disabled = !active.canGoBack;
    forwardBtn.disabled = !active.canGoForward;
    bookmarkBtn.classList.toggle('active', Boolean(active.isBookmarked));
    bookmarkBtn.textContent = active.isBookmarked ? '★' : '☆';
    bookmarkBtn.title = active.isBookmarked
      ? '取消收藏'
      : '收藏本页（也可把地址栏拖到书签栏）';
    bookmarkBtn.disabled = !canDragUrl;
  } else {
    urlInput.draggable = false;
    bookmarkBtn.disabled = true;
    bookmarkBtn.classList.remove('active');
    bookmarkBtn.textContent = '☆';
  }

  const bm = state.bookmarks;
  const toolbar = Array.isArray(bm)
    ? bm
    : bm && Array.isArray(bm.toolbar)
      ? bm.toolbar
      : [];
  renderBookmarks(toolbar);

  if (state.needsParentSetup) {
    parentBtn.textContent = '家长设置';
    parentBtn.style.borderColor = 'var(--danger)';
  } else {
    parentBtn.textContent = '家长';
    parentBtn.style.borderColor = '';
  }
}

urlInput.addEventListener('dragstart', (e) => {
  const url = (lastActive && lastActive.url) || urlInput.value.trim();
  if (!/^https?:\/\//i.test(url)) {
    e.preventDefault();
    return;
  }
  e.dataTransfer.setData('text/uri-list', url);
  e.dataTransfer.setData('text/plain', url);
  e.dataTransfer.setData(
    'text/x-jianxing-title',
    (lastActive && lastActive.title) || ''
  );
  e.dataTransfer.effectAllowed = 'copy';
});

wireDropTarget(bookmarksBar, 'toolbar');
wireDropTarget(bookmarksItems, 'toolbar');

navForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const url = urlInput.value.trim();
  if (url) api.navigate(url);
});

backBtn.addEventListener('click', () => api.goBack());
forwardBtn.addEventListener('click', () => api.goForward());
reloadBtn.addEventListener('click', () => api.reload());
newTabBtn.addEventListener('click', () => api.newTab());
parentBtn.addEventListener('click', () => api.openParent());
bookmarkBtn.addEventListener('click', () => api.toggleBookmark());
manageBookmarks.addEventListener('click', () => api.openBookmarksManager());

api.onState(render);
api.getState().then(render);
