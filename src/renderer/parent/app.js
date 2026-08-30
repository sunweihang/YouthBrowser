const api = window.youthParent;

const authShell = document.getElementById('authShell');
const setupPanel = document.getElementById('setupPanel');
const accountGatePanel = document.getElementById('accountGatePanel');
const accountRegisterPanel = document.getElementById('accountRegisterPanel');
const unlockPanel = document.getElementById('unlockPanel');
const dashboard = document.getElementById('dashboard');
const createModal = document.getElementById('createModal');

let currentRules = null;
let activeGroupId = null;

function hideAllAuthPanels() {
  setupPanel.classList.add('hidden');
  accountGatePanel.classList.add('hidden');
  accountRegisterPanel.classList.add('hidden');
  unlockPanel.classList.add('hidden');
}

function showAuth(panel) {
  authShell.classList.remove('hidden');
  dashboard.classList.add('hidden');
  hideAllAuthPanels();
  panel.classList.remove('hidden');
}

function showDashboard() {
  authShell.classList.add('hidden');
  hideAllAuthPanels();
  dashboard.classList.remove('hidden');
}

async function showUnlockGate() {
  const account = await api.getAccount();
  const nameEl = document.getElementById('unlockAccountName');
  if (nameEl) nameEl.textContent = account?.username || '已登录账号';
  document.getElementById('unlockError').textContent = '';
  showAuth(unlockPanel);
}

async function showAccountGate() {
  document.getElementById('gateLoginError').textContent = '';
  showAuth(accountGatePanel);
}

async function pullConfigQuick() {
  const btn = document.getElementById('syncOnlyBtn');
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = '更新中…';
  try {
    const res = await api.pullConfig();
    if (!res.ok) {
      alert(res.error || '更新失败');
      return;
    }
    if (res.rules) applyRules(res.rules);
    alert(res.unchanged ? '已经是最新配置' : '配置更新完毕');
  } catch (e) {
    alert(e && e.message ? e.message : '更新失败');
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
}

async function enterDashboard(preferredPage = 'overview') {
  const rules = await api.getRules();
  showDashboard();
  applyRules(rules);
  goPage(preferredPage);
  void refreshWatchRequests();
}

function goPage(pageId) {
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.page === pageId);
  });
  document.querySelectorAll('.page').forEach((page) => {
    page.classList.toggle('active', page.dataset.page === pageId);
  });
  if (pageId === 'groups') showGroupsList();
  if (pageId === 'sync') refreshAccountPanel();
  if (pageId === 'requests') void refreshWatchRequests();
  if (pageId === 'history') void refreshHistory();
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
  document.getElementById('suggestHostsRow').style.display =
    id === 'bilibili' ? '' : 'none';
}

function updateFilterSwitch(rules) {
  const on = Boolean(rules && rules.filteringEnabled);
  const sw = document.getElementById('filterEnabledSwitch');
  const text = document.getElementById('filterSwitchText');
  if (sw) sw.checked = on;
  if (text) text.textContent = on ? '开' : '关';
}

function updateSummary(rules) {
  const groups = rules.groups || [];
  const enabled = groups.filter((g) => g.enabled).length;
  document.getElementById('statGroups').textContent = String(groups.length);
  document.getElementById('statEnabled').textContent = String(enabled);
  const filterLabel = rules && rules.filteringEnabled ? '过滤开' : '过滤关';
  document.getElementById('navSummary').textContent =
    `${filterLabel} · ${groups.length} 个配置组 · ${enabled} 个启用`;
  updateFilterSwitch(rules);
  void refreshHistoryCount();
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

async function boot() {
  const meta = await api.getMeta();
  if (meta.forceSetup) {
    showAuth(setupPanel);
    return;
  }
  if (meta.unlocked && meta.rules) {
    showDashboard();
    applyRules(meta.rules);
    goPage('overview');
    return;
  }
  const account = await api.getAccount();
  if (account && account.loggedIn) {
    await showUnlockGate();
  } else {
    await showAccountGate();
  }
}

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => goPage(btn.dataset.page));
});

