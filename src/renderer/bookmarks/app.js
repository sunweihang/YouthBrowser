/* global youthBookmarks */
const api = window.youthBookmarks;

const ROOT_IDS = new Set(['toolbar', 'other']);

const folderTree = document.getElementById('folderTree');
const itemList = document.getElementById('itemList');
const listTitle = document.getElementById('listTitle');
const emptyHint = document.getElementById('emptyHint');
const statusEl = document.getElementById('status');
const btnNewFolder = document.getElementById('btnNewFolder');
const btnRename = document.getElementById('btnRename');
const btnMove = document.getElementById('btnMove');
const btnDelete = document.getElementById('btnDelete');

const dialogMask = document.getElementById('dialogMask');
const dialogTitle = document.getElementById('dialogTitle');
const dialogMessage = document.getElementById('dialogMessage');
const dialogFieldWrap = document.getElementById('dialogFieldWrap');
const dialogLabel = document.getElementById('dialogLabel');
const dialogInput = document.getElementById('dialogInput');
const dialogSelectWrap = document.getElementById('dialogSelectWrap');
const dialogSelectLabel = document.getElementById('dialogSelectLabel');
const dialogSelect = document.getElementById('dialogSelect');
const dialogCancel = document.getElementById('dialogCancel');
const dialogOk = document.getElementById('dialogOk');

let snapshot = { nodes: [], toolbar: [], folders: [] };
let selectedFolderId = 'toolbar';
let selectedItemId = null;
let dialogResolver = null;

function setStatus(msg) {
  statusEl.textContent = msg || '';
}

function childrenOf(parentId) {
  return (snapshot.nodes || [])
    .filter((n) => n.parentId === parentId)
    .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
}

function folderChildren(parentId) {
  return childrenOf(parentId).filter((n) => n.type === 'folder');
}

function nodeById(id) {
  return (snapshot.nodes || []).find((n) => n.id === id);
}

function closeDialog(result) {
  dialogMask.classList.add('hidden');
  const resolve = dialogResolver;
  dialogResolver = null;
  if (resolve) resolve(result);
}

function openDialog(opts) {
  return new Promise((resolve) => {
    dialogResolver = resolve;
    dialogTitle.textContent = opts.title || '';
    dialogMessage.textContent = opts.message || '';
    dialogMessage.classList.toggle('hidden', !opts.message);

    const mode = opts.mode || 'prompt';
    dialogFieldWrap.classList.toggle('hidden', mode !== 'prompt');
    dialogSelectWrap.classList.toggle('hidden', mode !== 'select');
    dialogOk.classList.toggle('danger', Boolean(opts.danger));
    dialogOk.textContent = opts.okText || '确定';

    if (mode === 'prompt') {
      dialogLabel.textContent = opts.label || '名称';
      dialogInput.value = opts.value || '';
      dialogInput.placeholder = opts.placeholder || '';
    } else if (mode === 'select') {
      dialogSelectLabel.textContent = opts.label || '目标文件夹';
      dialogSelect.innerHTML = '';
      for (const opt of opts.options || []) {
        const el = document.createElement('option');
        el.value = opt.value;
        el.textContent = opt.label;
        dialogSelect.appendChild(el);
      }
      if (opts.value) dialogSelect.value = opts.value;
    }

    dialogMask.classList.remove('hidden');
    setTimeout(() => {
      if (mode === 'prompt') {
        dialogInput.focus();
        dialogInput.select();
      } else if (mode === 'select') {
        dialogSelect.focus();
      } else {
        dialogOk.focus();
      }
    }, 0);
  });
}

dialogCancel.addEventListener('click', () => closeDialog(null));
dialogOk.addEventListener('click', () => {
  if (!dialogFieldWrap.classList.contains('hidden')) {
    closeDialog(dialogInput.value);
    return;
  }
  if (!dialogSelectWrap.classList.contains('hidden')) {
    closeDialog(dialogSelect.value);
    return;
  }
  closeDialog(true);
});
dialogMask.addEventListener('click', (e) => {
  if (e.target === dialogMask) closeDialog(null);
});
dialogInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    dialogOk.click();
  } else if (e.key === 'Escape') {
    closeDialog(null);
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !dialogMask.classList.contains('hidden')) {
    closeDialog(null);
  }
});

