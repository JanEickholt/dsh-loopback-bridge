import { isUtf8 } from "node:buffer";
import { request } from "node:http";
import { request as request$1 } from "node:https";
import { pipeline } from "node:stream";
//#region src/inspector.ts
/**
* Dormant element inspector for relayed pages (sidebar Browser "Inspect").
*
* Injected into every relayed text/html response before `</body>`, after
* the nav helper. Dormant until the GUI frame posts `{ __dshInspect: 'arm' }`
* — only messages with `event.source === window.parent` act. Armed: hover
* highlight (outline + tint via an injected style), a fixed-top hint bar
* ("Click an element to reference it · Esc cancels", `pointer-events: none`
* so it can never be picked itself), and one capture-phase click —
* captured at `window`, the earliest point of the dispatch chain, so page
* handlers registered after arming never see it — posts the selection
* payload to the parent and disarms. Escape posts
* `{ __dshInspectCancelled: true }` and disarms. 'disarm' and every
* pick/cancel remove all armed listeners plus the injected style and hint;
* only the arm/disarm message listener stays for the document's life so a
* disarmed frame can be re-armed without a reload. Installs once per
* document: apps that re-execute body scripts on client navigation (Turbo,
* htmx) would otherwise stack listeners and post every pick twice.
*
* Payload: `{ __dshInspectSelected: true, selector, xpath, tagName, role,
* name, text, rect {x,y,width,height}, url, title, viewport {w,h} }`.
* `selector` prefers a unique `#id` (CSS.escape'd) and falls back to a
* structural `tag:nth-of-type(n)` path trimmed of html/body; `xpath` is the
* positional builder (`/html/body/div[2]/button[1]`). `name` resolves
* aria-label → aria-labelledby text → alt → innerText; name and text are
* whitespace-collapsed (the composer insert is one line) and bounded to
* 120 chars. `url` is the TARGET form — relay prefix stripped from
* `location.pathname` — falling back to `location.href` when the frame is
* not on a host-form relay route (legacy hostless tail). The hint-dot is
* emitted as `\u00b7` so non-UTF-8 upstream pages cannot mojibake it.
*
* Ceilings (v1): no shadow-DOM piercing (hover targets retarget to the
* shadow host); injection rides only relayed text/html responses, and the
* client lane re-routes native loopback frames through the relay before
* arming.
*/
const INSPECTOR_JS = String.raw`(function () {
'use strict';
if (window.__dshInspectorReady === true) return;
var HOVER_ATTR = 'data-dsh-inspect-hover';
var STYLE_ID = 'dsh-inspect-style';
var HINT_ID = 'dsh-inspect-hint';
var armed = false;
var styleEl = null;
var hintEl = null;
var hovered = null;
function squash(value) {
  return (value || '').replace(/\s+/g, ' ').trim();
}
function setHover(el) {
  if (hovered === el) return;
  if (hovered !== null) hovered.removeAttribute(HOVER_ATTR);
  hovered = el;
  if (el !== null) el.setAttribute(HOVER_ATTR, '');
}
function indexOfType(node) {
  var n = 0;
  for (var sib = node; sib !== null; sib = sib.previousElementSibling) {
    if (sib.tagName === node.tagName) n++;
  }
  return n;
}
function selectorFor(el) {
  var id = el.id;
  if (id !== '' && typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    var hashSel = '#' + CSS.escape(id);
    if (document.querySelectorAll(hashSel).length === 1) return hashSel;
  }
  var parts = [];
  for (var node = el; node !== null && node !== document.body && node !== document.documentElement; node = node.parentElement) {
    parts.unshift(node.tagName.toLowerCase() + ':nth-of-type(' + indexOfType(node) + ')');
  }
  // body and html themselves have no structural path below the trim.
  return parts.length > 0 ? parts.join(' > ') : el.tagName.toLowerCase();
}
function xpathFor(el) {
  var parts = [];
  for (var node = el; node !== null && node.nodeType === 1 && node !== document.documentElement; node = node.parentElement) {
    if (node === document.body) parts.unshift('body');
    else parts.unshift(node.tagName.toLowerCase() + '[' + indexOfType(node) + ']');
  }
  return parts.length > 0 ? '/html/' + parts.join('/') : '/html';
}
function nameOf(el) {
  var label = squash(el.getAttribute('aria-label'));
  if (label !== '') return label.slice(0, 120);
  var labelledby = el.getAttribute('aria-labelledby');
  if (labelledby !== null) {
    var names = [];
    var ids = labelledby.split(/\s+/);
    for (var i = 0; i < ids.length; i++) {
      if (ids[i] === '') continue;
      var ref = document.getElementById(ids[i]);
      if (ref !== null) names.push(squash(ref.textContent));
    }
    var joined = squash(names.join(' '));
    if (joined !== '') return joined.slice(0, 120);
  }
  var alt = squash(el.getAttribute('alt'));
  if (alt !== '') return alt.slice(0, 120);
  return squash(el.innerText).slice(0, 120);
}
function targetUrl() {
  var m = /^\/dsh-loopback\/(https?)\/([^/]+)\/(\d{1,5})(\/.*)?$/u.exec(location.pathname);
  if (m === null) return location.href;
  var port = m[3] === (m[1] === 'https' ? '443' : '80') ? '' : ':' + m[3];
  return m[1] + '://' + m[2] + port + (m[4] || '') + location.search + location.hash;
}
function buildPayload(el) {
  var rect = el.getBoundingClientRect();
  var role = el.getAttribute('role');
  return {
    __dshInspectSelected: true,
    selector: selectorFor(el),
    xpath: xpathFor(el),
    tagName: el.tagName.toLowerCase(),
    role: role === null ? '' : squash(role),
    name: nameOf(el),
    text: squash(el.innerText).slice(0, 120),
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    url: targetUrl(),
    title: document.title,
    viewport: { w: window.innerWidth, h: window.innerHeight },
  };
}
function disarm() {
  armed = false;
  setHover(null);
  window.removeEventListener('mouseover', onMouseOver, true);
  window.removeEventListener('mouseout', onMouseOut, true);
  window.removeEventListener('click', onClick, true);
  window.removeEventListener('keydown', onKeyDown, true);
  if (styleEl !== null && styleEl.parentNode !== null) styleEl.parentNode.removeChild(styleEl);
  if (hintEl !== null && hintEl.parentNode !== null) hintEl.parentNode.removeChild(hintEl);
  styleEl = null;
  hintEl = null;
}
function arm() {
  if (armed) return;
  armed = true;
  styleEl = document.createElement('style');
  styleEl.id = STYLE_ID;
  styleEl.textContent =
    '[' + HOVER_ATTR + ']{outline:2px solid #4f46e5 !important;outline-offset:-1px !important;background-color:rgba(79,70,229,0.12) !important}' +
    '#' + HINT_ID + '{position:fixed;top:0;left:0;right:0;z-index:2147483647;pointer-events:none;box-sizing:border-box;padding:8px 12px;text-align:center;font:500 13px/1.4 system-ui,sans-serif;color:#f9fafb;background:#111827;border-bottom:2px solid #4f46e5}';
  (document.head || document.documentElement).appendChild(styleEl);
  hintEl = document.createElement('div');
  hintEl.id = HINT_ID;
  hintEl.textContent = 'Click an element to reference it \u00b7 Esc cancels';
  (document.body || document.documentElement).appendChild(hintEl);
  window.addEventListener('mouseover', onMouseOver, true);
  window.addEventListener('mouseout', onMouseOut, true);
  window.addEventListener('click', onClick, true);
  window.addEventListener('keydown', onKeyDown, true);
}
function onMouseOver(ev) {
  var t = ev.target;
  if (t !== null && t.nodeType === 1 && t !== hintEl) setHover(t);
}
function onMouseOut(ev) {
  if (hovered === ev.target) {
    var to = ev.relatedTarget;
    if (to === null || !hovered.contains(to)) setHover(null);
  }
}
function onClick(ev) {
  var t = ev.target;
  if (t === null || t.nodeType !== 1) return;
  ev.preventDefault();
  ev.stopPropagation();
  window.parent.postMessage(buildPayload(t), location.origin);
  disarm();
}
function onKeyDown(ev) {
  if (ev.key !== 'Escape') return;
  window.parent.postMessage({ __dshInspectCancelled: true }, location.origin);
  disarm();
}
window.addEventListener('message', function (ev) {
  if (ev.source !== window.parent) return;
  var data = ev.data;
  if (data === null || typeof data !== 'object') return;
  if (data.__dshInspect === 'arm') {
    arm();
    window.parent.postMessage({ __dshInspectAck: true }, location.origin);
  }
  else if (data.__dshInspect === 'disarm') disarm();
});
// Install marker: lets the GUI arm a document the moment this listener exists
// (DOMContentLoaded), instead of proxying readiness via readyState.
window.__dshInspectorReady = true;
// Script-exec-time readiness announcement: unlocks the GUI toolbar and arms
// pending picks long before the full load event, which media preloading can hold for seconds.
try { window.parent.postMessage({ __dshInspectReady: true }, location.origin); } catch (e) {}
})()`;
/**
* Insert the inspector before the last `</body>` (after the nav helper,
* which lands in `<head>`); appended at the end when the document has no
* body close. The last one, because an earlier `</body>` can sit inside an
* inline script's string data, where the injected tag would cut the script.
*/
function injectInspector(html) {
	const tag = `<script>${INSPECTOR_JS}<\/script>`;
	const bodyClose = /<\/body\s*>/giu;
	let at = -1;
	for (let match = bodyClose.exec(html); match !== null; match = bodyClose.exec(html)) at = match.index;
	if (at === -1) return `${html}${tag}`;
	return `${html.slice(0, at)}${tag}${html.slice(at)}`;
}
//#endregion
//#region src/index.ts
const name = "dsh-loopback-bridge";
const inject = ["webServer", "connection"];
const ROUTE_PATH = "/dsh-loopback";
/** Loopback traffic is dev-server pages and asset reads; bodies stay small. */
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 15e3;
/**
* Cap on an upstream body buffered for rewriting (HTML/CSS/JS). Everything
* else streams through, so this only bounds the text the relay holds in
* memory: an endless or huge `text/html` response from any reachable host
* would otherwise grow the DSH host process until it dies.
*/
const MAX_REWRITE_BYTES = 64 * 1024 * 1024;
const METHODS = /* @__PURE__ */ new Set([
	"GET",
	"HEAD",
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
	"OPTIONS"
]);
/** Route tail: `<scheme>/<host>/<port><path+search>` — the form the client bundle emits. */
const ROUTE_TAIL_HOST = /^\/(https?)\/([^/]+)\/(\d{1,5})(\/.*)?$/u;
/** Legacy route tail: `<scheme>/<port><path+search>` (host implied 127.0.0.1). */
const ROUTE_TAIL = /^\/(https?)\/(\d{1,5})(\/.*)?$/u;
/**
* Loopback hostnames for the inline-JS absolute-literal pass — the client's
* LOOPBACK_HOSTNAME shape plus `*.localhost` dev subdomains (the client
* form only matched `localhost.<x>`; dev servers commonly route tenants
* as `<sub>.localhost`). The route itself accepts any host; this
* gate keeps the JS pass conservative so URL-builder constants on public
* sites are never rewritten.
*/
const LOOPBACK_HOST_RE = /^(?:(?:[a-z0-9-]+\.)*localhost(?:\.[a-z0-9-]+)*|127(?:\.\d{1,3}){3}|\[?::1\]?)$/iu;
const FORWARDED_REQUEST_HEADERS = [
	"accept",
	"accept-language",
	"content-type",
	"if-none-match",
	"if-modified-since",
	"range"
];
/**
* DSH's own browser-session cookies (dsh-client-connection names them
* `dsh-auth-<hash>`) must never cross to the upstream dev server: they are
* the proxy's gate credentials. Everything else in the Cookie header is
* upstream session state and travels.
*/
const DSH_COOKIE_PREFIX = "dsh-auth-";
/** Methods whose upstream request may carry a body. */
const BODY_METHODS = /* @__PURE__ */ new Set([
	"POST",
	"PUT",
	"PATCH",
	"DELETE"
]);
var RequestBodyTooLarge = class extends Error {};
function isRequestBodyTooLarge(error) {
	return error instanceof RequestBodyTooLarge;
}
/** Drain the request body up to the size cap, rejecting anything past it. */
function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			if (size > MAX_BODY_BYTES) return;
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				req.pause();
				chunks.length = 0;
				reject(new RequestBodyTooLarge());
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}
/**
* Rewrite document URLs to the proxy prefix.
*
* `<base href>` alone cannot host a proxied site: RFC 3986 resolves
* root-relative references (`/theme.css`, `/src/main.ts`) against the base's
* authority, discarding the base path, so they hit the application origin.
* Root-relative attribute values and CSS `url()` references are therefore
* rewritten to the prefix; plain relative values still resolve via `<base>`.
*/
const URL_ATTRS = /* @__PURE__ */ new Set([
	"src",
	"href",
	"poster",
	"action",
	"data-src",
	"srcset"
]);
/** `attr="value"` / `attr='value'` pairs across the whole document. */
const ATTR_RE = /\s([a-z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/giu;
/** CSS `url(...)` with a root-relative path, quoted or bare. */
const CSS_URL_RE = /url\(\s*(["']?)(\/[^"')\s]+)\1\s*\)/gu;
/**
* ES module specifiers in import/export-from positions. A root-relative
* specifier (`/@fs/...`, `/src/...`) resolves against the module's ORIGIN
* (RFC 3986), discarding the proxied path — so every import in a proxied
* module chain escapes to the application origin and 404s, killing
* hydration. String specifiers are rewritten to the prefix; template
* literals built at runtime are a documented ceiling. The opening quote
* must be unescaped: serialized payloads embed `\"` sequences whose text
* merely looks like an import, and a rewrite inside string data corrupts it.
*/
const JS_SPECIFIER_RE = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(?<!\\)(["'])\/(?!\/)/gu;
/**
* Root-relative asset URLs inside JS string literals. Dev bundlers serve
* asset imports as `const x = "/src/...mp4"` modules and CSS as JS that
* injects `<style>` text, so hydrated components assign root-relative media/font
* strings at runtime — and runtime URL resolution (property or attr)
* discards the base path like every RFC 3986 root-relative reference.
* Extension-gated so route/path comparison strings stay untouched. Quote
* handling is escape-aware: a match that opened at an escaped quote or ate
* the `\` of a closing `\"` would re-emit an unescaped quote and terminate
* the enclosing string — the whole inline script then dies as a SyntaxError.
* Embedded `\"/img.png\"` text therefore stays unrewritten; only real
* string literals are rewritten.
*/
const JS_ASSET_RE = /(?<!\\)(["'])(\/(?!\/)(?:[^"'\\]|\\.)*?\.(?:webp|png|jpe?g|gif|svg|mp4|webm|mov|woff2?|ttf|otf|mp3|wav|avif)(?:[?#][^"'\\]*)?)\1/gu;
/**
* Absolute loopback URLs inside inline script data. Server-rendered dev
* payloads embed upstream-built absolute loopback URLs — a Host-pinned
* request makes the app build them from the virtual host (e.g. a redirect
* destination of `http://<tenant>.localhost:<port>/`) — and client-side
* `location.replace(destination)` then navigates the frame off the proxy
* to a loopback a remote client cannot reach. Rewritten to the
* root-relative relay form (route + target, no origin): inline scripts run
* with the document's origin, so the value resolves against the injected
* `<base>` on every listener — the request's Host header inside the web
* app is the internal hop, not the external origin the client actually
* reached, so absolute forms would point remote clients at a dead
* loopback. Applied to inline scripts only: module chunks keep their
* literals, and the `__dshNav` wrap handles values that carry code.
*
* Escape-aware quoting (see JS_ASSET_RE): serialized payloads embed escaped
* quotes around URLs inside HTML text (devalue email previews render as
* `href=\"https://…\"`). A match opening at that escaped quote consumed the
* closing `\` and re-emitted a bare quote, terminating the enclosing string
* and killing the entire inline bootstrap — hydration died on pages whose
* data embeds loopback links. The lookbehind plus escape-aware interior
* keep such spans intact; URLs inside embedded HTML stay unrewritten (a
* remote client cannot open them, but the page stays alive).
*/
const JS_ABSOLUTE_LOOPBACK_RE = /(?<!\\)(["'])(https?:\/\/(?:[^"'\\]|\\.)+)\1/gu;
/**
* Runtime `location` navigations in served JS. Apps build loopback URLs at
* runtime — string concatenation no literal pass can reach (dev toolbars
* stack `<tenant>.` onto a configured base host) — and those
* navigations leave the proxy for a loopback only the host can reach. The
* statements are wrapped with `globalThis.__dshNav(value) ?? value` (helper
* injected per document, see `NAV_HELPER_JS`). Restricted to simple
* identifier/property-path values so the expression is not evaluated twice
* and calls with side effects stay unwrapped; the `=` lookahead rejects
* `==`/`===` comparisons. The value must also end the assigned expression
* (`JS_NAV_VALUE_END`): in `location.href = next || '/'` the wrap's `??`
* would meet `||` unparenthesized — a SyntaxError that kills the whole
* script — and in `base + '/x'` the `+` binds tighter than `??`, silently
* dropping the suffix.
*
* Component compilers emit reactive reads as calls (Svelte 5 dev output
* compiles `location.href = targetUrl` to `location.href = $.get(targetUrl)`),
* so the value alternatives accept one call layer with a single
* identifier/property-path argument (`$.get(targetUrl)`). Wrapping only the
* callee would hand the nav helper the getter function itself. The bare
* alternative rejects a following `(`/`?` so it can never match the callee
* prefix of a call — or an already-wrapped `globalThis.__dshNav?.(…)`.
*/
const JS_NAV_CALL_VALUE = String.raw`(?:[A-Za-z_$][\w$.]*)?\(\s*[A-Za-z_$][\w$.]*\s*\)`;
const JS_NAV_VALUE_END = String.raw`(?=[ \t]*(?:[;,)}\]\r\n]|$))`;
const JS_NAV_ASSIGN_RE = new RegExp(`(location\\.href\\s*=\\s*(?![=]))(${JS_NAV_CALL_VALUE}|[A-Za-z_$][\\w$.]*(?![\\w$.(?]))${JS_NAV_VALUE_END}`, "gu");
const JS_NAV_REPLACE_RE = new RegExp(`(location\\.replace\\()(${JS_NAV_CALL_VALUE}|[A-Za-z_$][\\w$.]*(?=\\)))(\\))`, "gu");
/** `<script ...>body<\/script>` blocks; type-gated below. */
const SCRIPT_BLOCK_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/giu;
/** Script types whose bodies are data, not code. */
const NON_CODE_SCRIPT_TYPES = /\btype\s*=\s*["'](?:[^"']*\/(?:ld\+)?json|importmap)["']/iu;
/**
* Relay prefix (trailing slash) for one target; the legacy hostless form
* when `host` is undefined.
*/
function relayPrefix(scheme, host, port) {
	return host === void 0 ? `${ROUTE_PATH}/${scheme}/${port}/` : `${ROUTE_PATH}/${scheme}/${host}/${port}/`;
}
/** Relay form of a parsed http(s) URL; default ports normalize (443/https, 80/http). */
function relayUrlOf(parsed) {
	const scheme = parsed.protocol === "https:" ? "https" : "http";
	const port = parsed.port === "" ? scheme === "https" ? "443" : "80" : parsed.port;
	return `${relayPrefix(scheme, parsed.hostname, port)}${parsed.pathname.slice(1)}${parsed.search}${parsed.hash}`;
}
/**
* Map an absolute http(s) URL to its relay form; null when unparseable.
* Sites that forbid embedding only render inside the presentation iframe
* through this form — the relay drops their framing headers because it
* forwards no other upstream headers.
*/
function toProxyUrl(value) {
	if (!/^https?:\/\//iu.test(value)) return null;
	let parsed;
	try {
		parsed = new URL(value);
	} catch {
		return null;
	}
	return relayUrlOf(parsed);
}
function toProxyPath(value, prefix) {
	if (value.startsWith("//")) return value;
	if (/^https?:\/\//iu.test(value)) return toProxyUrl(value) ?? value;
	if (!value.startsWith("/")) return value;
	return `${prefix}${value.slice(1)}`;
}
/**
* Rewrite each srcset candidate's URL, keeping the original separators and
* whitespace: URLs may themselves contain commas (`/w_100,h_80/a.jpg`), and
* re-spacing the split pieces would corrupt them.
*/
function rewriteSrcset(value, prefix) {
	return value.split(",").map((candidate) => {
		const parts = /^(\s*)(\S+)([\s\S]*)$/u.exec(candidate);
		if (parts === null) return candidate;
		return `${parts[1]}${toProxyPath(parts[2], prefix)}${parts[3]}`;
	}).join(",");
}
function rewriteHtml(html, prefix) {
	return injectInspector(injectBase(injectNavHelper(withUrlsOf(rewriteInlineScripts(html.replace(ATTR_RE, (match, name, dq, sq) => {
		const value = dq !== void 0 ? dq : sq;
		const attr = name.toLowerCase();
		if (value === "" || !URL_ATTRS.has(attr)) return match;
		const next = attr === "srcset" ? rewriteSrcset(value, prefix) : toProxyPath(value, prefix);
		return `${match.slice(0, match.length - value.length - 1)}${next}${match.slice(-1)}`;
	}), prefix), prefix)), prefix));
}
function rewriteCss(css, prefix) {
	return withUrlsOf(css, prefix);
}
function rewriteJs(js, prefix, loopbackLiterals = false) {
	const withNav = js.replace(JS_SPECIFIER_RE, (_match, head, quote) => `${head}${quote}${prefix}`).replace(JS_ASSET_RE, (match, quote, path) => path.startsWith(prefix) ? match : `${quote}${toProxyPath(path, prefix)}${quote}`).replace(JS_NAV_ASSIGN_RE, (_match, head, value) => `${head}globalThis.__dshNav?.(${value}) ?? ${value}`).replace(JS_NAV_REPLACE_RE, (_match, head, value, tail) => `${head}globalThis.__dshNav?.(${value}) ?? ${value}${tail}`);
	if (!loopbackLiterals) return withNav;
	return withNav.replace(JS_ABSOLUTE_LOOPBACK_RE, (match, quote, url) => {
		let parsed;
		try {
			parsed = new URL(url);
		} catch {
			return match;
		}
		if (!LOOPBACK_HOST_RE.test(parsed.hostname)) return match;
		if ((parsed.pathname === "/" || parsed.pathname === "") && parsed.search === "" && parsed.hash === "") return match;
		return `${quote}${relayUrlOf(parsed)}${quote}`;
	});
}
/**
* Rewrite a `Set-Cookie` value so the browser scopes it to this proxy
* prefix. Upstream dev cookies are host-only with `Path=/`; unscoped they
* would land on the application origin root and collide across tenants
* (every tenant host shares the proxy origin). `Domain` is dropped for the
* same reason — the cookie becomes host-only on the app origin, path-bound
* to the tenant's prefix.
*/
function rewriteSetCookie(cookie, prefix) {
	const segments = cookie.split(";");
	const rewritten = [segments[0]];
	for (const segment of segments.slice(1)) {
		const trimmed = segment.trim();
		const eq = trimmed.indexOf("=");
		const name = (eq === -1 ? trimmed : trimmed.slice(0, eq)).trim().toLowerCase();
		const value = eq === -1 ? "" : trimmed.slice(eq + 1).trim();
		if (name === "domain") continue;
		if (name === "path" && value.startsWith("/")) {
			rewritten.push(` Path=${toProxyPath(value, prefix).replace(/\/+$/, "")}`);
			continue;
		}
		rewritten.push(` ${trimmed}`);
	}
	return rewritten.join(";");
}
/**
* Rewrite a `Location` header to stay inside the proxy. Root-relative
* locations resolve against the origin (RFC 3986) and escape the prefix;
* absolute http(s) locations (the dev server rewriting to its canonical
* origin, or a public redirect like `google.com` to `www.google.com`)
* re-enter the proxy instead of dying on the framing restrictions or on
* the accessing PC's loopback. Protocol-relative locations (`//www.x/`)
* take the upstream request's scheme, as the browser would resolve them.
*/
function toProxyLocation(location, scheme, prefix) {
	if (location.startsWith("//")) return toProxyUrl(`${scheme}:${location}`) ?? location;
	if (location.startsWith("/")) return `${prefix}${location.slice(1)}`;
	return toProxyUrl(location) ?? location;
}
/**
* Inline scripts run with the document's origin, so their root-relative
* `import()` specifiers (dev-server bootstrap code) escape the prefix.
* Code scripts are rewritten; data scripts (ld+json, importmap) pass
* through untouched.
*/
function rewriteInlineScripts(html, prefix) {
	return html.replace(SCRIPT_BLOCK_RE, (match, attrs, body) => {
		if (body === "" || NON_CODE_SCRIPT_TYPES.test(attrs)) return match;
		return `<script${attrs}>${rewriteJs(body, prefix, true)}<\/script>`;
	});
}
function withUrlsOf(text, prefix) {
	return text.replace(CSS_URL_RE, (_match, quote, path) => `url(${quote}${toProxyPath(path, prefix)}${quote})`);
}
/** `<head>` open tag; the lookahead keeps `<header>` from matching. */
const HEAD_OPEN_RE = /<head(?=[\s>])[^>]*>/iu;
/** `<html>` open tag, the fallback anchor for documents without `<head>`. */
const HTML_OPEN_RE = /<html(?=[\s>])[^>]*>/iu;
/** Leading doctype, the last-resort anchor for documents without `<html>`. */
const DOCTYPE_RE = /^\s*<!doctype[^>]*>/iu;
/**
* Offset just inside `<head>` for injected tags. The head tags are
* optional in HTML, so fall back to after `<html>`, then after a leading
* doctype — anything injected ahead of the doctype would drop the document
* into quirks mode.
*/
function headInsertionPoint(html) {
	const open = HEAD_OPEN_RE.exec(html) ?? HTML_OPEN_RE.exec(html) ?? DOCTYPE_RE.exec(html);
	return open === null ? 0 : open.index + open[0].length;
}
/**
* Point the document's relative URLs at the proxy prefix. An explicit
* `<base>` wins; without it plain relative references would hit the
* application origin instead of the proxied dev server.
*/
function injectBase(html, baseHref) {
	if (/<base\s/iu.test(html)) return html;
	const at = headInsertionPoint(html);
	return `${html.slice(0, at)}<base href="${baseHref}">${html.slice(at)}`;
}
/**
* Runtime navigation helper injected into every proxied HTML document, as
* early in `<head>` as possible so module scripts running wrapped
* navigations always find it. Maps every absolute http(s) URL except the
* app origin's own to the relay form (public sites must ride the relay or
* the iframe dies on their framing restrictions), root-relative paths to
* the current prefix, and passes already-prefixed values through
* unchanged; everything else passes through. Root-relative
* `fetch`/`EventSource` inputs get the same mapping: unresolved, they
* would land on the GUI origin (the host app's `/api` namespace) instead
* of the proxied app. Protocol-relative `//host/...` values pass through
* like they do server-side (`toProxyPath`). Installs once per document:
* apps that re-execute body scripts on client navigation (Turbo, htmx)
* would otherwise stack another wrapper layer on every hop.
*/
const NAV_HELPER_JS = "(function(){try{if(globalThis.__dshNav)return;globalThis.__dshNav=function(u){try{if(typeof u!=='string'||u==='')return u;if(/^https?:\\/\\//.test(u)){var p=new URL(u);if(p.origin!==location.origin){var s=p.protocol==='https:'?'https':'http';var port=p.port===''?(s==='https'?'443':'80'):p.port;return location.origin+'/dsh-loopback/'+s+'/'+p.hostname+'/'+port+p.pathname+p.search+p.hash}var r=/^\\/dsh-loopback\\/([^/]+\\/[^/]+\\/\\d+)\\//.exec(location.pathname);if(r&&p.pathname.indexOf('/dsh-loopback/')!==0)return location.origin+'/dsh-loopback/'+r[1]+p.pathname+p.search+p.hash;return u}if(u.charAt(0)==='/'&&u.charAt(1)!=='/'){if(u.indexOf('/dsh-loopback/')===0)return u;var m=/^\\/dsh-loopback\\/([^/]+\\/[^/]+\\/\\d+)\\//.exec(location.pathname);if(m)return '/dsh-loopback/'+m[1]+'/'+u.slice(1)}return u}catch(e){return u}};var dshFetch=globalThis.fetch;if(dshFetch)globalThis.fetch=function(i,init){return typeof i==='string'?dshFetch(globalThis.__dshNav(i),init):dshFetch(i,init)};var dshEventSource=globalThis.EventSource;if(dshEventSource){var WrappedEventSource=function(u,c){return new dshEventSource(globalThis.__dshNav(u),c)};WrappedEventSource.prototype=dshEventSource.prototype;Object.setPrototypeOf(WrappedEventSource,dshEventSource);globalThis.EventSource=WrappedEventSource}var dshPush=history.pushState;history.pushState=function(st,t,u){try{if(u!==undefined&&u!==null)u=globalThis.__dshNav(String(u));return dshPush.call(history,st,t,u)}catch(e){return dshPush.call(history,st,t,u)}};var dshReplace=history.replaceState;history.replaceState=function(st,t,u){try{if(u!==undefined&&u!==null)u=globalThis.__dshNav(String(u));return dshReplace.call(history,st,t,u)}catch(e){return dshReplace.call(history,st,t,u)}};var dshSetAttr=Element.prototype.setAttribute;Element.prototype.setAttribute=function(k,v){try{var kk=String(k).toLowerCase();if(kk==='src'||kk==='action'||kk==='poster'||kk==='data-src'||(kk==='href'&&this.tagName!=='A'&&this.tagName!=='AREA')){var s=globalThis.__dshNav(String(v));if(s!==undefined&&s!==null)return dshSetAttr.call(this,k,s)}}catch(e){}return dshSetAttr.call(this,k,v)};}catch(e){}})()";
function injectNavHelper(html) {
	const at = headInsertionPoint(html);
	return `${html.slice(0, at)}<script>${NAV_HELPER_JS}<\/script>${html.slice(at)}`;
}
var UpstreamTimeout = class extends Error {};
var ResponseTooLarge = class extends Error {};
/**
* Upstream call over node:http — NOT fetch. The dsh host process runs on
* Node, whose fetch (undici) silently drops the forbidden `host` header,
* breaking host-routed dev apps; node:http sends explicit Host headers
* verbatim. Redirects are never followed (fetch's `manual` behavior).
* Resolves at response headers so the caller picks buffer-and-rewrite or
* stream-through per content type.
*/
function requestUpstream(options) {
	return new Promise((resolve, reject) => {
		const send = options.scheme === "https" ? request$1 : request;
		let timedOut = false;
		const request$2 = send({
			host: options.targetHost,
			port: options.port,
			path: options.path,
			method: options.method,
			headers: options.headers,
			...options.timeoutMs > 0 ? { timeout: options.timeoutMs } : {},
			signal: options.signal
		}, (msg) => resolve({
			msg,
			request: request$2,
			timedOut: () => timedOut
		}));
		request$2.on("timeout", () => {
			timedOut = true;
			request$2.destroy(new UpstreamTimeout("upstream timed out"));
		});
		request$2.on("error", reject);
		if (options.body !== void 0) request$2.end(options.body);
		else request$2.end();
	});
}
/** Buffer one upstream body up to `limit` bytes, rejecting anything past it. */
function readUpstreamBody(msg, limit) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		msg.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				msg.destroy(new ResponseTooLarge(`upstream body exceeds ${String(limit)} bytes`));
				return;
			}
			chunks.push(chunk);
		});
		msg.on("end", () => resolve(Buffer.concat(chunks)));
		msg.on("error", reject);
		msg.on("close", () => reject(/* @__PURE__ */ new Error("upstream closed before the body ended")));
	});
}
/**
* Text codec for a body the relay rewrites. Decoding a non-UTF-8 page as
* UTF-8 replaces every non-ASCII byte with U+FFFD, and the page then shows
* mojibake under its own (still forwarded) charset. A declared non-UTF-8
* charset, or undeclared bytes that are not valid UTF-8 (`<meta charset>`
* pages), round-trip byte-exactly through latin1 instead; every pattern the
* rewriter matches and every string it injects is ASCII.
*/
function bodyCodec(contentType, body) {
	const charset = /;\s*charset\s*=\s*"?([^";\s]+)/iu.exec(contentType ?? "")?.[1]?.toLowerCase();
	if (charset === void 0) return isUtf8(body) ? "utf-8" : "latin1";
	return charset === "utf-8" || charset === "utf8" ? "utf-8" : "latin1";
}
/** Rewriter for a relayed body of this media type; undefined streams it through. */
function rewriterFor(mediaType) {
	if (mediaType === "text/html") return rewriteHtml;
	if (mediaType === "text/css") return rewriteCss;
	if (mediaType === "text/javascript" || mediaType === "application/javascript") return (text, prefix) => rewriteJs(text, prefix);
}
/**
* The connection service's Host/Origin fence rejects `Origin: null`, which
* the presentation iframe attaches to some subresource fetches. That 403 is
* a fence artifact, not an authentication failure, so exactly that case is
* retried: the full admission (Host fence, cross-site check, and the cookie
* check under the listener's own protocol) runs again on the request minus
* its `Origin: null`, and stays authoritative. Fetch metadata must name our
* own frame (`same-origin`) or the user (`none`); a `same-site` sibling
* origin carries the SameSite=Strict session cookie too, and any foreign
* Origin stays rejected as the fence decided — otherwise every same-site
* page could post through the relay with the user's session.
*/
function admitsNullOriginFetch(connection, req) {
	if (req.headers.origin !== "null") return false;
	const site = req.headers["sec-fetch-site"];
	if (site !== void 0 && site !== "same-origin" && site !== "none") return false;
	const { origin: _nullOrigin, ...headers } = req.headers;
	return "peer" in connection.admit(Object.create(req, { headers: { value: headers } }));
}
function apply(ctx) {
	const webServer = ctx.get("webServer");
	const connection = ctx.get("connection");
	if (webServer === void 0 || connection === void 0 || typeof webServer.register !== "function" || typeof connection.admit !== "function") {
		ctx.logger.warn("[dsh-loopback-bridge] webServer or connection service unavailable; route not registered");
		return;
	}
	/** Upstream exchanges still running; dispose aborts them (hot reload, stop). */
	const inflight = /* @__PURE__ */ new Set();
	const handle = async (req, res) => {
		const admission = connection.admit(req);
		const rejection = "rejection" in admission ? admission.rejection : void 0;
		if (rejection !== void 0 && !(rejection === 403 && admitsNullOriginFetch(connection, req))) {
			res.writeHead(rejection);
			res.end(rejection === 401 ? "unauthorized" : "forbidden");
			return;
		}
		if (req.method === void 0 || !METHODS.has(req.method)) {
			res.writeHead(405);
			res.end("method not allowed");
			return;
		}
		const method = req.method;
		const tail = (req.url ?? "").slice(13);
		let parsed = ROUTE_TAIL_HOST.exec(tail);
		let host;
		if (parsed !== null) host = parsed[2];
		else parsed = ROUTE_TAIL.exec(tail);
		if (parsed === null || parsed[1] !== "https" && parsed[1] !== "http") {
			res.writeHead(404);
			res.end(`loopback route: expected ${ROUTE_PATH}/<http|https>/<host>/<port><path>`);
			return;
		}
		const scheme = parsed[1] === "https" ? "https" : "http";
		const port = Number.parseInt(parsed[2 + (host === void 0 ? 0 : 1)] ?? "", 10);
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			res.writeHead(404);
			res.end("loopback route: port out of range");
			return;
		}
		const path = parsed[3 + (host === void 0 ? 0 : 1)] ?? "/";
		let body;
		try {
			const drained = await readBody(req);
			if (BODY_METHODS.has(method)) body = drained;
		} catch (error) {
			if (isRequestBodyTooLarge(error)) {
				res.writeHead(413, { connection: "close" });
				res.end("request body too large");
				return;
			}
			res.writeHead(400);
			res.end("request body unreadable");
			return;
		}
		const headers = {};
		for (const headerName of FORWARDED_REQUEST_HEADERS) {
			const value = req.headers[headerName];
			if (typeof value === "string") headers[headerName] = value;
		}
		headers["accept-encoding"] = "identity";
		const rawCookie = req.headers.cookie;
		if (typeof rawCookie === "string") {
			const forwarded = rawCookie.split(";").map((segment) => segment.trim()).filter((segment) => segment !== "" && !segment.startsWith(DSH_COOKIE_PREFIX));
			if (forwarded.length > 0) headers.cookie = forwarded.join("; ");
		}
		if (host !== void 0) headers.host = scheme === "https" && port === 443 || scheme === "http" && port === 80 ? host : `${host}:${port}`;
		if (body !== void 0) headers["content-length"] = String(body.length);
		const targetHost = host === void 0 ? "127.0.0.1" : host.replace(/^\[(.*)\]$/u, "$1");
		const eventStream = method === "GET" && typeof req.headers.accept === "string" && req.headers.accept.includes("text/event-stream");
		const abort = new AbortController();
		inflight.add(abort);
		res.on("close", () => {
			inflight.delete(abort);
			if (!res.writableFinished) abort.abort();
		});
		let upstream;
		try {
			upstream = await requestUpstream({
				scheme,
				targetHost,
				port,
				path,
				method,
				headers,
				body,
				timeoutMs: eventStream ? 0 : UPSTREAM_TIMEOUT_MS,
				signal: abort.signal
			});
		} catch (error) {
			if (abort.signal.aborted) {
				res.destroy();
				return;
			}
			const timedOut = error instanceof UpstreamTimeout;
			res.writeHead(timedOut ? 504 : 502, { "content-type": "text/plain; charset=utf-8" });
			const reason = error instanceof Error ? error.message : "upstream request failed";
			res.end(`loopback upstream ${scheme}://${host ?? "127.0.0.1"}:${port} unavailable: ${reason}`);
			return;
		}
		const { msg } = upstream;
		const raw = msg.headers;
		const status = msg.statusCode ?? 502;
		const prefix = relayPrefix(scheme, host, port);
		const out = { "cache-control": typeof raw["cache-control"] === "string" ? raw["cache-control"] : "no-store" };
		for (const name of [
			"etag",
			"last-modified",
			"vary",
			"content-range",
			"accept-ranges"
		]) {
			const value = raw[name];
			if (typeof value === "string") out[name] = value;
		}
		const contentType = typeof raw["content-type"] === "string" ? raw["content-type"] : void 0;
		if (contentType !== void 0) out["content-type"] = contentType;
		if (typeof raw.location === "string") out.location = toProxyLocation(raw.location, scheme, prefix);
		const setCookie = raw["set-cookie"];
		if (setCookie !== void 0 && setCookie.length > 0) out["set-cookie"] = setCookie.map((cookie) => rewriteSetCookie(cookie, prefix));
		const mediaType = (contentType ?? "").split(";", 1)[0].trim().toLowerCase();
		const contentEncoding = typeof raw["content-encoding"] === "string" ? raw["content-encoding"] : void 0;
		const rewrite = status === 206 || contentEncoding !== void 0 && contentEncoding.trim().toLowerCase() !== "identity" ? void 0 : rewriterFor(mediaType);
		if (rewrite === void 0) {
			upstream.request.setTimeout(0);
			if (typeof raw["content-length"] === "string") out["content-length"] = raw["content-length"];
			if (contentEncoding !== void 0) out["content-encoding"] = contentEncoding;
			res.writeHead(status, out);
			if (mediaType === "text/event-stream") res.flushHeaders();
			pipeline(msg, res, () => {});
			return;
		}
		let buffer;
		try {
			buffer = await readUpstreamBody(msg, MAX_REWRITE_BYTES);
		} catch (error) {
			if (abort.signal.aborted) {
				res.destroy();
				return;
			}
			const timedOut = upstream.timedOut();
			res.writeHead(timedOut ? 504 : 502, { "content-type": "text/plain; charset=utf-8" });
			const reason = timedOut ? "upstream timed out" : error instanceof Error ? error.message : "upstream body failed";
			res.end(`loopback upstream ${scheme}://${host ?? "127.0.0.1"}:${port} failed: ${reason}`);
			return;
		}
		res.writeHead(status, out);
		if (buffer.length === 0) {
			res.end();
			return;
		}
		const codec = bodyCodec(contentType, buffer);
		res.end(Buffer.from(rewrite(buffer.toString(codec), prefix), codec));
	};
	ctx.effect(() => {
		const stop = webServer.register({
			kind: "prefix",
			path: ROUTE_PATH,
			handler: handle
		});
		return () => {
			if (typeof stop === "function") stop();
			for (const pending of inflight) pending.abort();
			inflight.clear();
		};
	}, "dsh-loopback-bridge: loopback proxy route");
}
//#endregion
export { INSPECTOR_JS, apply, inject, name };

//# sourceMappingURL=index.js.map