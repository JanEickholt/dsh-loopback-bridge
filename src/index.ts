/**
 * dsh-loopback-bridge: host-side loopback proxy for the right-Sidebar Browser.
 *
 * The Sidebar Browser renders typed URLs in a client-side iframe, so a
 * loopback address like `localhost:5173` resolves on the PC running the
 * browser, not on the DSH host. The bridge fetches
 * `<scheme>://<host>:<port><path+search>` host-side for
 * `/dsh-loopback/<scheme>/<host>/<port><path+search>`, forwarding the
 * original host in the Host header so host-routed dev apps (tenant
 * subdomains) resolve correctly. Public hosts ride the same route: pages
 * that forbid embedding (`X-Frame-Options`, CSP `frame-ancestors`) cannot
 * render in the iframe natively, and the relay drops those headers because
 * it forwards only content-type, location, set-cookie, cache-validator,
 * vary, and range upstream headers (plus content-length/-encoding on
 * streamed bodies).
 *
 * Origin isolation: relayed pages run arbitrary site code, so they are
 * served from the bridge's OWN listener (a separate origin: another port
 * on the GUI's bind address), never from the GUI origin. A relayed page
 * cannot read the GUI's DOM or storage, and its requests to the GUI's API
 * fail the connection service's Origin fence. The GUI-origin route
 * `/dsh-loopback/...` (gated by the connection service's `admit`) only
 * redirects into the relay origin with a short-lived signed ticket, which
 * the relay trades for its own HttpOnly session cookie (`session.ts`).
 * The relay listener authenticates every request with that cookie and a
 * fetch-metadata/Origin fence; the browser's `dsh-auth-*` gate cookies and
 * the relay's own cookie are never forwarded upstream.
 */
import type { Context } from '@deepseek-ai/cordis'
import { isUtf8 } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import type { ClientRequest, IncomingMessage, Server, ServerResponse } from 'node:http'
import { createServer as createHttpServer, request as nodeHttpRequest } from 'node:http'
import { createServer as createHttpsServer, request as nodeHttpsRequest } from 'node:https'
import { isIP } from 'node:net'
import type { Duplex } from 'node:stream'
import { pipeline } from 'node:stream'

import { injectInspector } from './inspector'
import {
  RESERVED_COOKIE_RE,
  mintSession,
  mintTicket,
  readSession,
  readTicket,
  sessionCookieName,
  SESSION_TTL_MS,
  type Session,
} from './session'

export const name = 'dsh-loopback-bridge'
export const inject = ['webServer', 'connection']

/** Exposed so the shipped bundle's inspector string can be parse-checked. */
export { INSPECTOR_JS } from './inspector'

/** Structural surface of the dsh-host-webserver service this plugin consumes. */
interface WebServerLike {
  register(entry: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): (() => void) | void
  /** Configured bind address (one concrete interface; DSH refuses wildcards). */
  readonly host?: string
  /** Listening port. */
  readonly port?: number
  /** `'https:'` when the GUI listener speaks TLS. */
  readonly protocol?: string
  /** Validated config; `tls` names the GUI listener's certificate files. */
  readonly config?: { tls?: { certFile: string; keyFile: string } }
}

/**
 * Plugin configuration (the bundle row needs none).
 * - `host`: relay bind address; defaults to the GUI's bind address. Must be
 *   one concrete address: wildcards are refused like DSH refuses them.
 * - `port`: relay port; defaults to the GUI port + 10 (falling back to an
 *   OS-assigned port when taken). A stable port keeps relayed apps'
 *   localStorage across restarts (storage is per origin, port included).
 * - `origin`: the relay origin browsers use, when they reach it through a
 *   proxy or tunnel (`https://relay.example`); default
 *   `<GUI scheme>://<GUI hostname as the browser sent it>:<port>`.
 */
export interface Config {
  host?: string
  port?: number
  origin?: string
}

/** Structural surface of the dsh-client-connection service this plugin consumes. */
interface ConnectionLike {
  admit(request: IncomingMessage): { peer: unknown } | { rejection: number }
}

const ROUTE_PATH = '/dsh-loopback'

/** Loopback traffic is dev-server pages and asset reads; bodies stay small. */
const MAX_BODY_BYTES = 5 * 1024 * 1024
const UPSTREAM_TIMEOUT_MS = 15_000

/**
 * Cap on an upstream body buffered for rewriting (HTML/CSS/JS). Everything
 * else streams through, so this only bounds the text the relay holds in
 * memory: an endless or huge `text/html` response from any reachable host
 * would otherwise grow the DSH host process until it dies.
 */
const MAX_REWRITE_BYTES = 64 * 1024 * 1024

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])

/** Route tail: `<scheme>/<host>/<port><path+search>` — the form the client bundle emits. */
const ROUTE_TAIL_HOST = /^\/(https?)\/([^/]+)\/(\d{1,5})(\/.*)?$/u

/** Legacy route tail: `<scheme>/<port><path+search>` (host implied 127.0.0.1). */
const ROUTE_TAIL = /^\/(https?)\/(\d{1,5})(\/.*)?$/u

/**
 * Loopback hostnames for the inline-JS absolute-literal pass — the client's
 * LOOPBACK_HOSTNAME shape plus `*.localhost` dev subdomains (the client
 * form only matched `localhost.<x>`; dev servers commonly route tenants
 * as `<sub>.localhost`). The route itself accepts any host; this
 * gate keeps the JS pass conservative so URL-builder constants on public
 * sites are never rewritten.
 */
const LOOPBACK_HOST_RE =
  /^(?:(?:[a-z0-9-]+\.)*localhost(?:\.[a-z0-9-]+)*|127(?:\.\d{1,3}){3}|\[?::1\]?)$/iu

const FORWARDED_REQUEST_HEADERS = [
  'accept',
  'accept-language',
  'content-type',
  'if-none-match',
  'if-modified-since',
  'range',
  'user-agent',
] as const

/** Relay port offset from the GUI port when `port` is not configured. */
const DEFAULT_PORT_OFFSET = 10

/** Ticket exchange endpoint on the relay listener (outside the route tails). */
const ENTER_PATH = `${ROUTE_PATH}/__enter`

/** Methods whose upstream request may carry a body. */
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

class RequestBodyTooLarge extends Error {}

function isRequestBodyTooLarge(error: unknown): error is RequestBodyTooLarge {
  return error instanceof RequestBodyTooLarge
}

