const params = new URLSearchParams(location.search);
const reasonMap = {
  invalid_url: '无效地址',
  host_denied: '网站不在白名单',
  bili_path_denied: 'B 站路径未授权（仅允许指定 UP 的视频/空间）',
  bili_up_denied: '该 UP 主不在允许列表',
  bili_resolve_failed: '无法确认视频作者',
  protocol_denied: '协议不被允许',
};

document.getElementById('message').textContent =
  params.get('message') || '未授权的网站或内容';
document.getElementById('url').textContent = params.get('url') || '—';
const reason = params.get('reason') || '';
document.getElementById('reason').textContent =
  reasonMap[reason] || reason || '—';
