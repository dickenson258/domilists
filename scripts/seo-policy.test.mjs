import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decide, GO_EXACT, GO_PLATFORMS } from '../functions/seo-policy.js';
import { onRequest } from '../functions/_middleware.js';
import { handle } from '../server.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function redirectRules() {
  return read('public/_redirects')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const [src, dest, status] = line.split(/\s+/);
      return { src, dest, status };
    });
}

test('every _redirects rule is a 302 to / and is implemented by the Pages function', () => {
  const rules = redirectRules();
  assert.ok(rules.length > 0);
  const exact = rules.filter((rule) => !rule.src.includes(':')).map((rule) => rule.src);
  const platforms = rules.filter((rule) => rule.src.includes(':campaign')).map((rule) => rule.src.split('/')[2]);
  assert.deepEqual(exact, GO_EXACT);
  assert.deepEqual(platforms, GO_PLATFORMS);
  for (const rule of rules) {
    assert.equal(rule.dest, '/');
    assert.equal(rule.status, '302');
    const sample = rule.src.replace(':campaign', 'sample-en-20261119');
    const decision = decide('lists.domibuddy.com', `https://lists.domibuddy.com${sample}?ref=promo`);
    assert.equal(decision.redirect?.status, 302, sample);
    const location = new URL(decision.redirect.location);
    assert.equal(location.origin, 'https://lists.domibuddy.com');
    assert.equal(location.pathname, '/');
    assert.equal(location.search, '?ref=promo');
    assert.equal(location.hash, '');
    assert.equal(decision.robots, null);
  }
});

test('apex and www 301 to the canonical host and keep path plus query', () => {
  for (const host of ['domibuddy.com', 'www.domibuddy.com', 'WWW.DomiBuddy.com']) {
    const decision = decide(host, `http://${host}/en/guides/youtube-kids-alternative/?utm_source=x&ref=promo`);
    assert.equal(decision.redirect?.status, 301);
    assert.equal(
      decision.redirect.location,
      'https://lists.domibuddy.com/en/guides/youtube-kids-alternative/?utm_source=x&ref=promo',
    );
  }
  const go = decide('www.domibuddy.com', 'https://www.domibuddy.com/go/x/profile?ref=a');
  assert.equal(go.redirect.location, 'https://lists.domibuddy.com/go/x/profile?ref=a');
});

test('http on the canonical host upgrades to https without dropping the import query', () => {
  const decision = decide('lists.domibuddy.com', 'http://lists.domibuddy.com/?import=abc&ref=promo');
  assert.equal(decision.redirect?.status, 301);
  assert.equal(decision.redirect.location, 'https://lists.domibuddy.com/?import=abc&ref=promo');
});

test('pages.dev hosts are not redirected and are noindex', () => {
  for (const host of ['domibuddy.pages.dev', 'feat.domibuddy.pages.dev', 'abc123.domibuddy.pages.dev']) {
    const decision = decide(host, `https://${host}/en/watchlists/toddler-watchlist-ages-2-4/`);
    assert.equal(decision.redirect, null);
    assert.equal(decision.robots, 'noindex');
  }
  const imported = decide('domibuddy.pages.dev', 'https://domibuddy.pages.dev/?import=1');
  assert.equal(imported.redirect, null);
  assert.equal(imported.robots, 'noindex, follow');
});

test('canonical host indexes real pages and noindexes import urls', () => {
  const home = decide('lists.domibuddy.com', 'https://lists.domibuddy.com/');
  assert.equal(home.redirect, null);
  assert.equal(home.robots, null);
  const guide = decide('lists.domibuddy.com', 'https://lists.domibuddy.com/en/guides/youtube-kids-alternative/');
  assert.equal(guide.robots, null);
  const privacy = decide('lists.domibuddy.com', 'https://lists.domibuddy.com/privacy');
  assert.equal(privacy.robots, null);
  const promo = decide('lists.domibuddy.com', 'https://lists.domibuddy.com/?ref=promo&utm_source=x');
  assert.equal(promo.redirect, null);
  assert.equal(promo.robots, null);
  for (const url of [
    'https://lists.domibuddy.com/?import=abc',
    'https://lists.domibuddy.com/?ref=promo&import=',
    'https://lists.domibuddy.com/privacy?import=1',
    'https://lists.domibuddy.com/l/NXfOJ8S7',
    'https://lists.domibuddy.com/l',
  ]) {
    const decision = decide('lists.domibuddy.com', url);
    assert.equal(decision.redirect, null, url);
    assert.equal(decision.robots, 'noindex, follow', url);
  }
  const notShort = decide('lists.domibuddy.com', 'https://lists.domibuddy.com/llms.txt');
  assert.equal(notShort.robots, null);
});

