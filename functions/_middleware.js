// Runs on every Pages request (including static files), ahead of the asset server.
// - domibuddy.com and www.domibuddy.com → 301 https://lists.domibuddy.com (path + query kept)
// - domibuddy.pages.dev and preview *.pages.dev stay put and get X-Robots-Tag: noindex
// - ?import= and /l/* get X-Robots-Tag: noindex, follow (the lists.domibuddy.com/l/* Worker
//   bypasses Pages; see the PR note — index.html also sets the meta after that Worker rewrites the hash)
// - /go/* is repeated from public/_redirects because Pages does not apply _redirects
//   on a route a Function handles
import { decide } from "./seo-policy.js";

// Cloudflare Pages' automatic Early Hints probe refetches HTML with these user agents
// ("fl2 early hints", "nginx-ssl early hints"). It is not a visitor. The probe has a short
// timeout; running it through redirects or HTMLRewriter is what lines up with the ~107-byte
// 504s (0 visits). Hand the asset back untouched. Real visitors are unaffected.
const EARLY_HINTS_UA = /early hints/i;

export async function onRequest(context) {
  const request = context.request;
  if (EARLY_HINTS_UA.test(request.headers.get("user-agent") || "")) return context.next();
  const host = request.headers.get("host") || new URL(request.url).host;
  const decision = decide(host, request.url);
  if (decision.redirect) return Response.redirect(decision.redirect.location, decision.redirect.status);
  const response = await context.next();
  if (!decision.robots) return response;
  return withRobots(response, decision.robots);
}

function withRobots(response, directive) {
  const headers = new Headers(response.headers);
  headers.set("X-Robots-Tag", directive);
  const empty = response.status === 204 || response.status === 304 || response.body == null;
  const type = (headers.get("content-type") || "").toLowerCase();
  const canRewrite = !empty && type.includes("text/html") && typeof HTMLRewriter === "function";
  if (!canRewrite) {
    return new Response(empty ? null : response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  // Body changed, so the asset etag would not match.
  headers.delete("etag");
  return new HTMLRewriter().on("head", {
    element(element) {
      element.append(`<meta name="robots" content="${directive}">`, { html: true });
    },
  }).transform(new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  }));
}
