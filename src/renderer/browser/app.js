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
const bookmarksItems = document.getElementById('bookmarksItems');
const navForm = document.getElementById('navForm');

function renderBookmarks(bookmarks) {
  bookmarksItems.innerHTML = '';
  if (!bookmarks || bookmarks.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'bookmarks-empty';
    empty.textContent = '暂无收藏，打开网页后点右侧☆即可添加';
    bookmarksItems.appendChild(empty);
    return;
  }
  for (const bm of bookmarks) {
    const chip = document.createElement('div');
    chip.className = 'bookmark-chip';
    chip.title = bm.url;

    const label = document.createElement('span');
    label.textContent = bm.title || bm.url;
    chip.appendChild(label);

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
  if (active) {
    const showUrl =
      active.url && active.url.startsWith('file:') ? '' : active.url || '';
    if (document.activeElement !== urlInput) {
      urlInput.value = showUrl;
    }
    backBtn.disabled = !active.canGoBack;
    forwardBtn.disabled = !active.canGoForward;
    bookmarkBtn.classList.toggle('active', Boolean(active.isBookmarked));
    bookmarkBtn.textContent = active.isBookmarked ? '★' : '☆';
    bookmarkBtn.title = active.isBookmarked ? '取消收藏' : '收藏本页';
    bookmarkBtn.disabled = !(
      active.url &&
      (active.url.startsWith('http://') || active.url.startsWith('https://'))
    );
  } else {
    bookmarkBtn.disabled = true;
    bookmarkBtn.classList.remove('active');
    bookmarkBtn.textContent = '☆';
  }

  renderBookmarks(state.bookmarks || []);

  if (state.needsParentSetup) {
    parentBtn.textContent = '家长设置';
    parentBtn.style.borderColor = 'var(--danger)';
  } else {
    parentBtn.textContent = '家长';
    parentBtn.style.borderColor = '';
  }
}

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

api.onState(render);
api.getState().then(render);
