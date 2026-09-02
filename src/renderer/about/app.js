const api = window.youthAbout;

const versionEl = document.getElementById('aboutVersion');
const siteBtn = document.getElementById('aboutSite');
const siteUrlEl = document.getElementById('aboutSiteUrl');

function hostPath(url) {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.replace(/\/$/, '');
  } catch {
    return url;
  }
}

api.getInfo().then((info) => {
  if (!info) return;
  versionEl.textContent = info.version ? `版本 ${info.version}` : '版本 —';
  if (info.website) siteUrlEl.textContent = hostPath(info.website);
});

siteBtn.addEventListener('click', () => {
  api.openWebsite();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') api.close();
});
