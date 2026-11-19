// Host canonicalization and robots policy shared by the Pages middleware and the local preview server.
// Pages _redirects cannot match on hostname, and a Function that handles a route skips _redirects,
// so the /go rules in public/_redirects are repeated here. scripts/seo-policy.test.mjs keeps them in sync.

export const CANONICAL_HOST = "lists.domibuddy.com";

// Custom domains on the Pages project that are not the canonical host.
export const REDIRECT_HOSTS = new Set(["domibuddy.com", "www.domibuddy.com"]);

// Keep in the same order as public/_redirects.
export const GO_EXACT = ["/go/x-intro"];
export const GO_PLATFORMS = [
  "x",
  "reddit",
  "instagram",
  "threads",
  "facebook",
  "youtube",
  "tiktok",
  "linkedin",
  "pinterest",
  "bluesky",
  "mastodon",
  "telegram",
  "discord",
  "whatsapp",
  "wechat",
  "xiaohongshu",
  "douyin",
  "bilibili",
  "zhihu",
  "hackernews",
  "producthunt",
  "medium",
  "substack",
  "quora",
];

const GO_PLATFORM_SET = new Set(GO_PLATFORMS);

export function normalizeHost(host) {
  let value = String(host || "").trim().toLowerCase();
  if (!value) return "";
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end === -1 ? value : value.slice(0, end + 1);
  }
  return value.replace(/:\d+$/, "");
}

export function isPagesDevHost(host) {
  const name = normalizeHost(host);
  return name === "pages.dev" || name.endsWith(".pages.dev");
}

export function isShortLinkPath(pathname) {
  return pathname === "/l" || pathname.startsWith("/l/");
}

export function goTarget(pathname) {
  if (GO_EXACT.includes(pathname)) return "/";
  const match = /^\/go\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (!match || !GO_PLATFORM_SET.has(match[1]) || !match[2]) return null;
  return "/";
}

// "noindex, follow" for import/short links, "noindex" for pages.dev copies, otherwise indexable.
export function robotsDirective(host, pathname, search) {
  const params = new URLSearchParams(search && search.startsWith("?") ? search.slice(1) : (search || ""));
  if (isShortLinkPath(pathname) || params.has("import")) return "noindex, follow";
  if (isPagesDevHost(host)) return "noindex";
  return null;
}

// hostHeader is the Host header (may include a port). requestUrl is absolute.
// Redirects preserve path and query. Campaign /go redirects also preserve the query
// and omit the fragment so the browser keeps #/import/… .
export function decide(hostHeader, requestUrl) {
  const url = new URL(requestUrl);
  const host = normalizeHost(hostHeader || url.hostname);
  if (REDIRECT_HOSTS.has(host)) {
    return {
      redirect: { status: 301, location: `https://${CANONICAL_HOST}${url.pathname}${url.search}` },
      robots: null,
    };
  }
  if (host === CANONICAL_HOST && url.protocol === "http:") {
    return {
      redirect: { status: 301, location: `https://${CANONICAL_HOST}${url.pathname}${url.search}` },
      robots: null,
    };
  }
  if (goTarget(url.pathname)) {
    const dest = new URL(url.href);
    dest.pathname = "/";
    dest.hash = "";
    return { redirect: { status: 302, location: dest.toString() }, robots: null };
  }
  return { redirect: null, robots: robotsDirective(host, url.pathname, url.search) };
}