document.querySelectorAll('[data-goto]').forEach((btn) => {
  btn.addEventListener('click', () => goPage(btn.dataset.goto));
});

document.getElementById('filterEnabledSwitch').addEventListener('change', async (e) => {
  const checked = e.target.checked;
  const res = await api.setFilteringEnabled(checked);
  if (!res.ok) {
    e.target.checked = !checked;
    alert(res.error || '无法切换过滤');
    return;
  }
  if (res.rules) applyRules(res.rules);
  else updateFilterSwitch({ filteringEnabled: checked });
});

document.getElementById('historySearchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  void refreshHistory();
});
document.getElementById('historySearch').addEventListener('input', () => {
  void refreshHistory();
});

document.getElementById('historyList').addEventListener('click', async (e) => {
  const delBtn = e.target.closest('[data-del-history]');
  const openRow = e.target.closest('[data-open-history]');
  const openId = openRow && !delBtn ? openRow.dataset.openHistory : '';
  const delId = delBtn ? delBtn.dataset.delHistory : '';
  const err = document.getElementById('historyError');
  const ok = document.getElementById('historyOk');
  if (err) err.textContent = '';
  if (ok) ok.textContent = '';
  if (openId) {
    const res = await api.openHistoryEntry(openId);
    if (!res.ok && err) err.textContent = res.error || '打开失败';
    return;
  }
  if (delId) {
    const res = await api.removeHistory(delId);
    if (!res.ok) {
      if (err) err.textContent = res.error || '删除失败';
      return;
    }
    if (ok) ok.textContent = '已删除';
    await refreshHistory();
  }
});

document.getElementById('clearHistoryBtn').addEventListener('click', async () => {
  if (!confirm('确定清空全部浏览历史？此操作不可恢复。')) return;
  const err = document.getElementById('historyError');
  const ok = document.getElementById('historyOk');
  const res = await api.clearHistory();
  if (!res.ok) {
    if (err) err.textContent = res.error || '清空失败';
    return;
  }
  if (ok) ok.textContent = '已清空历史记录';
  await refreshHistory();
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
  void refreshWatchRequests();
});

document.getElementById('syncOnlyBtn').addEventListener('click', () => {
  void pullConfigQuick();
});

document.getElementById('pendingRequestList').addEventListener('click', async (e) => {
  const approveId = e.target && e.target.getAttribute('data-approve');
  const rejectId = e.target && e.target.getAttribute('data-reject');
  const err = document.getElementById('requestsError');
  const ok = document.getElementById('requestsOk');
  if (err) err.textContent = '';
  if (ok) ok.textContent = '';
  if (approveId) {
    const res = await api.approveWatchRequest(approveId);
    if (!res.ok) {
      if (err) err.textContent = res.error || '同意失败';
      return;
    }
    if (res.rules) applyRules(res.rules);
    if (ok) {
      if (res.mid) ok.textContent = `已同意，UP ${res.mid} 已加入白名单`;
      else if (res.host) ok.textContent = `已同意，域名 ${res.host} 已加入白名单`;
      else ok.textContent = '已同意，已放行该地址';
    }
    await refreshWatchRequests();
    return;
  }
  if (rejectId) {
    const res = await api.rejectWatchRequest(rejectId);
    if (!res.ok) {
      if (err) err.textContent = res.error || '拒绝失败';
      return;
    }
    if (ok) ok.textContent = '已拒绝';
    await refreshWatchRequests();
  }
});

document.getElementById('gateGotoRegister').addEventListener('click', () => {
  document.getElementById('gateRegisterError').textContent = '';
  showAuth(accountRegisterPanel);
});

document.getElementById('gateGotoLogin').addEventListener('click', () => {
  void showAccountGate();
});

document.getElementById('gateLoginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('gateLoginError');
  err.textContent = '';
  const res = await api.loginAccount({
    username: document.getElementById('gateLoginUser').value.trim(),
    password: document.getElementById('gateLoginPass').value,
  });
  if (!res.ok) {
    err.textContent = res.error || '登录失败';
    return;
  }
  document.getElementById('gateLoginPass').value = '';
  await showUnlockGate();
});

