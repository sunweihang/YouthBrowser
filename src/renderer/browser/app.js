/* global API from preload */
const api = window.youthBrowser;

const tabsEl = document.getElementById('tabs');
const urlInput = document.getElementById('urlInput');
const backBtn = document.getElementById('back');
const forwardBtn = document.getElementById('forward');
const reloadBtn = document.getElementById('reload');
const newTabBtn = document.getElementById('newTab');
const bookmarkBtn = document.getElementById('bookmarkBtn');
const bookmarksBar = document.getElementById('bookmarksBar');
const bookmarksItems = document.getElementById('bookmarksItems');
const navForm = document.getElementById('navForm');
const menuBtn = document.getElementById('menuBtn');

let lastActive = null;
let lastState = null;

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
  const moveId = dt.getData('application/x-simplygo-bookmark');
  if (moveId) {
    await api.moveBookmark(moveId, folderId);
    return;
  }
  const url = extractDroppedUrl(dt);
  if (!url) return;
  const title =
    (dt.getData('text/x-simplygo-title') || '').trim() ||
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
        e.dataTransfer.setData('application/x-simplygo-bookmark', bm.id);
        if (bm.url) {
          e.dataTransfer.setData('text/uri-list', bm.url);
          e.dataTransfer.setData('text/plain', bm.url);
          e.dataTransfer.setData('text/x-simplygo-title', bm.title || '');
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
  lastState = state;
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
    urlInput.placeholder = state.filteringEnabled
      ? '输入已授权的网址'
      : '输入网址';
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
      : '收藏本页';
    bookmarkBtn.disabled = !canDragUrl;
  } else {
    urlInput.draggable = false;
    bookmarkBtn.disabled = true;
    bookmarkBtn.classList.remove('active');
    bookmarkBtn.textContent = '☆';
    urlInput.placeholder = state.filteringEnabled
      ? '输入已授权的网址'
      : '输入网址';
  }

  const bm = state.bookmarks;
  const toolbar = Array.isArray(bm)
    ? bm
    : bm && Array.isArray(bm.toolbar)
      ? bm.toolbar
      : [];
  renderBookmarks(toolbar);

  bookmarksBar.classList.toggle('hidden-bar', state.bookmarksBarVisible === false);
  menuBtn.classList.toggle('needs-setup', Boolean(state.needsParentSetup));
    menuBtn.title = '打开菜单';
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
    'text/x-simplygo-title',
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
reloadBtn.addEventListener('click', (e) => api.reload(e.shiftKey));
newTabBtn.addEventListener('click', () => api.newTab());
bookmarkBtn.addEventListener('click', () => api.toggleBookmark());
menuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const rect = menuBtn.getBoundingClientRect();
  api.popupAppMenu(Math.round(rect.left), Math.round(rect.bottom));
});
document.getElementById('downloadsBtn').addEventListener('click', () => {
  api.openDownloads();
});

const updateBadge = document.getElementById('updateBadge');

function overlayHeight() {
  let extra = 0;
  if (!findBar.classList.contains('hidden')) {
    extra += Math.max(36, Math.ceil(findBar.getBoundingClientRect().height));
  }
  const homeBar = document.getElementById('homepageBar');
  if (homeBar && !homeBar.classList.contains('hidden')) {
    extra += Math.max(36, Math.ceil(homeBar.getBoundingClientRect().height));
  }
  const passBar = document.getElementById('passwordBar');
  if (passBar && !passBar.classList.contains('hidden')) {
    extra += Math.max(36, Math.ceil(passBar.getBoundingClientRect().height));
  }
  const dlBar = document.getElementById('downloadBar');
  if (dlBar && !dlBar.classList.contains('hidden')) {
    extra += Math.max(36, Math.ceil(dlBar.getBoundingClientRect().height));
  }
  return extra;
}

function syncChromeExtra() {
  requestAnimationFrame(() => {
    void api.setChromeExtra(overlayHeight());
  });
}