/** Drain the request body up to the size cap, rejecting anything past it. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      if (size > MAX_BODY_BYTES) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        // Stop reading instead of destroying the request: destroying tears
        // down the socket before the handler can write its 413. The handler
        // answers with `connection: close`, which ends the socket after it.
        req.pause()
        chunks.length = 0
        reject(new RequestBodyTooLarge())
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
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
const URL_ATTRS = new Set(['src', 'href', 'poster', 'action', 'data-src', 'srcset'])

/** `attr="value"` / `attr='value'` pairs across the whole document. */
const ATTR_RE = /\s([a-z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/giu

/** CSS `url(...)` with a root-relative path, quoted or bare. */
const CSS_URL_RE = /url\(\s*(["']?)(\/[^"')\s]+)\1\s*\)/gu

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
const JS_SPECIFIER_RE = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(?<!\\)(["'])\/(?!\/)/gu

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
const JS_ASSET_RE =
  /(?<!\\)(["'])(\/(?!\/)(?:[^"'\\]|\\.)*?\.(?:webp|png|jpe?g|gif|svg|mp4|webm|mov|woff2?|ttf|otf|mp3|wav|avif)(?:[?#][^"'\\]*)?)\1/gu

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
const JS_ABSOLUTE_LOOPBACK_RE = /(?<!\\)(["'])(https?:\/\/(?:[^"'\\]|\\.)+)\1/gu

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
const JS_NAV_CALL_VALUE = String.raw`(?:[A-Za-z_$][\w$.]*)?\(\s*[A-Za-z_$][\w$.]*\s*\)`
const JS_NAV_VALUE_END = String.raw`(?=[ \t]*(?:[;,)}\]\r\n]|$))`
const JS_NAV_ASSIGN_RE = new RegExp(
  `(location\\.href\\s*=\\s*(?![=]))(${JS_NAV_CALL_VALUE}|[A-Za-z_$][\\w$.]*(?![\\w$.(?]))${JS_NAV_VALUE_END}`,
  'gu',
)
const JS_NAV_REPLACE_RE = new RegExp(
  `(location\\.replace\\()(${JS_NAV_CALL_VALUE}|[A-Za-z_$][\\w$.]*(?=\\)))(\\))`,
  'gu',
)

/** `<script ...>body</script>` blocks; type-gated below. */
const SCRIPT_BLOCK_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/giu

/** Script types whose bodies are data, not code. */
const NON_CODE_SCRIPT_TYPES = /\btype\s*=\s*["'](?:[^"']*\/(?:ld\+)?json|importmap)["']/iu

/**
 * Relay prefix (trailing slash) for one target; the legacy hostless form
 * when `host` is undefined.
 */
function relayPrefix(scheme: string, host: string | undefined, port: number | string): string {
  return host === undefined ? `${ROUTE_PATH}/${scheme}/${port}/` : `${ROUTE_PATH}/${scheme}/${host}/${port}/`
}

/** Relay form of a parsed http(s) URL; default ports normalize (443/https, 80/http). */
function relayUrlOf(parsed: URL): string {
  const scheme = parsed.protocol === 'https:' ? 'https' : 'http'
  const port = parsed.port === '' ? (scheme === 'https' ? '443' : '80') : parsed.port
  return `${relayPrefix(scheme, parsed.hostname, port)}${parsed.pathname.slice(1)}${parsed.search}${parsed.hash}`
}

/**
 * Map an absolute http(s) URL to its relay form; null when unparseable.
 * Sites that forbid embedding only render inside the presentation iframe
 * through this form — the relay drops their framing headers because it
 * forwards no other upstream headers.
 */
function toProxyUrl(value: string): string | null {
  if (!/^https?:\/\//iu.test(value)) return null
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  return relayUrlOf(parsed)
}

function toProxyPath(value: string, prefix: string): string {
  if (value.startsWith('//')) return value
  if (/^https?:\/\//iu.test(value)) return toProxyUrl(value) ?? value
  if (!value.startsWith('/')) return value
  return `${prefix}${value.slice(1)}`
}

/**
 * Rewrite each srcset candidate's URL, keeping the original separators and
 * whitespace: URLs may themselves contain commas (`/w_100,h_80/a.jpg`), and
 * re-spacing the split pieces would corrupt them.
 */
function rewriteSrcset(value: string, prefix: string): string {
  return value
    .split(',')
    .map((candidate) => {
      const parts = /^(\s*)(\S+)([\s\S]*)$/u.exec(candidate)
      if (parts === null) return candidate
      return `${parts[1]}${toProxyPath(parts[2], prefix)}${parts[3]}`
    })
    .join(',')
}

function rewriteHtml(html: string, prefix: string, parentOrigin: string): string {
  const withAttrs = html.replace(ATTR_RE, (match, name: string, dq: string, sq: string) => {
    // A matched empty `src=""` leaves the single-quote capture undefined;
    // pick by which alternative fired or empty-URL attrs crash rewrites.
    const value = dq !== undefined ? dq : sq
    // Attribute names are case-insensitive (`<IMG SRC=...>`).
    const attr = name.toLowerCase()
    if (value === '' || !URL_ATTRS.has(attr)) return match
    const next = attr === 'srcset' ? rewriteSrcset(value, prefix) : toProxyPath(value, prefix)
    // The match ends `<quote><value><quote>`: swap only the value so the
    // original name spelling and spacing survive.
    return `${match.slice(0, match.length - value.length - 1)}${next}${match.slice(-1)}`
  })
  const withScripts = rewriteInlineScripts(withAttrs, prefix)
  const withUrls = withUrlsOf(withScripts, prefix)
  // Inspector last: its source must never anchor the head-tag lookups.
  return injectInspector(injectBase(injectNavHelper(withUrls, parentOrigin), prefix))
}

function rewriteCss(css: string, prefix: string): string {
  return withUrlsOf(css, prefix)
}

function rewriteJs(js: string, prefix: string, loopbackLiterals = false): string {
  const withSpecifiers = js.replace(
    JS_SPECIFIER_RE,
    (_match, head: string, quote: string) => `${head}${quote}${prefix}`,
  )
  const withAssets = withSpecifiers.replace(
    JS_ASSET_RE,
    (match, quote: string, path: string) =>
      path.startsWith(prefix) ? match : `${quote}${toProxyPath(path, prefix)}${quote}`,
  )
  const withNav = withAssets
    .replace(
      JS_NAV_ASSIGN_RE,
      (_match, head: string, value: string) => `${head}globalThis.__dshNav?.(${value}) ?? ${value}`,
    )
    .replace(
      JS_NAV_REPLACE_RE,
      (_match, head: string, value: string, tail: string) =>
        `${head}globalThis.__dshNav?.(${value}) ?? ${value}${tail}`,
    )
  if (!loopbackLiterals) return withNav
  return withNav.replace(JS_ABSOLUTE_LOOPBACK_RE, (match, quote: string, url: string) => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return match
    }
    if (!LOOPBACK_HOST_RE.test(parsed.hostname)) return match
    // Origin-only constants are URL-builder inputs, not navigation targets:
    // dev toolbars do `new URL(baseOrigin)` and stack subdomains onto
    // `base.host`, so rewriting the origin breaks the builder. Runtime
    // navigations built from such constants are caught by the `__dshNav`
    // wrap instead.
    if ((parsed.pathname === '/' || parsed.pathname === '') && parsed.search === '' && parsed.hash === '') {
      return match
    }
    return `${quote}${relayUrlOf(parsed)}${quote}`
  })
}

/**
 * Rewrite a `Set-Cookie` value so the browser scopes it to this proxy
 * prefix. Upstream dev cookies are host-only with `Path=/`; unscoped they
 * would land on the application origin root and collide across tenants
 * (every tenant host shares the proxy origin). `Domain` is dropped for the
 * same reason — the cookie becomes host-only on the app origin, path-bound
 * to the tenant's prefix.
 */
function rewriteSetCookie(cookie: string, prefix: string): string {
  const segments = cookie.split(';')
  const rewritten = [segments[0]]
  for (const segment of segments.slice(1)) {
    const trimmed = segment.trim()
    const eq = trimmed.indexOf('=')
    // Attribute names and values may be padded (`Path = /app`).
    const name = (eq === -1 ? trimmed : trimmed.slice(0, eq)).trim().toLowerCase()
    const value = eq === -1 ? '' : trimmed.slice(eq + 1).trim()
    if (name === 'domain') continue
    if (name === 'path' && value.startsWith('/')) {
      rewritten.push(` Path=${toProxyPath(value, prefix).replace(/\/+$/, '')}`)
      continue
    }
    rewritten.push(` ${trimmed}`)
  }
  return rewritten.join(';')
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
function toProxyLocation(location: string, scheme: string, prefix: string): string {
  if (location.startsWith('//')) return toProxyUrl(`${scheme}:${location}`) ?? location
  if (location.startsWith('/')) return `${prefix}${location.slice(1)}`
  return toProxyUrl(location) ?? location
}

/**
 * Inline scripts run with the document's origin, so their root-relative
 * `import()` specifiers (dev-server bootstrap code) escape the prefix.
 * Code scripts are rewritten; data scripts (ld+json, importmap) pass
 * through untouched.
 */
function rewriteInlineScripts(html: string, prefix: string): string {
  return html.replace(SCRIPT_BLOCK_RE, (match, attrs: string, body: string) => {
    if (body === '' || NON_CODE_SCRIPT_TYPES.test(attrs)) return match
    return `<script${attrs}>${rewriteJs(body, prefix, true)}</script>`
  })
}

function withUrlsOf(text: string, prefix: string): string {
  return text.replace(
    CSS_URL_RE,
    (_match, quote: string, path: string) => `url(${quote}${toProxyPath(path, prefix)}${quote})`,
  )
}

/** `<head>` open tag; the lookahead keeps `<header>` from matching. */
const HEAD_OPEN_RE = /<head(?=[\s>])[^>]*>/iu

/** `<html>` open tag, the fallback anchor for documents without `<head>`. */
const HTML_OPEN_RE = /<html(?=[\s>])[^>]*>/iu

/** Leading doctype, the last-resort anchor for documents without `<html>`. */
const DOCTYPE_RE = /^\s*<!doctype[^>]*>/iu

/**
 * Offset just inside `<head>` for injected tags. The head tags are
 * optional in HTML, so fall back to after `<html>`, then after a leading
 * doctype — anything injected ahead of the doctype would drop the document
 * into quirks mode.
 */
function headInsertionPoint(html: string): number {
  const open = HEAD_OPEN_RE.exec(html) ?? HTML_OPEN_RE.exec(html) ?? DOCTYPE_RE.exec(html)
  return open === null ? 0 : open.index + open[0].length
}

/**
 * Point the document's relative URLs at the proxy prefix. An explicit
 * `<base>` wins; without it plain relative references would hit the
 * application origin instead of the proxied dev server.
 */
function injectBase(html: string, baseHref: string): string {
  if (/<base\s/iu.test(html)) return html
  const at = headInsertionPoint(html)
  return `${html.slice(0, at)}<base href="${baseHref}">${html.slice(at)}`
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
 *
 * The frame is cross-origin to the GUI, which therefore cannot read its
 * address: history changes (push/replace, popstate, hashchange) post
 * `{__dshRelayAddress: href}` to the GUI origin (`__dshParentOrigin`,
 * injected per document). `WebSocket` URLs map through the relay like
 * `fetch` inputs (ws/wss ride the http/https relay form, so dev-server HMR
 * sockets reach the host), and `document.cookie` writes get the same
 * scoping as upstream `Set-Cookie`: `Path` moves under the target's
 * prefix, `Domain` is dropped, and the relay's reserved names are refused
 * — a `path=/` cookie would otherwise ride every relayed target's
 * requests, public sites included. The cookie wrapper keeps honest apps
 * scoped; it is no boundary against a hostile page.
 */
const NAV_HELPER_JS =
  '(function(){try{' +
  'if(globalThis.__dshNav)return;' +
  'globalThis.__dshNav=function(u){try{' +
  "if(typeof u!=='string'||u==='')return u;" +
  "if(/^https?:\\/\\//.test(u)){var p=new URL(u);" +
  "if(p.origin!==location.origin){" +
  "var s=p.protocol==='https:'?'https':'http';" +
  "var port=p.port===''?(s==='https'?'443':'80'):p.port;" +
  "return location.origin+'/dsh-loopback/'+s+'/'+p.hostname+'/'+port+p.pathname+p.search+p.hash}" +
  // App-origin absolute URLs inside a relayed frame are escaped requests
  // (framework routers resolve root-relative links at the GUI origin, and
  // this helper only ever runs inside relayed documents) — fold them back
  // under the current relay prefix instead of passing them through.
  "var r=/^\\/dsh-loopback\\/([^/]+\\/[^/]+\\/\\d+)\\//.exec(location.pathname);" +
  "if(r&&p.pathname.indexOf('/dsh-loopback/')!==0)" +
  "return location.origin+'/dsh-loopback/'+r[1]+p.pathname+p.search+p.hash;" +
  'return u}' +
  "if(u.charAt(0)==='/'&&u.charAt(1)!=='/'){if(u.indexOf('/dsh-loopback/')===0)return u;" +
  "var m=/^\\/dsh-loopback\\/([^/]+\\/[^/]+\\/\\d+)\\//.exec(location.pathname);" +
  "if(m)return '/dsh-loopback/'+m[1]+'/'+u.slice(1)}" +
  'return u}catch(e){return u}};' +
  'var dshFetch=globalThis.fetch;' +
  "if(dshFetch)globalThis.fetch=function(i,init){" +
  "return typeof i==='string'?dshFetch(globalThis.__dshNav(i),init):dshFetch(i,init)};" +
  'var dshEventSource=globalThis.EventSource;' +
  "if(dshEventSource){var WrappedEventSource=function(u,c){" +
  "return new dshEventSource(globalThis.__dshNav(u),c)};" +
  'WrappedEventSource.prototype=dshEventSource.prototype;' +
  // Inherit the statics (`EventSource.OPEN`/`CLOSED`) readyState checks use.
  'Object.setPrototypeOf(WrappedEventSource,dshEventSource);' +
  'globalThis.EventSource=WrappedEventSource}' +
  // Framework routers push same-origin URLs that lack the relay prefix
  // (root-relative links resolve at the origin); rewrite them so the
  // frame address stays inside the relay and reload/back/forward work.
  'var dshAddr=function(){try{' +
  "if(window.parent!==window&&typeof globalThis.__dshParentOrigin==='string')" +
  'window.parent.postMessage({__dshRelayAddress:location.href},globalThis.__dshParentOrigin)}catch(e){}};' +
  "addEventListener('popstate',dshAddr);addEventListener('hashchange',dshAddr);" +
  'var dshPush=history.pushState;' +
  'history.pushState=function(st,t,u){try{' +
  'if(u!==undefined&&u!==null)u=globalThis.__dshNav(String(u))}catch(e){}' +
  'var x=dshPush.call(history,st,t,u);dshAddr();return x};' +
  'var dshReplace=history.replaceState;' +
  'history.replaceState=function(st,t,u){try{' +
  'if(u!==undefined&&u!==null)u=globalThis.__dshNav(String(u))}catch(e){}' +
  'var x=dshReplace.call(history,st,t,u);dshAddr();return x};' +
  // ws(s) URLs take the http(s) relay mapping, then return to ws(s) on the
  // relay origin; relative inputs resolve against the document first.
  'var dshWS=globalThis.WebSocket;' +
  'if(dshWS){var WrappedWebSocket=function(u,p){try{' +
  "var su=String(u),sm=/^(wss?):\\/\\//i.exec(su);" +
  "var hu=sm?(sm[1].toLowerCase()==='wss'?'https':'http')+su.slice(sm[1].length):su;" +
  'var ru=globalThis.__dshNav(hu);' +
  "if(ru!==hu){var a=new URL(ru,location.href);u=(a.protocol==='https:'?'wss:':'ws:')+'//'+a.host+a.pathname+a.search}" +
  '}catch(e){}' +
  'return p===undefined?new dshWS(u):new dshWS(u,p)};' +
  'WrappedWebSocket.prototype=dshWS.prototype;' +
  'Object.setPrototypeOf(WrappedWebSocket,dshWS);' +
  'globalThis.WebSocket=WrappedWebSocket}' +
  "var dshCookie=Object.getOwnPropertyDescriptor(Document.prototype,'cookie');" +
  "var cm=/^(\\/dsh-loopback\\/[^/]+\\/[^/]+\\/\\d+)\\//.exec(location.pathname);" +
  'if(dshCookie&&dshCookie.set&&cm){' +
  "Object.defineProperty(Document.prototype,'cookie',{configurable:true,enumerable:dshCookie.enumerable," +
  'get:function(){return dshCookie.get.call(this)},' +
  'set:function(v){try{' +
  "var parts=String(v).split(';'),nm=parts[0].split('=')[0].trim();" +
  'if(/^dsh-(?:auth|relay)-/i.test(nm))return;' +
  'var out=[parts[0]];' +
  'for(var i=1;i<parts.length;i++){var at=parts[i].trim(),eq=at.indexOf(\'=\');' +
  "var k=(eq===-1?at:at.slice(0,eq)).trim().toLowerCase();" +
  "if(k==='domain')continue;" +
  "if(k==='path'){var pv=eq===-1?'':at.slice(eq+1).trim();" +
  "if(pv.charAt(0)==='/'&&pv.indexOf('/dsh-loopback/')!==0){out.push('Path='+(cm[1]+pv).replace(/\\/+$/,''));continue}}" +
  'out.push(at)}' +
  "v=out.join('; ')}catch(e){}" +
  'dshCookie.set.call(this,v)}})}' +
  // Client-side renders re-set resource attributes at runtime — the
  // hydrated root layout rewrites <link href="/theme.css…"> on the first
  // router hop, and root-relative resolves at the GUI origin, so the
  // tenant palette 404s. Anchor hrefs stay unwrapped on purpose: the
  // router needs the app-relative value to keep doing client-side hops.
  'var dshSetAttr=Element.prototype.setAttribute;' +
  'Element.prototype.setAttribute=function(k,v){try{' +
  "var kk=String(k).toLowerCase();" +
  "if(kk==='src'||kk==='action'||kk==='poster'||kk==='data-src'" +
  "||(kk==='href'&&this.tagName!=='A'&&this.tagName!=='AREA')){" +
  'var s=globalThis.__dshNav(String(v));' +
  'if(s!==undefined&&s!==null)return dshSetAttr.call(this,k,s)}}catch(e){}' +
  'return dshSetAttr.call(this,k,v)};' +
  '}catch(e){}})()'

/**
 * @param parentOrigin - GUI origin of this relay session: the only target
 *   of the frame's postMessage traffic and the only origin it accepts
 *   inspector commands from.
 */
function injectNavHelper(html: string, parentOrigin: string): string {
  const at = headInsertionPoint(html)
  const origin = JSON.stringify(parentOrigin).replaceAll('<', '\\u003c')
  return `${html.slice(0, at)}<script>globalThis.__dshParentOrigin=${origin};${NAV_HELPER_JS}</script>${html.slice(at)}`
}

class UpstreamTimeout extends Error {}

class ResponseTooLarge extends Error {}

/** Upstream target of one relayed request. */
interface UpstreamTarget {
  scheme: 'http' | 'https'
  /** Connect host: IPv6 literals unbracketed, as node:net expects them. */
  targetHost: string
  port: number
  path: string
  method: string
  headers: Record<string, string>
}

/** Upstream response at header time; the body is still unread on `msg`. */
interface Upstream {
  msg: IncomingMessage
  request: ClientRequest
  /** Whether the idle timeout (not a peer error) ended the exchange. */
  timedOut(): boolean
}

/**
 * Upstream call over node:http — NOT fetch. The dsh host process runs on
 * Node, whose fetch (undici) silently drops the forbidden `host` header,
 * breaking host-routed dev apps; node:http sends explicit Host headers
 * verbatim. Redirects are never followed (fetch's `manual` behavior).
 * Resolves at response headers so the caller picks buffer-and-rewrite or
 * stream-through per content type.
 */
function requestUpstream(
  options: UpstreamTarget & {
    body: Buffer | undefined
    /** Socket idle timeout; 0 disables it (event streams idle by design). */
    timeoutMs: number
    /** Aborts the upstream request (client went away, plugin disposed). */
    signal: AbortSignal
  },
): Promise<Upstream> {
  return new Promise((resolve, reject) => {
    const send = options.scheme === 'https' ? nodeHttpsRequest : nodeHttpRequest
    let timedOut = false
    const request = send(
      {
        host: options.targetHost,
        port: options.port,
        path: options.path,
        method: options.method,
        headers: options.headers,
        // The option form also bounds the connect; `setTimeout` would not.
        ...(options.timeoutMs > 0 ? { timeout: options.timeoutMs } : {}),
        signal: options.signal,
      },
      (msg: IncomingMessage) => resolve({ msg, request, timedOut: () => timedOut }),
    )
    request.on('timeout', () => {
      timedOut = true
      request.destroy(new UpstreamTimeout('upstream timed out'))
    })
    request.on('error', reject)
    if (options.body !== undefined) request.end(options.body)
    else request.end()
  })
}

/** Buffer one upstream body up to `limit` bytes, rejecting anything past it. */
function readUpstreamBody(msg: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    msg.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        msg.destroy(new ResponseTooLarge(`upstream body exceeds ${String(limit)} bytes`))
        return
      }
      chunks.push(chunk)
    })
    msg.on('end', () => resolve(Buffer.concat(chunks)))
    msg.on('error', reject)
    msg.on('close', () => reject(new Error('upstream closed before the body ended')))
  })
}

/**
 * Text codec for a body the relay rewrites. Decoding a non-UTF-8 page as
 * UTF-8 replaces every non-ASCII byte with U+FFFD, and the page then shows
 * mojibake under its own (still forwarded) charset. A declared non-UTF-8
 * charset, or undeclared bytes that are not valid UTF-8 (`<meta charset>`
 * pages), round-trip byte-exactly through latin1 instead; every pattern the
 * rewriter matches and every string it injects is ASCII.
 */
function bodyCodec(contentType: string | undefined, body: Buffer): 'utf-8' | 'latin1' {
  const charset = /;\s*charset\s*=\s*"?([^";\s]+)/iu.exec(contentType ?? '')?.[1]?.toLowerCase()
  if (charset === undefined) return isUtf8(body) ? 'utf-8' : 'latin1'
  return charset === 'utf-8' || charset === 'utf8' ? 'utf-8' : 'latin1'
}

type Rewriter = (text: string, prefix: string, parentOrigin: string) => string

/** Rewriter for a relayed body of this media type; undefined streams it through. */
function rewriterFor(mediaType: string): Rewriter | undefined {
  if (mediaType === 'text/html') return rewriteHtml
  if (mediaType === 'text/css') return (text, prefix) => rewriteCss(text, prefix)
  if (mediaType === 'text/javascript' || mediaType === 'application/javascript') {
    return (text, prefix) => rewriteJs(text, prefix)
  }
  return undefined
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
function admitsNullOriginFetch(connection: ConnectionLike, req: IncomingMessage): boolean {
  if (req.headers.origin !== 'null') return false
  const site = req.headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false
  const { origin: _nullOrigin, ...headers } = req.headers
  const retry = connection.admit(Object.create(req, { headers: { value: headers } }) as IncomingMessage)
  return 'peer' in retry
}

/** One parsed relay target. */
interface RouteTarget {
  scheme: 'http' | 'https'
  /** Route host (IPv6 bracketed); undefined for the legacy hostless form. */
  host: string | undefined
  port: number
  /** Upstream path plus search. */
  path: string
}

/**
 * Parse a request target the way the web server matched it: WHATWG-normalized
 * pathname (dot segments resolved, absolute-form targets reduced to their
 * path) plus the raw search. Slicing raw `req.url` let `/a/../dsh-loopback/…`
 * route here and then fail, and kept dot segments the matcher had resolved.
 * @returns the target, `undefined` when the path is no relay route, or an
 *   error message for a malformed tail.
 */
function parseRoute(rawUrl: string | undefined): RouteTarget | string | undefined {
  let url: URL
  try {
    url = new URL(rawUrl ?? '/', 'http://x')
  } catch {
    return undefined
  }
  if (!url.pathname.startsWith(`${ROUTE_PATH}/`)) return undefined
  const tail = `${url.pathname.slice(ROUTE_PATH.length)}${url.search}`
  let parsed = ROUTE_TAIL_HOST.exec(tail)
  let host: string | undefined
  if (parsed !== null) {
    host = parsed[2]
  } else {
    parsed = ROUTE_TAIL.exec(tail)
  }
  if (parsed === null || (parsed[1] !== 'https' && parsed[1] !== 'http')) {
    return `loopback route: expected ${ROUTE_PATH}/<http|https>/<host>/<port><path>`
  }
  const port = Number.parseInt(parsed[2 + (host === undefined ? 0 : 1)] ?? '', 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'loopback route: port out of range'
  return {
    scheme: parsed[1] === 'https' ? 'https' : 'http',
    host,
    port,
    path: parsed[3 + (host === undefined ? 0 : 1)] ?? '/',
  }
}

/** Upstream authority as browsers spell it: scheme-default ports dropped. */
function upstreamAuthority(target: RouteTarget): string {
  const host = target.host ?? '127.0.0.1'
  const defaultPort =
    (target.scheme === 'https' && target.port === 443) || (target.scheme === 'http' && target.port === 80)
  return defaultPort ? host : `${host}:${String(target.port)}`
}

/** Target URL of a relay URL on `ownOrigin`; undefined for anything else. */
function targetUrlOf(value: string, ownOrigin: string): string | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.origin !== ownOrigin) return undefined
  const target = parseRoute(`${url.pathname}${url.search}`)
  if (target === undefined || typeof target === 'string') return undefined
  return `${target.scheme}://${upstreamAuthority(target)}${target.path}`
}

/** Origin a request addressed (its Host under the listener's protocol). */
function requestOrigin(req: IncomingMessage, protocol: string): string | undefined {
  const host = req.headers.host
  if (host === undefined) return undefined
  try {
    return new URL(`${protocol}//${host}`).origin
  } catch {
    return undefined
  }
}

/**
 * Fetch-metadata/Origin fence of the relay listener. The relay session
 * cookie is host-scoped, so pages on every other port of the same host
 * (same-site) carry it as well: those may only navigate (the GUI's
 * redirect into the relay is a same-site navigation), never fetch or post.
 * @returns a rejection status, or undefined to admit.
 */
function relayFence(req: IncomingMessage, ownOrigin: string): number | undefined {
  const site = req.headers['sec-fetch-site']
  if (site === 'cross-site') return 403
  const origin = req.headers.origin
  if (origin !== undefined && origin !== ownOrigin) {
    // `Origin: null` from our own documents (no-referrer policy, opaque
    // redirects) stays admissible when fetch metadata says same-origin.
    if (!(origin === 'null' && (site === undefined || site === 'same-origin'))) return 403
  }
  if (site === 'same-site') {
    const navigate = req.headers['sec-fetch-mode'] === 'navigate'
    if (!navigate || (req.method !== 'GET' && req.method !== 'HEAD')) return 403
  }
  return undefined
}

/** Cookie header minus the relay's reserved names (gate and relay sessions). */
function forwardedCookies(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const kept = raw
    .split(';')
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '' && !RESERVED_COOKIE_RE.test(segment.split('=', 1)[0].trim()))
  return kept.length > 0 ? kept.join('; ') : undefined
}

/** Whether a bind literal names every interface at once (`0.0.0.0`, `::`). */
function isWildcardAddress(host: string): boolean {
  if (isIP(host) === 4) return host.split('.').every((part) => Number(part) === 0)
  return /^[0:]+$/u.test(host.replace(/^::ffff:/iu, '').replace(/%.*$/u, '')) || /^::ffff:0\.0\.0\.0$/iu.test(host)
}

function listenOn(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function plainResponse(res: ServerResponse, status: number, text: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...extra })
  res.end(text)
}

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const webServer = ctx.get('webServer') as WebServerLike | undefined
  const connection = ctx.get('connection') as ConnectionLike | undefined
  if (
    webServer === undefined ||
    connection === undefined ||
    typeof webServer.register !== 'function' ||
    typeof connection.admit !== 'function'
  ) {
    ctx.logger.warn('[dsh-loopback-bridge] webServer or connection service unavailable; route not registered')
    return
  }
  const options = config ?? {}

  const relayHost = options.host ?? webServer.host ?? '127.0.0.1'
  if (isIP(relayHost) === 0 || isWildcardAddress(relayHost)) {
    throw new Error(
      `[dsh-loopback-bridge] relay host ${JSON.stringify(relayHost)} must be one concrete IP address (wildcards would expose the relay on every interface)`,
    )
  }
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)) {
    throw new Error(`[dsh-loopback-bridge] relay port ${String(options.port)} is out of range`)
  }
  if (options.origin !== undefined) {
    let parsed: URL | undefined
    try {
      parsed = new URL(options.origin)
    } catch {
      parsed = undefined
    }
    if (parsed === undefined || parsed.origin !== options.origin || !/^https?:$/u.test(parsed.protocol)) {
      throw new Error(`[dsh-loopback-bridge] relay origin ${JSON.stringify(options.origin)} is not a bare http(s) origin`)
    }
  }
  const protocol = webServer.protocol === 'https:' ? 'https:' : 'http:'

  /** Upstream exchanges still running; dispose aborts them (hot reload, stop). */
  const inflight = new Set<AbortController>()
  /** Relayed WebSocket pairs; dispose destroys them. */
  const tunnels = new Set<Duplex>()
  let relayPort: number | undefined

  /** Origin browsers reach the relay at, for a GUI request with this Host. */
  const relayOriginFor = (req: IncomingMessage): string | undefined => {
    if (options.origin !== undefined) return options.origin
    if (relayPort === undefined) return undefined
    const gui = requestOrigin(req, protocol)
    if (gui === undefined) return undefined
    return `${protocol}//${new URL(gui).hostname}:${String(relayPort)}`
  }

  /**
   * GUI-origin entry: admitted by the connection service, it serves no
   * upstream content (that would run on the GUI origin again) and only
   * redirects into the relay origin with a one-hop ticket.
   */
  const enterFromGui = (req: IncomingMessage, res: ServerResponse): void => {
    const admission = connection.admit(req)
    const rejection = 'rejection' in admission ? admission.rejection : undefined
    if (rejection !== undefined && !(rejection === 403 && admitsNullOriginFetch(connection, req))) {
      res.writeHead(rejection)
      res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      plainResponse(res, 405, 'loopback route: the GUI origin only redirects into the relay origin', { allow: 'GET, HEAD' })
      return
    }
    const target = parseRoute(req.url)
    if (target === undefined || typeof target === 'string') {
      plainResponse(res, 404, target ?? 'loopback route: not found')
      return
    }
    const gui = requestOrigin(req, protocol)
    const relayOrigin = relayOriginFor(req)
    if (gui === undefined || relayOrigin === undefined) {
      plainResponse(res, 503, 'loopback relay listener is not ready')
      return
    }
    const url = new URL(req.url ?? '/', 'http://x')
    const ticket = mintTicket({ to: `${url.pathname}${url.search}`, gui })
    res.writeHead(302, {
      location: `${relayOrigin}${ENTER_PATH}?t=${encodeURIComponent(ticket)}`,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    })
    res.end()
  }

  /** Relay-origin ticket exchange: sets the relay session, then opens the target. */
  const enterRelay = (req: IncomingMessage, res: ServerResponse, url: URL): void => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      plainResponse(res, 405, 'method not allowed', { allow: 'GET, HEAD' })
      return
    }
    const ticket = readTicket(url.searchParams.get('t') ?? '')
    if (ticket === undefined || !ticket.to.startsWith(`${ROUTE_PATH}/`) || relayPort === undefined) {
      plainResponse(res, 401, 'loopback relay: ticket missing or expired; reload the Browser tab')
      return
    }
    const attributes = [
      `${sessionCookieName(relayPort)}=${mintSession({ gui: ticket.gui })}`,
      `Path=${ROUTE_PATH}`,
      `Max-Age=${String(Math.floor(SESSION_TTL_MS / 1000))}`,
      'HttpOnly',
      'SameSite=Strict',
    ]
    if (protocol === 'https:') attributes.push('Secure')
    res.writeHead(302, {
      location: ticket.to,
      'set-cookie': attributes.join('; '),
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    })
    res.end()
  }

  /** Authenticated relay session of a relay-listener request, if any. */
  const sessionOf = (req: IncomingMessage): Session | undefined =>
    relayPort === undefined ? undefined : readSession(req.headers.cookie, sessionCookieName(relayPort))

  const relay = async (
    req: IncomingMessage,
    res: ServerResponse,
    target: RouteTarget,
    session: Session,
    ownOrigin: string,
  ): Promise<void> => {
    if (req.method === undefined || !METHODS.has(req.method)) {
      plainResponse(res, 405, 'method not allowed')
      return
    }
    const method = req.method
    const { scheme, host, port, path } = target

    let body: Buffer | undefined
    try {
      const drained = await readBody(req)
      if (BODY_METHODS.has(method)) body = drained
    } catch (error) {
      if (isRequestBodyTooLarge(error)) {
        // The unread rest of the body stays on the socket; close it after
        // the response instead of reusing the connection.
        res.writeHead(413, { connection: 'close' })
        res.end('request body too large')
        return
      }
      res.writeHead(400)
      res.end('request body unreadable')
      return
    }

    const headers: Record<string, string> = {}
    for (const headerName of FORWARDED_REQUEST_HEADERS) {
      const value = req.headers[headerName]
      if (typeof value === 'string') headers[headerName] = value
    }
    // Ask for identity bodies: with no Accept-Encoding a server may pick any
    // coding (RFC 9110), and the rewriter needs plain text.
    headers['accept-encoding'] = 'identity'
    // Upstream session cookies travel; the gate's `dsh-auth-*` and the
    // relay's own `dsh-relay-*` cookies never do.
    const cookie = forwardedCookies(req.headers.cookie)
    if (cookie !== undefined) headers.cookie = cookie
    // Host-routed dev apps (tenant subdomains) resolve the tenant from the
    // Host header — sent verbatim by node:http (undici's fetch drops it).
    // Default ports drop the suffix so public upstreams see the browser form.
    const authority = upstreamAuthority(target)
    if (host !== undefined) headers.host = authority
    // Origin and Referer as the upstream would see them without the relay:
    // CSRF checks (SvelteKit form actions compare Origin to the request's
    // own origin) pass for the app's own pages, and relay URLs never leak.
    const origin = req.headers.origin
    if (origin === ownOrigin) headers.origin = `${scheme}://${authority}`
    else if (origin === 'null') headers.origin = 'null'
    const referer = typeof req.headers.referer === 'string' ? targetUrlOf(req.headers.referer, ownOrigin) : undefined
    if (referer !== undefined) headers.referer = referer
    if (body !== undefined) headers['content-length'] = String(body.length)
    // The route carries IPv6 literals bracketed (`[::1]`, the URL hostname
    // form, also what the Host header wants); node:net resolves the bracketed
    // form as a DNS name and fails with ENOTFOUND.
    const targetHost = host === undefined ? '127.0.0.1' : host.replace(/^\[(.*)\]$/u, '$1')

    // `text/event-stream` feeds idle between events by design: no idle
    // timeout, not even while waiting for the response headers.
    const eventStream =
      method === 'GET' &&
      typeof req.headers.accept === 'string' &&
      req.headers.accept.includes('text/event-stream')

    // A client that goes away (tab navigated, frame closed) aborts the
    // upstream call instead of leaving it to buffer a response nobody reads.
    const abort = new AbortController()
    inflight.add(abort)
    res.on('close', () => {
      inflight.delete(abort)
      if (!res.writableFinished) abort.abort()
    })
    let upstream: Upstream
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
        signal: abort.signal,
      })
    } catch (error) {
      if (abort.signal.aborted) {
        res.destroy()
        return
      }
      const timedOut = error instanceof UpstreamTimeout
      res.writeHead(timedOut ? 504 : 502, { 'content-type': 'text/plain; charset=utf-8' })
      const reason = error instanceof Error ? error.message : 'upstream request failed'
      res.end(`loopback upstream ${scheme}://${host ?? '127.0.0.1'}:${port} unavailable: ${reason}`)
      return
    }

    const { msg } = upstream
    const raw = msg.headers
    const status = msg.statusCode ?? 502
    const prefix = relayPrefix(scheme, host, port)
    // Upstream cache validators pass through so warm tab loads revalidate
    // (304) instead of re-downloading the whole dev-server module graph.
    // The browser caches what this proxy served under the relay URL — for
    // rewritten HTML that is the rewritten copy, so a 304 makes the browser
    // reuse exactly that. `no-store` only when upstream sends no policy;
    // `vary` keeps content-negotiated variants (Vite serves CSS as JS by
    // `Accept`) apart in that cache.
    const out: Record<string, string | string[]> = {
      'cache-control': typeof raw['cache-control'] === 'string' ? raw['cache-control'] : 'no-store',
    }
    // Range pass-through so media elements seek and skip instead of
    // re-downloading whole files on every navigation.
    for (const name of ['etag', 'last-modified', 'vary', 'content-range', 'accept-ranges'] as const) {
      const value = raw[name]
      if (typeof value === 'string') out[name] = value
    }
    const contentType = typeof raw['content-type'] === 'string' ? raw['content-type'] : undefined
    if (contentType !== undefined) out['content-type'] = contentType
    if (typeof raw.location === 'string') out.location = toProxyLocation(raw.location, scheme, prefix)
    // An upstream cannot plant cookies under the relay's reserved names: a
    // same-named cookie with a longer path is sent first and would shadow
    // the gate or relay session.
    const setCookies = (raw['set-cookie'] ?? [])
      .filter((value) => !RESERVED_COOKIE_RE.test(value.split('=', 1)[0].trim()))
      .map((value) => rewriteSetCookie(value, prefix))
    if (setCookies.length > 0) out['set-cookie'] = setCookies

    // Media types are case-insensitive and may be padded before parameters.
    const mediaType = (contentType ?? '').split(';', 1)[0].trim().toLowerCase()
    const contentEncoding = typeof raw['content-encoding'] === 'string' ? raw['content-encoding'] : undefined
    // A partial (206) or still-encoded body cannot be rewritten: it passes
    // through byte-exact, like every type the relay does not rewrite.
    const rewrite =
      status === 206 || (contentEncoding !== undefined && contentEncoding.trim().toLowerCase() !== 'identity')
        ? undefined
        : rewriterFor(mediaType)

    if (rewrite === undefined) {
      // Stream through with backpressure: media, downloads, and event
      // streams never sit in host memory, and a slow or paused reader (a
      // media element that stops reading once buffered) must not trip the
      // idle timeout. An upstream failure mid-body destroys the client
      // response, so a truncated body never ends cleanly (and gets cached).
      upstream.request.setTimeout(0)
      if (typeof raw['content-length'] === 'string') out['content-length'] = raw['content-length']
      if (contentEncoding !== undefined) out['content-encoding'] = contentEncoding
      res.writeHead(status, out)
      if (mediaType === 'text/event-stream') res.flushHeaders()
      pipeline(msg, res, () => {})
      return
    }

    let buffer: Buffer
    try {
      buffer = await readUpstreamBody(msg, MAX_REWRITE_BYTES)
    } catch (error) {
      if (abort.signal.aborted) {
        res.destroy()
        return
      }
      const timedOut = upstream.timedOut()
      res.writeHead(timedOut ? 504 : 502, { 'content-type': 'text/plain; charset=utf-8' })
      const reason = timedOut ? 'upstream timed out' : error instanceof Error ? error.message : 'upstream body failed'
      res.end(`loopback upstream ${scheme}://${host ?? '127.0.0.1'}:${port} failed: ${reason}`)
      return
    }
    res.writeHead(status, out)
    if (buffer.length === 0) {
      res.end()
      return
    }
    const codec = bodyCodec(contentType, buffer)
    res.end(Buffer.from(rewrite(buffer.toString(codec), prefix, session.gui), codec))
  }

  /** Every request the relay listener receives. */
  const onRelayRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://x')
    } catch {
      plainResponse(res, 400, 'bad request target')
      return
    }
    if (url.pathname === ENTER_PATH) {
      enterRelay(req, res, url)
      return
    }
    const ownOrigin = requestOrigin(req, protocol)
    if (ownOrigin === undefined) {
      plainResponse(res, 400, 'missing Host')
      return
    }
    const target = parseRoute(req.url)
    if (target === undefined) {
      // A root-relative reference built at runtime (template-literal
      // imports, HMR module refetches) resolves at the relay origin root.
      // Its Referer names the relayed document or module that asked: send
      // it back under that target's prefix. Same-origin path only, no
      // credentials involved.
      const referer = typeof req.headers.referer === 'string' ? req.headers.referer : undefined
      let from: RouteTarget | string | undefined
      if (referer !== undefined && (req.method === 'GET' || req.method === 'HEAD')) {
        try {
          const refUrl = new URL(referer)
          if (refUrl.origin === ownOrigin) from = parseRoute(`${refUrl.pathname}${refUrl.search}`)
        } catch {
          from = undefined
        }
      }
      if (from !== undefined && typeof from !== 'string') {
        res.writeHead(307, {
          location: `${relayPrefix(from.scheme, from.host, from.port)}${url.pathname.slice(1)}${url.search}`,
          'cache-control': 'no-store',
        })
        res.end()
        return
      }
      plainResponse(res, 404, 'not found')
      return
    }
    if (typeof target === 'string') {
      plainResponse(res, 404, target)
      return
    }
    const session = sessionOf(req)
    if (session === undefined) {
      plainResponse(res, 401, 'loopback relay: session missing or expired; reload the Browser tab')
      return
    }
    const rejection = relayFence(req, ownOrigin)
    if (rejection !== undefined) {
      plainResponse(res, rejection, 'forbidden')
      return
    }
    await relay(req, res, target, session, ownOrigin)
  }

  /**
   * WebSocket relay (dev-server HMR and app sockets). Browsers always send
   * Origin on WebSocket handshakes: only the relay origin's own documents
   * pass. The upstream sees its own origin, like the HTTP path.
   */
  const onRelayUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const reject = (status: number, text: string): void => {
      socket.end(`HTTP/1.1 ${String(status)} ${text}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`)
    }
    socket.on('error', () => socket.destroy())
    const target = parseRoute(req.url)
    const ownOrigin = requestOrigin(req, protocol)
    if (target === undefined || typeof target === 'string' || ownOrigin === undefined) {
      reject(404, 'Not Found')
      return
    }
    if (sessionOf(req) === undefined) {
      reject(401, 'Unauthorized')
      return
    }
    if (req.headers.origin !== ownOrigin || req.headers['sec-fetch-site'] === 'cross-site') {
      reject(403, 'Forbidden')
      return
    }
    if (String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
      reject(400, 'Bad Request')
      return
    }
    const authority = upstreamAuthority(target)
    const headers: Record<string, string> = {
      connection: 'Upgrade',
      upgrade: 'websocket',
      origin: `${target.scheme}://${authority}`,
    }
    if (target.host !== undefined) headers.host = authority
    for (const name of [
      'sec-websocket-key',
      'sec-websocket-version',
      'sec-websocket-protocol',
      'sec-websocket-extensions',
      'user-agent',
      'accept-language',
    ] as const) {
      const value = req.headers[name]
      if (typeof value === 'string') headers[name] = value
    }
    const cookie = forwardedCookies(req.headers.cookie)
    if (cookie !== undefined) headers.cookie = cookie
    const abort = new AbortController()
    inflight.add(abort)
    tunnels.add(socket)
    socket.once('close', () => {
      inflight.delete(abort)
      tunnels.delete(socket)
      abort.abort()
    })
    const send = target.scheme === 'https' ? nodeHttpsRequest : nodeHttpRequest
    const upstream = send({
      host: target.host === undefined ? '127.0.0.1' : target.host.replace(/^\[(.*)\]$/u, '$1'),
      port: target.port,
      path: target.path,
      method: 'GET',
      headers,
      timeout: UPSTREAM_TIMEOUT_MS,
      signal: abort.signal,
    })
    upstream.on('timeout', () => upstream.destroy(new UpstreamTimeout('upstream timed out')))
    upstream.on('error', () => {
      if (socket.writable) reject(502, 'Bad Gateway')
      else socket.destroy()
    })
    upstream.on('response', (response: IncomingMessage) => {
      // Upstream refused the upgrade: relay its status, nothing else.
      response.resume()
      reject(response.statusCode ?? 502, response.statusMessage ?? 'Upgrade Refused')
    })
    upstream.on('upgrade', (response: IncomingMessage, upstreamSocket: Duplex, upstreamHead: Buffer) => {
      upstream.setTimeout(0)
      tunnels.add(upstreamSocket)
      const lines = [`HTTP/1.1 101 ${response.statusMessage ?? 'Switching Protocols'}`]
      const prefix = relayPrefix(target.scheme, target.host, target.port)
      for (let i = 0; i < response.rawHeaders.length; i += 2) {
        const name = response.rawHeaders[i]
        let value = response.rawHeaders[i + 1]
        const lower = name.toLowerCase()
        if (lower === 'set-cookie') {
          if (RESERVED_COOKIE_RE.test(value.split('=', 1)[0].trim())) continue
          value = rewriteSetCookie(value, prefix)
        }
        lines.push(`${name}: ${value}`)
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (upstreamHead.length > 0) socket.write(upstreamHead)
      if (head.length > 0) upstreamSocket.write(head)
      const close = (): void => {
        socket.destroy()
        upstreamSocket.destroy()
      }
      upstreamSocket.on('error', close)
      upstreamSocket.on('close', () => {
        tunnels.delete(upstreamSocket)
        close()
      })
      socket.on('close', close)
      socket.pipe(upstreamSocket)
      upstreamSocket.pipe(socket)
    })
    upstream.end()
  }

  await ctx.effect(async () => {
    const tls = protocol === 'https:' ? webServer.config?.tls : undefined
    if (protocol === 'https:' && tls === undefined) {
      throw new Error('[dsh-loopback-bridge] the GUI listener speaks TLS but its certificate files are not readable from webServer.config.tls')
    }
    const listener = (req: IncomingMessage, res: ServerResponse): void => {
      onRelayRequest(req, res).catch((error: unknown) => {
        ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
        if (res.headersSent) res.destroy()
        else plainResponse(res, 500, 'loopback relay failed')
      })
    }
    const server: Server =
      tls === undefined
        ? createHttpServer(listener)
        : createHttpsServer(
            { cert: await readFile(tls.certFile, 'utf8'), key: await readFile(tls.keyFile, 'utf8') },
            listener,
          )
    server.on('upgrade', onRelayUpgrade)
    const preferred =
      options.port ?? (webServer.port === undefined ? 0 : webServer.port + DEFAULT_PORT_OFFSET)
    // A hot reload races the previous instance's close: retry the stable
    // port briefly before giving up on it.
    let bound = false
    for (let attempt = 0; attempt < 10 && !bound; attempt++) {
      try {
        await listenOn(server, preferred, relayHost)
        bound = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
        await delay(200)
      }
    }
    if (!bound) {
      if (options.port !== undefined) {
        throw new Error(`[dsh-loopback-bridge] relay port ${String(options.port)} on ${relayHost} is in use`)
      }
      ctx.logger.warn(`[dsh-loopback-bridge] relay port ${String(preferred)} is in use; using an OS-assigned port`)
      await listenOn(server, 0, relayHost)
    }
    const address = server.address()
    relayPort = typeof address === 'object' && address !== null ? address.port : undefined
    return async () => {
      relayPort = undefined
      for (const pending of inflight) pending.abort()
      inflight.clear()
      for (const tunnel of tunnels) tunnel.destroy()
      tunnels.clear()
      const closed = new Promise<void>((resolve) => server.close(() => resolve()))
      server.closeAllConnections()
      await closed
    }
  }, 'dsh-loopback-bridge: relay listener')

  // The GUI learns the relay origin (for postMessage) from its boot page.
  const events = ctx as unknown as {
    on(name: 'webserver/index-inject', listener: (table: unknown[]) => void): () => boolean
  }
  events.on('webserver/index-inject', (table) => {
    if (relayPort === undefined) return
    table.push({
      kind: 'global',
      name: '__DSH_LOOPBACK_RELAY__',
      value: options.origin === undefined ? { port: relayPort } : { port: relayPort, origin: options.origin },
    })
  })

  ctx.effect(
    () => {
      const stop = webServer.register({ kind: 'prefix', path: ROUTE_PATH, handler: enterFromGui })
      return () => {
        if (typeof stop === 'function') stop()
      }
    },
    'dsh-loopback-bridge: GUI entry route',
  )
}