document.getElementById('gateRegisterForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('gateRegisterError');
  const pass = document.getElementById('gateRegisterPass').value;
  const pass2 = document.getElementById('gateRegisterPass2').value;
  err.textContent = '';
  if (pass.length < 6) {
    err.textContent = '密码至少 6 位';
    return;
  }
  if (pass !== pass2) {
    err.textContent = '两次密码不一致';
    return;
  }
  const res = await api.registerAccount({
    username: document.getElementById('gateRegisterUser').value.trim(),
    password: pass,
  });
  if (!res.ok) {
    err.textContent = res.error || '注册失败';
    return;
  }
  document.getElementById('gateRegisterPass').value = '';
  document.getElementById('gateRegisterPass2').value = '';
  await showUnlockGate();
});

document.getElementById('gateLogoutBtn').addEventListener('click', async () => {
  await api.logoutAccount();
  await showAccountGate();
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

function formatSyncTime(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return '';
  }
}

function formatHistoryTime(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const today = new Date();
    const sameDay =
      d.getFullYear() === today.getFullYear() &&
      d.getMonth() === today.getMonth() &&
      d.getDate() === today.getDate();
    if (sameDay) return `${hh}:${mm}`;
    return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
  } catch {
    return '';
  }
}

function formatReqTime(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return '';
  }
}

