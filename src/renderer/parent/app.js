const api = window.youthParent;

const authShell = document.getElementById('authShell');
const setupPanel = document.getElementById('setupPanel');
const unlockPanel = document.getElementById('unlockPanel');
const dashboard = document.getElementById('dashboard');
const createModal = document.getElementById('createModal');

let currentRules = null;
let activeGroupId = null;

function showAuth(panel) {
  authShell.classList.remove('hidden');
  dashboard.classList.add('hidden');
  setupPanel.classList.add('hidden');
  unlockPanel.classList.add('hidden');
  panel.classList.remove('hidden');
}

function showDashboard() {
  authShell.classList.add('hidden');
  setupPanel.classList.add('hidden');
  unlockPanel.classList.add('hidden');
  dashboard.classList.remove('hidden');
}

function goPage(pageId) {
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.page === pageId);
  });
  document.querySelectorAll('.page').forEach((page) => {
    page.classList.toggle('active', page.dataset.page === pageId);
  });
  if (pageId === 'groups') showGroupsList();
}

function extLabel(id) {
  const found = currentRules?.extensions?.find((e) => e.id === id);
  return found ? found.label : id;
}

function fillExtSelects() {
  const exts = currentRules?.extensions || [];
  for (const selId of ['newGroupExt', 'detailExt']) {
    const sel = document.getElementById(selId);
    if (!sel) continue;
    const prev = sel.value;
    sel.innerHTML = '';
    for (const e of exts) {
      const opt = document.createElement('option');
      opt.value = e.id;
      opt.textContent = e.label;
      sel.appendChild(opt);
    }
    if (prev && [...sel.options].some((o) => o.value === prev)) {
      sel.value = prev;
    }
  }
  updateExtHint();
}

function updateExtHint() {
  const id = document.getElementById('newGroupExt').value;
  const found = currentRules?.extensions?.find((e) => e.id === id);
  document.getElementById('extHint').textContent = found?.description || '';
  document.getElementById('suggestHostsRow').style.display =
    id === 'bilibili' ? '' : 'none';
}

function updateSummary(rules) {
  const groups = rules.groups || [];
  const enabled = groups.filter((g) => g.enabled).length;
  document.getElementById('statGroups').textContent = String(groups.length);
  document.getElementById('statEnabled').textContent = String(enabled);
  document.getElementById('navSummary').textContent =
    `${groups.length} 个配置组 · ${enabled} 个启用`;
}

function showGroupsList() {
  activeGroupId = null;
  document.getElementById('groupsListView').classList.remove('hidden');
  document.getElementById('groupDetailView').classList.add('hidden');
}

function openGroupDetail(groupId) {
  activeGroupId = groupId;
  closeCreateModal();
  document.getElementById('groupsListView').classList.add('hidden');
  document.getElementById('groupDetailView').classList.remove('hidden');
  renderGroupDetail();
}

function openCreateModal() {
  document.getElementById('createGroupError').textContent = '';
  document.getElementById('newGroupName').value = '';
  fillExtSelects();
  createModal.classList.remove('hidden');
  document.getElementById('newGroupName').focus();
}

function closeCreateModal() {
  createModal.classList.add('hidden');
}

function renderGroupList() {
  const list = document.getElementById('groupList');
  list.innerHTML = '';
  const groups = currentRules?.groups || [];
  document.getElementById('groupEmpty').classList.toggle('show', groups.length === 0);

  for (const g of groups) {
    const li = document.createElement('li');
    li.className = 'group-item';

    const left = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'group-name';
    name.textContent = g.name;
    const meta = document.createElement('div');
    meta.className = 'group-meta';
    meta.textContent = `${extLabel(g.extensionId)} · ${g.hosts.length} 个域名`;
    left.append(name, meta);

    const actions = document.createElement('div');
    actions.className = 'group-actions';

    const switchLabel = document.createElement('label');
    switchLabel.className = 'switch';
    switchLabel.title = g.enabled ? '已启用' : '已关闭';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = g.enabled;
    checkbox.addEventListener('click', (e) => e.stopPropagation());
    checkbox.addEventListener('change', async () => {
      const res = await api.updateGroup(g.id, { enabled: checkbox.checked });
      if (res.ok) applyRules(res.rules);
      else checkbox.checked = !checkbox.checked;
    });
    const track = document.createElement('span');
    track.className = 'switch-track';
    const text = document.createElement('span');
    text.className = 'switch-text';
    text.textContent = g.enabled ? '开' : '关';
    checkbox.addEventListener('change', () => {
      text.textContent = checkbox.checked ? '开' : '关';
    });
    switchLabel.append(checkbox, track, text);

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn-edit';
    editBtn.textContent = '编辑';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openGroupDetail(g.id);
    });

    actions.append(switchLabel, editBtn);
    li.append(left, actions);
    list.appendChild(li);
  }
}