function renderUpdateBadge(st) {
  if (!st) return;
  const pct = Math.max(0, Math.min(100, Number(st.percent) || 0));
  updateBadge.classList.add('hidden');
  updateBadge.classList.remove('ready', 'downloading');
  if (st.status === 'ready') {
    updateBadge.textContent = '新';
    updateBadge.classList.remove('hidden');
    updateBadge.classList.add('ready');
  } else if (st.status === 'downloading') {
    updateBadge.textContent = `${pct.toFixed(0)}%`;
    updateBadge.classList.remove('hidden');
    updateBadge.classList.add('downloading');
  } else if (st.status === 'available') {
    updateBadge.textContent = '!';
    updateBadge.classList.remove('hidden');
  } else if (lastState && lastState.needsParentSetup) {
    updateBadge.textContent = '!';
    updateBadge.classList.remove('hidden');
  }
}

api.onUpdateStatus(renderUpdateBadge);
api.getUpdateStatus().then(renderUpdateBadge);

/* —— 查找栏 —— */
const findBar = document.getElementById('findBar');
const findInput = document.getElementById('findInput');
const findCount = document.getElementById('findCount');
const findPrev = document.getElementById('findPrev');
const findNext = document.getElementById('findNext');
const findClose = document.getElementById('findClose');

function openFindBar() {
  findBar.classList.remove('hidden');
  syncChromeExtra();
  findInput.focus();
  findInput.select();
  if (findInput.value) api.findInPage(findInput.value, { findNext: false });
}

function closeFindBar() {
  findBar.classList.add('hidden');
  findCount.textContent = '';
  api.stopFindInPage();
  syncChromeExtra();
}

function runFind(forward, findNext) {
  const q = findInput.value;
  if (!q) {
    api.stopFindInPage();
    findCount.textContent = '';
    return;
  }
  api.findInPage(q, { forward, findNext });
}

findInput.addEventListener('input', () => runFind(true, false));
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    runFind(!e.shiftKey, true);
  } else if (e.key === 'Escape') {
    closeFindBar();
  }
});
findPrev.addEventListener('click', () => runFind(false, true));
findNext.addEventListener('click', () => runFind(true, true));
findClose.addEventListener('click', closeFindBar);

api.onFindResult((result) => {
  if (!result) {
    findCount.textContent = '';
    return;
  }
  const matches = Number(result.matches) || 0;
  const active = Number(result.activeMatchOrdinal) || 0;
  findCount.textContent = matches ? `${active} / ${matches}` : '无匹配';
});

const homepageBar = document.getElementById('homepageBar');
const homepageInput = document.getElementById('homepageInput');
const homepageError = document.getElementById('homepageError');

async function openHomepageDialog() {
  homepageError.textContent = '';
  homepageInput.value = (await api.getHomepage()) || '';
  homepageBar.classList.remove('hidden');
  syncChromeExtra();
  homepageInput.focus();
  homepageInput.select();
}

function closeHomepageDialog() {
  homepageBar.classList.add('hidden');
  homepageError.textContent = '';
  syncChromeExtra();
}

homepageBar.addEventListener('submit', async (e) => {
  e.preventDefault();
  homepageError.textContent = '';
  const res = await api.setHomepage(homepageInput.value);
  if (!res.ok) {
    homepageError.textContent = res.error || '保存失败';
    return;
  }
  closeHomepageDialog();
});

document.getElementById('homepageUseCurrent').addEventListener('click', async () => {
  homepageError.textContent = '';
  const res = await api.setCurrentHomepage();
  if (!res.ok) {
    homepageError.textContent = res.error || '当前没有打开的网页';
    return;
  }
  homepageInput.value = res.homepage || '';
  closeHomepageDialog();
});

document.getElementById('homepageClear').addEventListener('click', async () => {
  homepageError.textContent = '';
  const res = await api.setHomepage('');
  if (!res.ok) {
    homepageError.textContent = res.error || '清除失败';
    return;
  }
  closeHomepageDialog();
});

document.getElementById('homepageClose').addEventListener('click', closeHomepageDialog);
homepageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeHomepageDialog();
});

const passwordBar = document.getElementById('passwordBar');
const passwordBarText = document.getElementById('passwordBarText');
let pendingPassword = null;

function closePasswordBar() {
  pendingPassword = null;
  passwordBar.classList.add('hidden');
  syncChromeExtra();
}

function openPasswordBar(offer) {
  if (!offer || !offer.origin || !offer.password) return;
  pendingPassword = offer;
  const host = offer.host || offer.origin;
  const user = offer.username || '';
  passwordBarText.textContent = offer.update
    ? `更新 ${host}（${user}）的密码？`
    : `保存 ${host}（${user}）的密码？`;
  passwordBar.classList.remove('hidden');
  syncChromeExtra();
}