test('unknown campaign paths are not redirected', () => {
  for (const path of ['/go/myspace/hi', '/go/x', '/go/x-intro/extra', '/go/X/sample']) {
    const decision = decide('lists.domibuddy.com', `https://lists.domibuddy.com${path}`);
    assert.equal(decision.redirect, null, path);
  }
});

test('localhost preview is left alone', () => {
  const decision = decide('localhost:5173', 'http://localhost:5173/');
  assert.equal(decision.redirect, null);
  assert.equal(decision.robots, null);
});

test('middleware redirects from the Host header and does not call the asset server', async () => {
  let called = false;
  const response = await onRequest({
    request: new Request('https://lists.domibuddy.com/privacy?x=1', { headers: { host: 'www.domibuddy.com' } }),
    async next() {
      called = true;
      return new Response('no');
    },
  });
  assert.equal(called, false);
  assert.equal(response.status, 301);
  assert.equal(response.headers.get('location'), 'https://lists.domibuddy.com/privacy?x=1');
});

test('early hints probes skip redirects and HTML rewrites', async () => {
  const html = '<!doctype html><html><head><title>x</title></head><body>ok</body></html>';
  for (const ua of ['fl2 early hints', 'nginx-ssl early hints']) {
    let called = false;
    const original = new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', etag: 'abc' } });
    const response = await onRequest({
      request: new Request('https://lists.domibuddy.com/?import=abc', {
        headers: { host: 'www.domibuddy.com', 'user-agent': ua },
      }),
      async next() {
        called = true;
        return original;
      },
    });
    assert.equal(called, true, ua);
    assert.equal(response, original, ua);
  }
  const browser = await onRequest({
    request: new Request('https://lists.domibuddy.com/?import=abc', {
      headers: { host: 'lists.domibuddy.com', 'user-agent': 'Mozilla/5.0' },
    }),
    async next() {
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    },
  });
  assert.equal(browser.headers.get('x-robots-tag'), 'noindex, follow');
});

test('middleware sets the robots header and leaves ordinary assets untouched', async () => {
  const html = '<!doctype html><html><head><title>x</title></head><body>ok</body></html>';
  const imported = await onRequest({
    request: new Request('https://lists.domibuddy.com/?import=abc&ref=promo', { headers: { host: 'lists.domibuddy.com' } }),
    async next() {
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', etag: 'abc' } });
    },
  });
  assert.equal(imported.status, 200);
  assert.equal(imported.headers.get('x-robots-tag'), 'noindex, follow');
  assert.match(await imported.text(), /ok/);

  const original = new Response('js', { status: 200, headers: { 'content-type': 'text/javascript' } });
  const asset = await onRequest({
    request: new Request('https://lists.domibuddy.com/app.js', { headers: { host: 'lists.domibuddy.com' } }),
    async next() { return original; },
  });
  assert.equal(asset, original);

  const preview = await onRequest({
    request: new Request('https://feat.domibuddy.pages.dev/en/', { headers: { host: 'feat.domibuddy.pages.dev' } }),
    async next() {
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    },
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get('x-robots-tag'), 'noindex');
  assert.equal(preview.headers.get('location'), null);
});

test('homepage and privacy publish a self-referencing canonical and do not noindex themselves', () => {
  const home = read('public/index.html');
  const privacy = read('public/privacy.html');
  assert.match(home, /<link rel="canonical" href="https:\/\/lists\.domibuddy\.com\/" \/>/);
  assert.doesNotMatch(home, /<meta name="robots"/);
  assert.match(home, /noindex, follow/);
  assert.match(home, /#\\\/\(import\|i\|s\)/);
  assert.match(home, /params\.has\("import"\)/);
  assert.match(home, /src="\/visit-source\.js"/);
  const resources = home.match(/<div id="home-resource-links"[\s\S]*?<\/div>/)?.[0];
  assert.ok(resources, 'the initial HTML must contain the public parent links');
  for (const lang of ['zh', 'en']) {
    for (const path of ['watchlists/english-starter-ages-3-6', 'watchlists/mandarin-starter-ages-3-6', 'guides/youtube-kids-alternative']) {
      const url = `https://lists.domibuddy.com/${lang}/${path}/`;
      assert.ok(resources.includes(`href="${url}"`), url);
      assert.ok(fs.existsSync(new URL(`../public/${lang}/${path}/index.html`, import.meta.url)), url);
    }
  }
  assert.match(privacy, /<link rel="canonical" href="https:\/\/lists\.domibuddy\.com\/privacy" \/>/);
  assert.match(privacy, /我们不收集、不出售任何个人信息/);
  assert.doesNotMatch(privacy, /<meta name="robots"/);
  const notFound = read('public/404.html');
  assert.match(notFound, /Page not found/);
  assert.match(notFound, /<meta name="robots" content="noindex" \/>/);
  assert.doesNotMatch(notFound, /id="app"/);
  assert.doesNotMatch(notFound, /visit-source\.js/);
  assert.match(home, /rel="icon" href="favicon\.ico"/);
  assert.match(home, /rel="apple-touch-icon" href="apple-touch-icon\.png"/);
  assert.doesNotMatch(home, /rel="preload"|rel="preconnect"|rel="modulepreload"/);
  assert.match(read('public/_headers'), /! Link/);
});

test('every html page links a real favicon and apple touch icon', () => {
  const pages = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.html')) pages.push(full);
    }
  };
  walk(path.join(ROOT, 'public'));
  assert.ok(pages.length >= 12);
  for (const page of pages) {
    const html = fs.readFileSync(page, 'utf8');
    assert.match(html, /rel="icon"[^>]*href="[^"]*favicon\.ico"/, page);
    assert.match(html, /rel="apple-touch-icon"[^>]*href="[^"]*apple-touch-icon\.png"/, page);
    assert.doesNotMatch(html, /rel="preload"|rel="preconnect"|rel="modulepreload"/, page);
  }
  const ico = fs.readFileSync(path.join(ROOT, 'public/favicon.ico'));
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 3);
  assert.deepEqual([ico[6], ico[22], ico[38]], [16, 32, 48]);
  const touch = fs.readFileSync(path.join(ROOT, 'public/apple-touch-icon.png'));
  assert.equal(touch.readUInt32BE(16), 180);
  assert.equal(touch.readUInt32BE(20), 180);
  assert.equal(touch[25], 2);
});

