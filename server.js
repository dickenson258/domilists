// 本地预览（可选）。静态文件来自 public/，主机跳转和 noindex 规则与 functions/seo-policy.js 相同。
// 没有对应文件的地址返回 404（404.html），不再把首页当成未知路径的兜底。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide } from './functions/seo-policy.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const ROOT = path.resolve(PUBLIC);
const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || '0.0.0.0';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.xml': 'application/xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

function safeJoin(rel) {
  const file = path.resolve(ROOT, rel);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return null;
  return file;
}
function fileExists(rel) {
  const file = safeJoin(rel);
  if (!file) return null;
  try {
    if (fs.statSync(file).isFile()) return file;
  } catch { /* missing */ }
  return null;
}
function dirExists(rel) {
  const file = safeJoin(rel);
  if (!file) return null;
  try {
    if (fs.statSync(file).isDirectory()) return file;
  } catch { /* missing */ }
  return null;
}

// 尽量贴近 Pages：/en → /en/，/privacy.html → /privacy，目录首页直接返回 index.html。
export function resolveAsset(pathname) {
  if (pathname.endsWith('/index.html')) {
    const dir = pathname.slice(0, -'index.html'.length);
    return { redirect: dir || '/' };
  }
  if (pathname.endsWith('.html') && pathname !== '/404.html') {
    const bare = pathname.slice(0, -'.html'.length) || '/';
    const rel = bare === '/' ? 'index.html' : `${bare.slice(1)}.html`;
    if (fileExists(rel)) return { redirect: bare };
  }
  if (pathname.length > 1 && pathname.endsWith('/')) {
    const bare = pathname.slice(0, -1).slice(1);
    if (dirExists(bare) && fileExists(`${bare}/index.html`)) return { file: fileExists(`${bare}/index.html`) };
    if (fileExists(`${bare}.html`) || fileExists(bare)) return { redirect: pathname.slice(0, -1) };
  }
  if (pathname === '/') return { file: fileExists('index.html') };
  const rel = pathname.slice(1);
  const exact = fileExists(rel);
  if (exact) return { file: exact };
  if (dirExists(rel) && fileExists(`${rel}/index.html`)) return { redirect: `${pathname}/` };
  const html = !path.extname(rel) && fileExists(`${rel}.html`);
  if (html) return { file: html };
  return { missing: true };
}

function sendText(res, status, body, robots) {
  const headers = { 'content-type': 'text/plain; charset=utf-8' };
  if (robots) headers['x-robots-tag'] = robots;
  res.writeHead(status, headers);
  res.end(body);
}

function injectRobots(html, directive) {
  if (!directive || /<meta\s+name=["']robots["']/i.test(html)) return html;
  return html.replace(/<head[^>]*>/i, (open) => `${open}\n  <meta name="robots" content="${directive}">`);
}

function sendFile(res, status, file, robots) {
  const ext = path.extname(file);
  const headers = { 'content-type': MIME[ext] || 'application/octet-stream' };
  if (robots) headers['x-robots-tag'] = robots;
  if (robots && ext === '.html') {
    const html = injectRobots(fs.readFileSync(file, 'utf8'), robots);
    res.writeHead(status, headers);
    res.end(html);
    return;
  }
  res.writeHead(status, headers);
  fs.createReadStream(file).pipe(res);
}

export function handle(req, res) {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    sendText(res, 400, 'Bad request', null);
    return;
  }
  const decision = decide(req.headers.host || url.host, url.href);
  if (decision.redirect) {
    res.writeHead(decision.redirect.status, {
      location: decision.redirect.location,
      'content-type': 'text/plain; charset=utf-8',
    });
    res.end(`Redirecting to ${decision.redirect.location}`);
    return;
  }
  let pathname = url.pathname;
  try { pathname = decodeURIComponent(pathname); } catch {
    sendText(res, 404, 'Not found', decision.robots);
    return;
  }
  const asset = resolveAsset(pathname);
  if (asset.redirect) {
    const location = asset.redirect + url.search;
    res.writeHead(308, { location, 'content-type': 'text/plain; charset=utf-8' });
    res.end(`Redirecting to ${location}`);
    return;
  }
  if (asset.file) {
    sendFile(res, 200, asset.file, decision.robots);
    return;
  }
  const ext = path.extname(pathname);
  // 缺失的 .txt / .js 等不要返回 HTML，避免把 llms.txt 这类地址看成网页。
  if (ext && ext !== '.html') {
    sendText(res, 404, 'Not found', decision.robots);
    return;
  }
  const notFound = fileExists('404.html');
  if (!notFound) {
    sendText(res, 404, 'Not found', decision.robots);
    return;
  }
  sendFile(res, 404, notFound, decision.robots);
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  const server = http.createServer(handle);
  server.listen(PORT, HOST, () => {
    const actual = server.address().port;
    console.log(`\n  Domi Lists → http://localhost:${actual}`);
    if (HOST === '0.0.0.0')
      for (const list of Object.values(os.networkInterfaces()))
        for (const a of list || []) if (a.family === 'IPv4' && !a.internal) console.log(`             http://${a.address}:${actual}  (LAN)`);
    console.log('');
  });
}