document.getElementById('passwordSave').addEventListener('click', async () => {
  if (!pendingPassword) return;
  await api.saveSitePassword(pendingPassword);
  closePasswordBar();
});
document.getElementById('passwordDismiss').addEventListener('click', closePasswordBar);
document.getElementById('passwordClose').addEventListener('click', closePasswordBar);

const downloadBar = document.getElementById('downloadBar');
const downloadBarText = document.getElementById('downloadBarText');
const downloadBarMeta = document.getElementById('downloadBarMeta');
const downloadBarOpen = document.getElementById('downloadBarOpen');
const downloadBarShow = document.getElementById('downloadBarShow');
const downloadsBadge = document.getElementById('downloadsBadge');
let currentDownload = null;

function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(1)} MB`;
  return `${(v / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function closeDownloadBar() {
  if (downloadBar.classList.contains('hidden')) return;
  downloadBar.classList.add('hidden');
  syncChromeExtra();
}

function showDownloadBar(item) {
  if (!item) return;
  currentDownload = item;
  const wasHidden = downloadBar.classList.contains('hidden');
  const name = item.filename || 'download';
  if (item.state === 'completed') {
    downloadBarText.textContent = `已下载 ${name}`;
    downloadBarMeta.textContent = formatBytes(item.receivedBytes || item.totalBytes);
    downloadBarOpen.classList.remove('hidden');
    downloadBarShow.classList.remove('hidden');
  } else if (item.state === 'cancelled') {
    downloadBarText.textContent = `已取消 ${name}`;
    downloadBarMeta.textContent = '';
    downloadBarOpen.classList.add('hidden');
    downloadBarShow.classList.add('hidden');
  } else if (item.state === 'interrupted') {
    downloadBarText.textContent = `下载中断 ${name}`;
    downloadBarMeta.textContent = '';
    downloadBarOpen.classList.add('hidden');
    downloadBarShow.classList.add('hidden');
  } else {
    const rec = Number(item.receivedBytes) || 0;
    const tot = Number(item.totalBytes) || 0;
    const pct = tot > 0 ? `${Math.min(100, Math.round((rec / tot) * 100))}%` : '';
    downloadBarText.textContent = `${item.paused ? '已暂停' : '正在下载'} ${name}`;
    downloadBarMeta.textContent = [pct, tot ? `${formatBytes(rec)} / ${formatBytes(tot)}` : formatBytes(rec)]
      .filter(Boolean)
      .join(' · ');
    downloadBarOpen.classList.add('hidden');
    downloadBarShow.classList.add('hidden');
  }
  downloadBar.classList.remove('hidden');
  if (wasHidden) syncChromeExtra();
}

function renderDownloadsBadge(payload) {
  const n = payload && Number(payload.activeCount);
  if (n > 0) {
    downloadsBadge.textContent = String(n);
    downloadsBadge.classList.remove('hidden');
    downloadsBadge.classList.add('downloading');
  } else {
    downloadsBadge.textContent = '';
    downloadsBadge.classList.add('hidden');
    downloadsBadge.classList.remove('downloading');
  }
}

downloadBarOpen.addEventListener('click', () => {
  if (currentDownload) api.downloadOpen(currentDownload.id);
});
downloadBarShow.addEventListener('click', () => {
  if (currentDownload) api.downloadShow(currentDownload.id);
});
document.getElementById('downloadBarList').addEventListener('click', () => {
  api.openDownloads();
});
document.getElementById('downloadBarClose').addEventListener('click', closeDownloadBar);

api.onCommand((cmd) => {
  if (!cmd || !cmd.action) return;
  if (cmd.action === 'openFind') openFindBar();
  if (cmd.action === 'editHomepage') openHomepageDialog();
  if (cmd.action === 'offerSavePassword') openPasswordBar(cmd.payload);
  if (cmd.action === 'downloadChanged') {
    renderDownloadsBadge(cmd.payload);
  }
  if (cmd.action === 'findNext') {
    if (findBar.classList.contains('hidden')) openFindBar();
    else runFind(true, true);
  }
  if (cmd.action === 'findPrev') {
    if (findBar.classList.contains('hidden')) openFindBar();
    else runFind(false, true);
  }
});

api.onState(render);
api.getState().then(render);