function renderGroupDetail() {
  const g = currentRules?.groups?.find((x) => x.id === activeGroupId);
  if (!g) {
    showGroupsList();
    return;
  }

  document.getElementById('detailTitle').textContent = g.name;
  document.getElementById('detailSub').textContent = `扩展：${extLabel(g.extensionId)} · ${
    g.enabled ? '已启用' : '已关闭'
  }`;
  document.getElementById('detailName').value = g.name;
  document.getElementById('detailExt').value = g.extensionId;
  document.getElementById('detailMetaError').textContent = '';
  document.getElementById('detailMetaOk').textContent = '';

  const hostList = document.getElementById('detailHostList');
  hostList.innerHTML = '';
  for (const host of g.hosts) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = host;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'danger';
    btn.textContent = '删除';
    btn.addEventListener('click', async () => {
      const res = await api.removeHost(g.id, host);
      if (res.ok) applyRules(res.rules);
    });
    li.append(span, btn);
    hostList.appendChild(li);
  }
  document.getElementById('detailHostEmpty').classList.toggle('show', g.hosts.length === 0);

  const biliPanel = document.getElementById('biliExtPanel');
  if (g.extensionId === 'bilibili') {
    biliPanel.classList.remove('hidden');
    const cfg = g.extensionConfig || {};
    const mids = Array.isArray(cfg.allowedMids) ? cfg.allowedMids : [];
    const notes = cfg.midNotes && typeof cfg.midNotes === 'object' ? cfg.midNotes : {};
    const upList = document.getElementById('detailUpList');
    upList.innerHTML = '';
    for (const mid of mids) {
      const li = document.createElement('li');
      const box = document.createElement('div');
      const title = document.createElement('div');
      title.textContent = notes[mid] || `UP ${mid}`;
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = `mid: ${mid}`;
      box.append(title, meta);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'danger';
      btn.textContent = '删除';
      btn.addEventListener('click', async () => {
        const res = await api.removeBiliUp(g.id, mid);
        if (res.ok) applyRules(res.rules);
      });
      li.append(box, btn);
      upList.appendChild(li);
    }
    document.getElementById('detailUpEmpty').classList.toggle('show', mids.length === 0);
  } else {
    biliPanel.classList.add('hidden');
  }
}

function applyRules(rules) {
  currentRules = rules;
  fillExtSelects();
  updateSummary(rules);
  renderGroupList();
  if (activeGroupId) renderGroupDetail();
}

async function enterDashboard(preferredPage = 'overview') {
  const rules = await api.getRules();
  showDashboard();
  applyRules(rules);
  goPage(preferredPage);
}

async function boot() {
  const meta = await api.getMeta();
  if (meta.forceSetup) {
    showAuth(setupPanel);
  } else if (meta.unlocked && meta.rules) {
    showDashboard();
    applyRules(meta.rules);
    goPage('overview');
  } else {
    showAuth(unlockPanel);
  }
}

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => goPage(btn.dataset.page));
});

document.querySelectorAll('[data-goto]').forEach((btn) => {
  btn.addEventListener('click', () => goPage(btn.dataset.goto));
});

document.getElementById('newGroupExt').addEventListener('change', updateExtHint);
document.getElementById('backToGroups').addEventListener('click', showGroupsList);
document.getElementById('openCreateBtn').addEventListener('click', openCreateModal);
document.getElementById('cancelCreateBtn').addEventListener('click', closeCreateModal);
document.getElementById('createModalBackdrop').addEventListener('click', closeCreateModal);