function renderTree() {
  folderTree.innerHTML = '';
  const roots = ['toolbar', 'other']
    .map((id) => nodeById(id))
    .filter(Boolean);

  const walk = (folder, depth, ancestors) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className =
      'tree-item' + (folder.id === selectedFolderId ? ' active' : '');
    btn.style.paddingLeft = `${8 + Math.min(depth, 8) * 14}px`;
    btn.innerHTML = `<span class="icon">📁</span><span>${escapeHtml(folder.title)}</span>`;
    btn.addEventListener('click', () => {
      selectedFolderId = folder.id;
      selectedItemId = ROOT_IDS.has(folder.id) ? null : folder.id;
      render();
    });
    wireFolderDropTarget(btn, folder.id);
    folderTree.appendChild(btn);

    if (ancestors.has(folder.id)) return;
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(folder.id);
    for (const child of folderChildren(folder.id)) {
      if (ROOT_IDS.has(child.id)) continue;
      walk(child, depth + 1, nextAncestors);
    }
  };

  for (const root of roots) walk(root, 0, new Set());
}

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
    if (moveId === folderId) return;
    const res = await api.move(moveId, folderId);
    if (!res.ok) {
      setStatus(res.error || '移动失败');
      return;
    }
    if (res.snapshot) await applySnapshot(res.snapshot);
    selectedFolderId = folderId;
    selectedItemId = moveId;
    render();
    const folder = nodeById(folderId);
    setStatus(`已移动到「${folder ? folder.title : folderId}」`);
    return;
  }

  const url = extractDroppedUrl(dt);
  if (!url) {
    setStatus('只能拖入网页链接或书签');
    return;
  }
  const title =
    (dt.getData('text/x-jianxing-title') || '').trim() || titleFromUrl(url);
  const res = await api.add({ title, url, parentId: folderId });
  if (!res.ok) {
    setStatus(res.error || '收藏失败');
    return;
  }
  if (res.snapshot) await applySnapshot(res.snapshot);
  selectedFolderId = folderId;
  if (res.node) selectedItemId = res.node.id;
  render();
  const folder = nodeById(folderId);
  setStatus(`已收藏到「${folder ? folder.title : folderId}」`);
}

function wireFolderDropTarget(el, folderId) {
  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = e.dataTransfer.types.includes(
      'application/x-jianxing-bookmark'
    )
      ? 'move'
      : 'copy';
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

function renderList() {
  const folder = nodeById(selectedFolderId);
  listTitle.textContent = folder ? folder.title : '内容';
  const items = childrenOf(selectedFolderId);
  itemList.innerHTML = '';
  emptyHint.classList.toggle('hidden', items.length > 0);

  for (const item of items) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'row' + (item.id === selectedItemId ? ' selected' : '');
    if (!ROOT_IDS.has(item.id)) row.draggable = true;
    const icon = item.type === 'folder' ? '📁' : '☆';
    row.innerHTML = `
      <span class="icon">${icon}</span>
      <span class="title">${escapeHtml(item.title)}</span>
      <span class="url">${item.type === 'bookmark' ? escapeHtml(item.url || '') : '文件夹'}</span>
    `;
    row.addEventListener('click', () => {
      selectedItemId = item.id;
      renderList();
      updateActions();
    });
    row.addEventListener('dblclick', () => {
      if (item.type === 'folder') {
        selectedFolderId = item.id;
        selectedItemId = null;
        render();
      } else {
        api.open(item.id);
      }
    });
    if (!ROOT_IDS.has(item.id)) {
      row.addEventListener('dragstart', (e) => {
        selectedItemId = item.id;
        e.dataTransfer.setData('application/x-jianxing-bookmark', item.id);
        if (item.url) {
          e.dataTransfer.setData('text/uri-list', item.url);
          e.dataTransfer.setData('text/plain', item.url);
          e.dataTransfer.setData('text/x-jianxing-title', item.title || '');
        }
        e.dataTransfer.effectAllowed = 'copyMove';
        row.classList.add('selected');
      });
    }
    if (item.type === 'folder') {
      wireFolderDropTarget(row, item.id);
    }
    itemList.appendChild(row);
  }

  // Drop onto current folder empty area / list
  itemList.ondragover = (e) => {
    e.preventDefault();
    itemList.classList.add('drop-hover');
  };
  itemList.ondragleave = () => itemList.classList.remove('drop-hover');
  itemList.ondrop = async (e) => {
    e.preventDefault();
    itemList.classList.remove('drop-hover');
    await dropOntoFolder(selectedFolderId, e.dataTransfer);
  };

  updateActions();
}

