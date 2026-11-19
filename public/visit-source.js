// First-party visit source: send at most once per session, and only when
// the URL has a valid ?ref= / ?source= / ?utm_source= tag. Soft-fail.
// No page URL, watchlist id, referrer, or "direct" fallback.
(() => {
  const API = 'https://api.domibuddy.com/v1/events';
  const OK = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
  let q;
  try { q = new URLSearchParams(location.search); } catch { return; }
  let source = '';
  for (const key of ['ref', 'source', 'utm_source']) {
    const tag = String(q.get(key) || '').trim().toLowerCase();
    if (OK.test(tag)) { source = tag; break; }
  }
  if (!source) return;
  try {
    if (sessionStorage.getItem('domi:visitSource')) return;
    sessionStorage.setItem('domi:visitSource', '1');
  } catch {}
  try {
    fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'visit', source }),
      keepalive: true,
    }).catch(() => {});
  } catch {}
})();