document.getElementById('setupBtn').addEventListener('click', async () => {
  const p1 = document.getElementById('setupPass').value;
  const p2 = document.getElementById('setupPass2').value;
  const err = document.getElementById('setupError');
  err.textContent = '';
  if (p1 !== p2) {
    err.textContent = '两次密码不一致';
    return;
  }
  const res = await api.setupPassword(p1);
  if (!res.ok) {
    err.textContent = res.error || '设置失败';
    return;
  }
  await enterDashboard('groups');
});

document.getElementById('unlockBtn').addEventListener('click', async () => {
  const password = document.getElementById('unlockPass').value;
  const err = document.getElementById('unlockError');
  err.textContent = '';
  const res = await api.unlock(password);
  if (!res.ok) {
    err.textContent = res.error || '解锁失败';
    return;
  }
  showDashboard();
  applyRules(res.rules);
  goPage('overview');
});

document.getElementById('createGroupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('createGroupError');
  err.textContent = '';
  const res = await api.createGroup({
    name: document.getElementById('newGroupName').value,
    extensionId: document.getElementById('newGroupExt').value,
    useSuggestedHosts: document.getElementById('useSuggestedHosts').checked,
  });
  if (!res.ok) {
    err.textContent = res.error || '创建失败';
    return;
  }
  closeCreateModal();
  applyRules(res.rules);
  if (res.group?.id) openGroupDetail(res.group.id);
});

document.getElementById('detailMetaForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!activeGroupId) return;
  const err = document.getElementById('detailMetaError');
  const ok = document.getElementById('detailMetaOk');
  err.textContent = '';
  ok.textContent = '';
  const res = await api.updateGroup(activeGroupId, {
    name: document.getElementById('detailName').value,
    extensionId: document.getElementById('detailExt').value,
  });
  if (!res.ok) {
    err.textContent = res.error || '保存失败';
    return;
  }
  ok.textContent = '已保存';
  applyRules(res.rules);
});

document.getElementById('deleteGroupBtn').addEventListener('click', async () => {
  if (!activeGroupId) return;
  if (!confirm('确定删除该配置组？')) return;
  const res = await api.deleteGroup(activeGroupId);
  if (res.ok) {
    applyRules(res.rules);
    showGroupsList();
  }
});

document.getElementById('detailHostForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!activeGroupId) return;
  const input = document.getElementById('detailHostInput');
  const host = input.value.trim();
  if (!host) return;
  const res = await api.addHost(activeGroupId, host);
  if (res.ok) {
    input.value = '';
    applyRules(res.rules);
  }
});

document.getElementById('detailUpForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!activeGroupId) return;
  const err = document.getElementById('detailUpError');
  err.textContent = '';
  const res = await api.addBiliUp(
    activeGroupId,
    document.getElementById('detailUpInput').value.trim(),
    document.getElementById('detailUpNote').value.trim() || undefined
  );
  if (!res.ok) {
    err.textContent = res.error || '添加失败';
    return;
  }
  document.getElementById('detailUpInput').value = '';
  document.getElementById('detailUpNote').value = '';
  applyRules(res.rules);
});

document.getElementById('changePassBtn').addEventListener('click', async () => {
  const err = document.getElementById('passError');
  const ok = document.getElementById('passOk');
  err.textContent = '';
  ok.textContent = '';
  const next = document.getElementById('newPass').value;
  const next2 = document.getElementById('newPass2').value;
  if (next !== next2) {
    err.textContent = '两次新密码不一致';
    return;
  }
  const res = await api.changePassword(
    document.getElementById('curPass').value,
    next
  );
  if (!res.ok) {
    err.textContent = res.error || '修改失败';
    return;
  }
  ok.textContent = '密码已更新';
  document.getElementById('curPass').value = '';
  document.getElementById('newPass').value = '';
  document.getElementById('newPass2').value = '';
});

api.onMeta((meta) => {
  if (meta.forceSetup) showAuth(setupPanel);
  else if (meta.unlocked) enterDashboard();
  else showAuth(unlockPanel);
});

boot();