function updateRequestBadge(count) {
  const badge = document.getElementById('requestBadge');
  if (!badge) return;
  if (count > 0) {
    badge.textContent = String(count > 99 ? '99+' : count);
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function renderRequestLists(requests) {
  const pendingEl = document.getElementById('pendingRequestList');
  const resolvedEl = document.getElementById('resolvedRequestList');
  const pendingEmpty = document.getElementById('pendingRequestEmpty');
  const resolvedEmpty = document.getElementById('resolvedRequestEmpty');
  pendingEl.innerHTML = '';
  resolvedEl.innerHTML = '';

  const pending = (requests || []).filter((r) => r.status === 'pending');
  const resolved = (requests || [])
    .filter((r) => r.status !== 'pending')
    .slice(0, 30);

  updateRequestBadge(pending.length);
  pendingEmpty.classList.toggle('hidden', pending.length > 0);
  resolvedEmpty.classList.toggle('hidden', resolved.length > 0);

  for (const r of pending) {
    const item = document.createElement('div');
    item.className = 'request-item';
    const isBili = r.mid || r.bvid || (r.host && String(r.host).includes('bilibili'));
    const title = r.title || r.host || r.bvid || r.aid || '访问申请';
    const approveLabel = r.mid ? '同意并加 UP' : isBili ? '同意并放行' : '同意并加域名';
    item.innerHTML = `
      <div class="req-title">${escapeHtml(title)}</div>
      <div class="req-meta">
        ${r.mid ? `UP ${escapeHtml(r.mid)} · ` : r.host ? `${escapeHtml(r.host)} · ` : ''}
        ${formatReqTime(r.createdAt)}
        <br />${escapeHtml(r.url || '')}
      </div>
      <div class="req-actions">
        <button type="button" class="primary" data-approve="${r.id}">${approveLabel}</button>
        <button type="button" data-reject="${r.id}">拒绝</button>
      </div>
    `;
    pendingEl.appendChild(item);
  }

  for (const r of resolved) {
    const item = document.createElement('div');
    item.className = 'request-item';
    const title = r.title || r.host || r.bvid || r.aid || '访问申请';
    const statusLabel = r.status === 'approved' ? '已同意' : '已拒绝';
    item.innerHTML = `
      <div class="req-title">${escapeHtml(title)}</div>
      <div class="req-meta">
        ${statusLabel}
        ${r.mid ? ` · UP ${escapeHtml(r.mid)}` : r.host ? ` · ${escapeHtml(r.host)}` : ''}
        · ${formatReqTime(r.resolvedAt || r.createdAt)}
        <br />${escapeHtml(r.url || '')}
      </div>
    `;
    resolvedEl.appendChild(item);
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function refreshHistoryCount() {
  const el = document.getElementById('statHistory');
  if (!el) return;
  try {
    const res = await api.listHistory();
    el.textContent = String((res && res.count) || 0);
  } catch {
    el.textContent = '0';
  }
}

async function refreshHistory() {
  const err = document.getElementById('historyError');
  const ok = document.getElementById('historyOk');
  const list = document.getElementById('historyList');
  const empty = document.getElementById('historyEmpty');
  if (err) err.textContent = '';
  if (ok) ok.textContent = '';
  const query = document.getElementById('historySearch').value.trim();
  try {
    const res = await api.listHistory(query);
    const entries = (res && res.entries) || [];
    const countEl = document.getElementById('statHistory');
    if (countEl) countEl.textContent = String((res && res.count) || 0);
    list.innerHTML = '';
    empty.classList.toggle('show', entries.length === 0);
    for (const item of entries) {
      const row = document.createElement('div');
      row.className = 'history-row';
      row.dataset.openHistory = item.id;
      row.title = item.url || '';
      row.innerHTML = `
        <span class="history-time">${escapeHtml(formatHistoryTime(item.visitedAt))}</span>
        <span class="history-title">${escapeHtml(item.title || item.host || item.url)}</span>
        <span class="history-host">${escapeHtml(item.host || '')}</span>
        <button type="button" class="danger" data-del-history="${item.id}">删除</button>
      `;
      list.appendChild(row);
    }
  } catch (e) {
    if (err) err.textContent = e && e.message ? e.message : '读取失败';
  }
}

async function refreshWatchRequests() {
  const err = document.getElementById('requestsError');
  const ok = document.getElementById('requestsOk');
  if (err) err.textContent = '';
  if (ok) ok.textContent = '';
  try {
    const res = await api.listWatchRequests();
    if (!res || !res.ok) {
      if (err) err.textContent = (res && res.error) || '无法读取申请列表';
      updateRequestBadge(0);
      return;
    }
    renderRequestLists(res.requests || []);
  } catch (e) {
    if (err) err.textContent = e && e.message ? e.message : '读取失败';
  }
}

function showAuthMode(mode) {
  document.getElementById('loginCard').classList.toggle('hidden', mode !== 'login');
  document.getElementById('registerCard').classList.toggle('hidden', mode !== 'register');
  document.getElementById('loginError').textContent = '';
  document.getElementById('registerError').textContent = '';
}

async function refreshAccountPanel(opts = {}) {
  const keepMessage = Boolean(opts.keepMessage);
  const account = await api.getAccount();
  const out = document.getElementById('accountLoggedOut');
  const inn = document.getElementById('accountLoggedIn');
  if (!keepMessage) {
    document.getElementById('syncError').textContent = '';
    document.getElementById('syncOk').textContent = '';
  }
  if (!account) return;

  // Keep sidebar summary in sync when opening this page.
  try {
    const rules = await api.getRules();
    if (rules) applyRules(rules);
  } catch {
    // ignore
  }

  if (account.loggedIn) {
    out.classList.add('hidden');
    inn.classList.remove('hidden');
    document.getElementById('accountName').textContent = account.username;
    document.getElementById('localRev').textContent = `v${account.lastRevision || 0}`;
    document.getElementById('serverRev').textContent = '…';
    document.getElementById('syncStatusLine').textContent = '正在检查服务器版本…';
    const t = formatSyncTime(account.lastSyncAt);
    document.getElementById('accountSyncMeta').textContent = t
      ? `上次同步：${t}`
      : '尚未同步过';

    try {
      const status = await api.getSyncStatus();
      if (!status || !status.ok) {
        document.getElementById('serverRev').textContent = '获取失败';
        document.getElementById('syncStatusLine').textContent =
          status?.error || '无法连接服务器';
        return;
      }
      document.getElementById('localRev').textContent = `v${status.localRevision || 0}`;
      document.getElementById('serverRev').textContent = `v${status.serverRevision || 0}`;
      document.getElementById('syncStatusLine').textContent =
        status.status || '本地已是最新配置';
    } catch (e) {
      document.getElementById('serverRev').textContent = '获取失败';
      document.getElementById('syncStatusLine').textContent =
        e && e.message ? e.message : '检查服务器版本失败';
    }
  } else {
    out.classList.remove('hidden');
    inn.classList.add('hidden');
    showAuthMode('login');
  }
}

document.getElementById('gotoRegisterBtn').addEventListener('click', () => {
  showAuthMode('register');
});

document.getElementById('gotoLoginBtn').addEventListener('click', () => {
  showAuthMode('login');
});

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('loginError');
  err.textContent = '';
  const res = await api.loginAccount({
    username: document.getElementById('loginUser').value.trim(),
    password: document.getElementById('loginPass').value,
  });
  if (!res.ok) {
    err.textContent = res.error || '登录失败';
    return;
  }
  document.getElementById('loginPass').value = '';
  await refreshAccountPanel();
});

document.getElementById('registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('registerError');
  const pass = document.getElementById('registerPass').value;
  const pass2 = document.getElementById('registerPass2').value;
  err.textContent = '';
  if (pass.length < 6) {
    err.textContent = '密码至少 6 位';
    return;
  }
  if (pass !== pass2) {
    err.textContent = '两次密码不一致';
    return;
  }
  const res = await api.registerAccount({
    username: document.getElementById('registerUser').value.trim(),
    password: pass,
  });
  if (!res.ok) {
    err.textContent = res.error || '注册失败';
    return;
  }
  document.getElementById('registerPass').value = '';
  document.getElementById('registerPass2').value = '';
  await refreshAccountPanel();
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await api.logoutAccount();
  await refreshAccountPanel();
});

document.getElementById('pushBtn').addEventListener('click', async () => {
  const err = document.getElementById('syncError');
  const ok = document.getElementById('syncOk');
  err.textContent = '';
  ok.textContent = '';
  const res = await api.pushConfig();
  if (!res.ok) {
    err.textContent = res.error || '上传失败';
    await refreshAccountPanel({ keepMessage: true });
    return;
  }
  ok.textContent = res.unchanged ? '云端已是最新配置' : '已上传';
  if (res.rules) applyRules(res.rules);
  await refreshAccountPanel({ keepMessage: true });
});

document.getElementById('pullBtn').addEventListener('click', async () => {
  const err = document.getElementById('syncError');
  const ok = document.getElementById('syncOk');
  err.textContent = '';
  ok.textContent = '';
  const res = await api.pullConfig();
  if (!res.ok) {
    err.textContent = res.error || '拉取失败';
    await refreshAccountPanel({ keepMessage: true });
    return;
  }
  ok.textContent = res.unchanged ? '本地已是最新配置' : '已拉取并更新';
  if (res.rules) applyRules(res.rules);
  await refreshAccountPanel({ keepMessage: true });
});

api.onMeta(async (meta) => {
  if (meta.forceSetup) {
    showAuth(setupPanel);
    return;
  }
  if (meta.unlocked) {
    void enterDashboard();
    return;
  }
  const account = await api.getAccount();
  if (account && account.loggedIn) await showUnlockGate();
  else await showAccountGate();
});

const EYE_OPEN =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"/><path d="M10.6 10.6a2 2 0 0 0 2.8 2.8"/><path d="M9.4 5.1A10.8 10.8 0 0 1 12 5c6.5 0 10 7 10 7a17.7 17.7 0 0 1-3.3 4.6"/><path d="M6.1 6.1C3.7 7.8 2 12 2 12s3.5 7 10 7a10.6 10.6 0 0 0 4.2-.8"/></svg>';

function enhancePasswordFields(root) {
  (root || document).querySelectorAll('input[type="password"]').forEach((input) => {
    if (input.closest('.pw-wrap')) return;
    const wrap = document.createElement('span');
    wrap.className = 'pw-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pw-toggle';
    btn.tabIndex = -1;
    btn.setAttribute('aria-label', '显示密码');
    btn.innerHTML = EYE_OPEN;
    btn.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
      btn.innerHTML = show ? EYE_OFF : EYE_OPEN;
    });
    wrap.appendChild(btn);
  });
}

enhancePasswordFields();
boot();