test('import routes and the promo-only visit source are still in the client', () => {
  const app = read('public/app.js');
  assert.match(app, /page === 'import'/);
  assert.match(app, /page === 'i'/);
  assert.match(app, /page === 's'/);
  assert.match(app, /function renderImport/);
  const source = read('public/visit-source.js');
  assert.match(source, /ref', 'source', 'utm_source'/);
  assert.match(source, /https:\/\/api\.domibuddy\.com\/v1\/events/);
  assert.doesNotMatch(source, /noindex/);
});

let server;
let previewPort;
after(() => server?.listening && new Promise((resolve) => server.close(resolve)));

async function fetchPath(urlPath, headers = {}) {
  if (!previewPort) {
    server = http.createServer(handle);
    previewPort = once(server.listen(0, '127.0.0.1'), 'listening')
      .then(() => server.address().port);
  }
  const port = await previewPort;
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method: 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('preview server serves real pages, canonicals, and a hard 404', async () => {
  const home = await fetchPath('/');
  assert.equal(home.status, 200);
  assert.match(home.body, /<link rel="canonical" href="https:\/\/lists\.domibuddy\.com\/" \/>/);
  assert.match(home.body, /src="\/visit-source\.js"/);
  assert.equal(home.headers['x-robots-tag'], undefined);
  assert.doesNotMatch(home.body, /<meta name="robots"/);

  const privacy = await fetchPath('/privacy');
  assert.equal(privacy.status, 200);
  assert.match(privacy.body, /<link rel="canonical" href="https:\/\/lists\.domibuddy\.com\/privacy" \/>/);
  assert.match(privacy.body, /我们不收集、不出售任何个人信息/);

  const pages = [
    '/en/',
    '/zh/',
    '/en/watchlists/english-starter-ages-3-6/',
    '/zh/watchlists/english-starter-ages-3-6/',
    '/en/watchlists/toddler-watchlist-ages-2-4/',
    '/zh/watchlists/toddler-watchlist-ages-2-4/',
    '/en/watchlists/picture-book-read-alouds/',
    '/zh/watchlists/picture-book-read-alouds/',
    '/en/guides/youtube-kids-alternative/',
    '/zh/guides/youtube-kids-alternative/',
    '/en/watchlists/mandarin-starter-ages-3-6/',
    '/zh/watchlists/mandarin-starter-ages-3-6/',
    '/robots.txt',
    '/sitemap.xml',
    '/llms.txt',
    '/app.js',
  ];
  for (const page of pages) {
    const response = await fetchPath(page);
    assert.equal(response.status, 200, page);
    assert.equal(response.headers['x-robots-tag'], undefined, page);
  }
  const favicon = await fetchPath('/favicon.ico');
  assert.equal(favicon.status, 200);
  assert.equal(favicon.headers['content-type'], 'image/x-icon');
  const touchIcon = await fetchPath('/apple-touch-icon.png');
  assert.equal(touchIcon.status, 200);
  assert.equal(touchIcon.headers['content-type'], 'image/png');
  const svgIcon = await fetchPath('/icon.svg');
  assert.equal(svgIcon.status, 200);

  const guide = await fetchPath('/en/guides/youtube-kids-alternative/');
  assert.match(guide.body, /https:\/\/lists\.domibuddy\.com\/en\/guides\/youtube-kids-alternative\//);
  const llms = await fetchPath('/llms.txt');
  assert.match(llms.body, /^# Domi Lists/);
  assert.equal(llms.headers['content-type'], 'text/plain; charset=utf-8');

  const missing = await fetchPath('/no-such-page');
  assert.equal(missing.status, 404);
  assert.match(missing.body, /Page not found/);
  assert.doesNotMatch(missing.body, /id="app"/);
  assert.doesNotMatch(missing.body, /正在打开朵米片单/);

  const missingText = await fetchPath('/missing.txt');
  assert.equal(missingText.status, 404);
  assert.equal(missingText.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(missingText.body, 'Not found');

  const missingIcon = await fetchPath('/missing.ico');
  assert.equal(missingIcon.status, 404);
  assert.equal(missingIcon.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(missingIcon.body, 'Not found');

  const slash = await fetchPath('/en');
  assert.equal(slash.status, 308);
  assert.equal(slash.headers.location, '/en/');
  const html = await fetchPath('/privacy.html');
  assert.equal(html.status, 308);
  assert.equal(html.headers.location, '/privacy');
});

test('preview server noindexes import urls and still serves the app shell', async () => {
  const imported = await fetchPath('/?import=abc&ref=promo');
  assert.equal(imported.status, 200);
  assert.equal(imported.headers['x-robots-tag'], 'noindex, follow');
  assert.match(imported.body, /<meta name="robots" content="noindex, follow">/);
  assert.match(imported.body, /src="\/visit-source\.js"/);
  assert.match(imported.body, /src="app\.js"/);
  assert.match(imported.body, /<link rel="canonical" href="https:\/\/lists\.domibuddy\.com\/" \/>/);

  const promo = await fetchPath('/?ref=promo&utm_source=x');
  assert.equal(promo.status, 200);
  assert.equal(promo.headers['x-robots-tag'], undefined);
  assert.doesNotMatch(promo.body, /<meta name="robots"/);
  assert.match(promo.body, /src="\/visit-source\.js"/);

  const privacy = await fetchPath('/privacy?import=1');
  assert.equal(privacy.status, 200);
  assert.equal(privacy.headers['x-robots-tag'], 'noindex, follow');
  assert.match(privacy.body, /<meta name="robots" content="noindex, follow">/);
  assert.match(privacy.body, /我们不收集、不出售任何个人信息/);

  const short = await fetchPath('/l/NXfOJ8S7');
  assert.equal(short.status, 404);
  assert.equal(short.headers['x-robots-tag'], 'noindex, follow');
});

test('preview server redirects duplicate hosts and campaign links', async () => {
  const www = await fetchPath('/privacy?x=1', { host: 'www.domibuddy.com' });
  assert.equal(www.status, 301);
  assert.equal(www.headers.location, 'https://lists.domibuddy.com/privacy?x=1');

  const apex = await fetchPath('/en/guides/youtube-kids-alternative/?utm_source=x', { host: 'domibuddy.com' });
  assert.equal(apex.status, 301);
  assert.equal(apex.headers.location, 'https://lists.domibuddy.com/en/guides/youtube-kids-alternative/?utm_source=x');

  const preview = await fetchPath('/no-such-page', { host: 'feat.domibuddy.pages.dev' });
  assert.equal(preview.status, 404);
  assert.equal(preview.headers['x-robots-tag'], 'noindex');
  assert.match(preview.body, /Page not found/);
  assert.equal(preview.headers.location, undefined);

  const previewHome = await fetchPath('/', { host: 'domibuddy.pages.dev' });
  assert.equal(previewHome.status, 200);
  assert.equal(previewHome.headers['x-robots-tag'], 'noindex');
  assert.match(previewHome.body, /<meta name="robots" content="noindex">/);
  assert.match(previewHome.body, /<link rel="canonical" href="https:\/\/lists\.domibuddy\.com\/" \/>/);

  const campaign = await fetchPath('/go/reddit/post-en-20261119?ref=reddit');
  assert.equal(campaign.status, 302);
  const location = new URL(campaign.headers.location);
  assert.equal(location.pathname, '/');
  assert.equal(location.search, '?ref=reddit');
  assert.equal(location.hash, '');
});