function updateActions() {
  const sel = selectedItemId ? nodeById(selectedItemId) : null;
  const canMutateSel = Boolean(sel && !ROOT_IDS.has(sel.id));
  btnRename.disabled = !canMutateSel;
  btnMove.disabled = !canMutateSel;
  btnDelete.disabled = !canMutateSel;
  btnNewFolder.disabled = !selectedFolderId;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function render() {
  renderTree();
  renderList();
}

async function applySnapshot(next) {
  snapshot = next || { nodes: [], toolbar: [], folders: [] };
  if (!nodeById(selectedFolderId)) selectedFolderId = 'toolbar';
  if (selectedItemId && !nodeById(selectedItemId)) selectedItemId = null;
  render();
}

btnNewFolder.addEventListener('click', async () => {
  const title = await openDialog({
    mode: 'prompt',
    title: '新建文件夹',
    label: '文件夹名称',
    value: '新建文件夹',
  });
  if (title == null) return;
  const res = await api.createFolder({
    title: String(title).trim() || '新建文件夹',
    parentId: selectedFolderId,
  });
  if (!res.ok) {
    setStatus(res.error || '创建失败');
    return;
  }
  if (res.snapshot) await applySnapshot(res.snapshot);
  if (res.node) {
    selectedItemId = res.node.id;
    render();
  }
  setStatus('已创建文件夹');
});

btnRename.addEventListener('click', async () => {
  const sel = selectedItemId ? nodeById(selectedItemId) : null;
  if (!sel || ROOT_IDS.has(sel.id)) return;
  const title = await openDialog({
    mode: 'prompt',
    title: '重命名',
    label: '名称',
    value: sel.title,
  });
  if (title == null) return;
  const next = String(title).trim();
  if (!next) {
    setStatus('名称不能为空');
    return;
  }
  const res = await api.rename(sel.id, next);
  if (!res.ok) {
    setStatus(res.error || '重命名失败');
    return;
  }
  if (res.snapshot) await applySnapshot(res.snapshot);
  setStatus('已重命名');
});

btnDelete.addEventListener('click', async () => {
  const sel = selectedItemId ? nodeById(selectedItemId) : null;
  if (!sel || ROOT_IDS.has(sel.id)) return;
  const tip =
    sel.type === 'folder'
      ? `删除文件夹「${sel.title}」及其全部内容？此操作不可撤销。`
      : `删除书签「${sel.title}」？`;
  const ok = await openDialog({
    mode: 'confirm',
    title: '确认删除',
    message: tip,
    okText: '删除',
    danger: true,
  });
  if (!ok) return;
  const res = await api.remove(sel.id);
  if (!res.ok) {
    setStatus(res.error || '删除失败');
    return;
  }
  selectedItemId = null;
  if (res.snapshot) await applySnapshot(res.snapshot);
  setStatus('已删除');
});

btnMove.addEventListener('click', async () => {
  const sel = selectedItemId ? nodeById(selectedItemId) : null;
  if (!sel || ROOT_IDS.has(sel.id)) return;
  const folders = (snapshot.folders || []).filter((f) => f.id !== sel.id);
  if (!folders.length) {
    setStatus('没有可移动到的文件夹');
    return;
  }
  const targetId = await openDialog({
    mode: 'select',
    title: '移动到文件夹',
    label: `将「${sel.title}」移动到`,
    options: folders.map((f) => ({ value: f.id, label: f.title })),
    value: selectedFolderId === sel.id ? 'toolbar' : selectedFolderId,
  });
  if (targetId == null) return;
  const target = folders.find((f) => f.id === targetId);
  const res = await api.move(sel.id, targetId);
  if (!res.ok) {
    setStatus(res.error || '移动失败');
    return;
  }
  if (res.snapshot) await applySnapshot(res.snapshot);
  setStatus(`已移动到「${target ? target.title : targetId}」`);
});

api.onChanged(applySnapshot);
api.snapshot().then(applySnapshot);
