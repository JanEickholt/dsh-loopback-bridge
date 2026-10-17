/**
 * dsh-loopback-bridge: host-side loopback proxy for the right-Sidebar Browser.
 *
 * The Sidebar Browser renders typed URLs in a client-side iframe, so a
 * loopback address like `localhost:5173` resolves on the PC running the
 * * browser, not on the DSH host. This plugin registers
 * `/dsh-loopback/<scheme>/<host>/<port><path+search>` on the web origin and
 * fetches `<scheme>://<host>:<port><path+search>` host-side, forwarding
 * the original host in the Host header so host-routed dev apps (tenant
 * subdomains) resolve correctly. The `@deepseek-ai/dsh-client-ui-sidebar-browser`
 * bundle rewrites loopback targets to this route (see its `loopbackProxySrc`).
 * Public hosts ride the same route: pages that forbid embedding
 * (`X-Frame-Options`, CSP `frame-ancestors`) cannot render in the iframe
 * natively, and the relay drops those headers because it forwards only
 * content-type, location, and set-cookie upstream headers.
 *
 * Security shape: every request must pass the connection service's browser
 * authentication (`admit`), with one documented exception — the Host/Origin
 * fence 403 caused by the presentation iframe's `Origin: null` is retried
 * against the browser-session cookie check, which stays authoritative. The
 * legacy hostless route stays pinned to 127.0.0.1; host-form targets resolve
 * DNS on the DSH host (authenticated users only), and the browser's
 * `dsh-auth-*` gate cookies are never forwarded upstream.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { request as nodeHttpRequest } from 'node:http'
import { request as nodeHttpsRequest } from 'node:https'

import { injectInspector } from './inspector'

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
}

/** Structural surface of the dsh-client-connection service this plugin consumes. */
interface ConnectionLike {
  admit(request: IncomingMessage): { peer: unknown } | { rejection: number }
  browserAuth?: { isAuthenticated(request: IncomingMessage): boolean }
}

const ROUTE_PATH = '/dsh-loopback'

/** Loopback traffic is dev-server pages and asset reads; bodies stay small. */
const MAX_BODY_BYTES = 5 * 1024 * 1024
const UPSTREAM_TIMEOUT_MS = 15_000

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

const FORWARDED_REQUEST_HEADERS = ['accept', 'accept-language', 'content-type', 'if-none-match', 'if-modified-since', 'range'] as const

/**
 * DSH's own browser-session cookies (dsh-client-connection names them
 * `dsh-auth-<hash>`) must never cross to the upstream dev server: they are
 * the proxy's gate credentials. Everything else in the Cookie header is
 * upstream session state and travels.
 */
const DSH_COOKIE_PREFIX = 'dsh-auth-'

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
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        req.destroy()
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
 * `==`/`===` comparisons.
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
const JS_NAV_ASSIGN_RE = new RegExp(
  `(location\\.href\\s*=\\s*(?![=]))(${JS_NAV_CALL_VALUE}|[A-Za-z_$][\\w$.]*(?![\\w$.(?]))`,
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
 * Map an absolute http(s) URL to its relay form; null when unparseable.
 * Default ports normalize (443/https, 80/http). Sites that forbid embedding
 * only render inside the presentation iframe through this form — the relay
 * drops their framing headers because it forwards no other upstream headers.
 */
function toProxyUrl(value: string): string | null {
  if (!/^https?:\/\//iu.test(value)) return null
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  const scheme = parsed.protocol === 'https:' ? 'https' : 'http'
  const port = parsed.port === '' ? (scheme === 'https' ? '443' : '80') : parsed.port
  return `${ROUTE_PATH}/${scheme}/${parsed.hostname}/${port}${parsed.pathname}${parsed.search}${parsed.hash}`
}

function toProxyPath(value: string, prefix: string): string {
  if (value.startsWith('//')) return value
  if (/^https?:\/\//iu.test(value)) return toProxyUrl(value) ?? value
  if (!value.startsWith('/')) return value
  return `${prefix}${value.slice(1)}`
}

function rewriteSrcset(value: string, prefix: string): string {
  return value
    .split(',')
    .map((candidate) => {
      const trimmed = candidate.trim()
      if (trimmed === '') return candidate
      const space = trimmed.indexOf(' ')
      const url = space === -1 ? trimmed : trimmed.slice(0, space)
      const descriptor = space === -1 ? '' : trimmed.slice(space)
      return `${toProxyPath(url, prefix)}${descriptor}`
    })
    .join(', ')
}

function rewriteHtml(html: string, prefix: string): string {
  const withAttrs = html.replace(ATTR_RE, (match, name: string, dq: string, sq: string) => {
    // A matched empty `src=""` leaves the single-quote capture undefined;
    // pick by which alternative fired or empty-URL attrs crash rewrites.
    const value = dq !== undefined ? dq : sq
    if (value === '' || !URL_ATTRS.has(name)) return match
    const next = name === 'srcset' ? rewriteSrcset(value, prefix) : toProxyPath(value, prefix)
    const quote = dq !== undefined ? '"' : "'"
    return ` ${name}=${quote}${next}${quote}`
  })
  const withScripts = rewriteInlineScripts(withAttrs, prefix)
  const withUrls = withUrlsOf(withScripts, prefix)
  return injectBase(injectNavHelper(injectInspector(withUrls)), prefix)
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
    const scheme = parsed.protocol === 'https:' ? 'https' : 'http'
    const port = parsed.port === '' ? (parsed.protocol === 'https:' ? '443' : '80') : parsed.port
    return `${quote}${ROUTE_PATH}/${scheme}/${parsed.hostname}/${port}${parsed.pathname}${parsed.search}${parsed.hash}${quote}`
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
    const name = (eq === -1 ? trimmed : trimmed.slice(0, eq)).toLowerCase()
    if (name === 'domain') continue
    if (name === 'path' && eq !== -1 && trimmed.slice(eq + 1).startsWith('/')) {
      rewritten.push(` Path=${toProxyPath(trimmed.slice(eq + 1), prefix).replace(/\/+$/, '')}`)
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
 * the accessing PC's loopback.
 */
function toProxyLocation(
  location: string,
  scheme: string,
  host: string | undefined,
  port: number,
): string {
  if (location.startsWith('/') && !location.startsWith('//')) {
    const prefix =
      host === undefined
        ? `${ROUTE_PATH}/${scheme}/${port}/`
        : `${ROUTE_PATH}/${scheme}/${host}/${port}/`
    return `${prefix}${location.slice(1)}`
  }
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

/**
 * Point the document's relative URLs at the proxy prefix. An explicit
 * `<base>` wins; without it plain relative references would hit the
 * application origin instead of the proxied dev server.
 */
function injectBase(html: string, baseHref: string): string {
  if (/<base\s/u.test(html)) return html
  const tag = `<base href="${baseHref}">`
  const head = /<head[^>]*>/iu.exec(html)
  if (head === null) return `${tag}${html}`
  const at = head.index + head[0].length
  return `${html.slice(0, at)}${tag}${html.slice(at)}`
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
 * of the proxied app.
 */
const NAV_HELPER_JS =
  '(function(){try{' +
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
  "if(u.charAt(0)==='/'){if(u.indexOf('/dsh-loopback/')===0)return u;" +
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
  'globalThis.EventSource=WrappedEventSource}' +
  // Framework routers push same-origin URLs that lack the relay prefix
  // (root-relative links resolve at the origin); rewrite them so the
  // frame address stays inside the relay and reload/back/forward work.
  'var dshPush=history.pushState;' +
  'history.pushState=function(st,t,u){try{' +
  'if(u!==undefined&&u!==null)u=globalThis.__dshNav(String(u));' +
  'return dshPush.call(history,st,t,u)}catch(e){' +
  'return dshPush.call(history,st,t,u)}};' +
  'var dshReplace=history.replaceState;' +
  'history.replaceState=function(st,t,u){try{' +
  'if(u!==undefined&&u!==null)u=globalThis.__dshNav(String(u));' +
  'return dshReplace.call(history,st,t,u)}catch(e){' +
  'return dshReplace.call(history,st,t,u)}};' +
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

function injectNavHelper(html: string): string {
  const tag = `<script>${NAV_HELPER_JS}</script>`
  const head = /<head[^>]*>/iu.exec(html)
  if (head === null) return `${tag}${html}`
  const at = head.index + head[0].length
  return `${html.slice(0, at)}${tag}${html.slice(at)}`
}

/**
 * Buffered upstream response with just the fields the handler consumes.
 */
interface UpstreamResult {
  status: number
  contentType: string | undefined
  location: string | undefined
  cacheControl: string | undefined
  etag: string | undefined
  lastModified: string | undefined
  contentRange: string | undefined
  acceptRanges: string | undefined
  setCookies: string[]
  buffer: Buffer
}

class UpstreamTimeout extends Error {}

/**
 * Upstream call over node:http — NOT fetch. The dsh host process runs on
 * Node, whose fetch (undici) silently drops the forbidden `host` header,
 * breaking host-routed dev apps; node:http sends explicit Host headers
 * verbatim. Redirects are never followed (fetch's `manual` behavior).
 */
function fetchUpstream(options: {
  scheme: 'http' | 'https'
  targetHost: string
  port: number
  path: string
  method: string
  headers: Record<string, string>
  body: Buffer | undefined
  timeoutMs: number
}): Promise<UpstreamResult> {
  return new Promise((resolve, reject) => {
    const send = options.scheme === 'https' ? nodeHttpsRequest : nodeHttpRequest
    const req = send(
      {
        host: options.targetHost,
        port: options.port,
        path: options.path,
        method: options.method,
        headers: options.headers,
        timeout: options.timeoutMs,
      },
      (msg: IncomingMessage) => {
        const chunks: Buffer[] = []
        msg.on('data', (chunk: Buffer) => chunks.push(chunk))
        msg.on('error', reject)
        msg.on('end', () => {
          const raw = msg.headers
          const setCookie = raw['set-cookie']
          resolve({
            status: msg.statusCode ?? 502,
            contentType: typeof raw['content-type'] === 'string' ? raw['content-type'] : undefined,
            location: typeof raw.location === 'string' ? raw.location : undefined,
            cacheControl: typeof raw['cache-control'] === 'string' ? raw['cache-control'] : undefined,
            etag: typeof raw.etag === 'string' ? raw.etag : undefined,
            lastModified: typeof raw['last-modified'] === 'string' ? raw['last-modified'] : undefined,
            contentRange: typeof raw['content-range'] === 'string' ? raw['content-range'] : undefined,
            acceptRanges: typeof raw['accept-ranges'] === 'string' ? raw['accept-ranges'] : undefined,
            setCookies: Array.isArray(setCookie) ? setCookie : typeof setCookie === 'string' ? [setCookie] : [],
            buffer: Buffer.concat(chunks),
          })
        })
      },
    )
    req.on('timeout', () => {
      req.destroy(new UpstreamTimeout('upstream timed out'))
    })
    req.on('error', reject)
    if (options.body !== undefined) req.end(options.body)
    else req.end()
  })
}

/**
 * Pipe one upstream response through unbuffered; the buffered path holds
 * the response open until its timeout, which kills `text/event-stream`
 * feeds. No timeout: event streams stay open for the connection's life.
 * @param options - upstream target; a request body is never sent.
 * @param res - client response to write the stream to.
 */
function streamUpstream(
  options: {
    scheme: 'http' | 'https'
    targetHost: string
    port: number
    path: string
    method: string
    headers: Record<string, string>
  },
  res: ServerResponse,
): void {
  const send = options.scheme === 'https' ? nodeHttpsRequest : nodeHttpRequest
  const upstream = send(
    {
      host: options.targetHost,
      port: options.port,
      path: options.path,
      method: options.method,
      headers: options.headers,
    },
    (msg: IncomingMessage) => {
      const out: Record<string, string | string[]> = { 'cache-control': 'no-store' }
      const contentType = msg.headers['content-type']
      if (typeof contentType === 'string') out['content-type'] = contentType
      res.writeHead(msg.statusCode ?? 502, out)
      res.flushHeaders()
      msg.pipe(res)
      msg.on('error', () => {
        res.end()
      })
    },
  )
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end()
  })
  res.on('close', () => {
    upstream.destroy()
  })
  upstream.end()
}

export function apply(ctx: Context): void {
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

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const admission = connection.admit(req)
    const rejection = 'rejection' in admission ? admission.rejection : undefined
    /**
     * The connection service's Host/Origin fence rejects `Origin: null`,
     * which the sandboxed presentation iframe attaches to every subresource
     * fetch. That 403 is a fence artifact, not an authentication failure:
     * fall back to the browser-session cookie check, which stays
     * authoritative. A cross-site embed cannot carry the SameSite=Strict
     * session cookie, so the fallback admits only our own same-site frame.
     */
    if (
      rejection === 403 &&
      req.headers['sec-fetch-site'] !== 'cross-site' &&
      connection.browserAuth?.isAuthenticated(req) === true
    ) {
      // Fence artifact of the sandboxed frame's `Origin: null`; the
      // browser-session cookie check above is authoritative.
    } else if (rejection !== undefined) {
      res.writeHead(rejection)
      res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
      return
    }
    if (req.method === undefined || !METHODS.has(req.method)) {
      res.writeHead(405)
      res.end('method not allowed')
      return
    }
    const method = req.method
    const tail = (req.url ?? '').slice(ROUTE_PATH.length)
    let parsed = ROUTE_TAIL_HOST.exec(tail)
    let host: string | undefined
    if (parsed !== null) {
      host = parsed[2]
    } else {
      parsed = ROUTE_TAIL.exec(tail)
    }
    if (parsed === null || (parsed[1] !== 'https' && parsed[1] !== 'http')) {
      res.writeHead(404)
      res.end(
        `loopback route: expected ${ROUTE_PATH}/<http|https>/<host>/<port><path>`,
      )
      return
    }
    const scheme = parsed[1] === 'https' ? 'https' : 'http'
    const port = Number.parseInt(parsed[2 + (host === undefined ? 0 : 1)] ?? '', 10)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      res.writeHead(404)
      res.end('loopback route: port out of range')
      return
    }
    const path = parsed[3 + (host === undefined ? 0 : 1)] ?? '/'

    let body: Buffer | undefined
    try {
      const drained = await readBody(req)
      if (BODY_METHODS.has(method)) body = drained
    } catch (error) {
      if (isRequestBodyTooLarge(error)) {
        res.writeHead(413)
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
    // Upstream session cookies travel; the gate's own `dsh-auth-*` cookies
    // stay on the application origin. Samesite/Lax-Strict semantics are
    // preserved because the frame is same-origin with the proxy.
    const rawCookie = req.headers.cookie
    if (typeof rawCookie === 'string') {
      const forwarded = rawCookie
        .split(';')
        .map((segment) => segment.trim())
        .filter((segment) => segment !== '' && !segment.startsWith(DSH_COOKIE_PREFIX))
      if (forwarded.length > 0) headers.cookie = forwarded.join('; ')
    }
    // Host-routed dev apps (tenant subdomains) resolve the tenant from the
    // Host header — sent verbatim by node:http (undici's fetch drops it).
    // Default ports drop the suffix so public upstreams see the browser form.
    if (host !== undefined) {
      const defaultPort = (scheme === 'https' && port === 443) || (scheme === 'http' && port === 80)
      headers.host = defaultPort ? host : `${host}:${port}`
    }
    if (body !== undefined) headers['content-length'] = String(body.length)

    // `text/event-stream` requests must stream through unbuffered.
    if (
      method === 'GET' &&
      typeof req.headers.accept === 'string' &&
      req.headers.accept.includes('text/event-stream')
    ) {
      streamUpstream({ scheme, targetHost: host ?? '127.0.0.1', port, path, method, headers }, res)
      return
    }

    let upstream: UpstreamResult
    try {
      upstream = await fetchUpstream({
        scheme,
        targetHost: host ?? '127.0.0.1',
        port,
        path,
        method,
        headers,
        body,
        timeoutMs: UPSTREAM_TIMEOUT_MS,
      })
    } catch (error) {
      const timedOut = error instanceof UpstreamTimeout
      res.writeHead(timedOut ? 504 : 502, { 'content-type': 'text/plain; charset=utf-8' })
      const reason = error instanceof Error ? error.message : 'upstream request failed'
      res.end(`loopback upstream ${scheme}://${host ?? '127.0.0.1'}:${port} unavailable: ${reason}`)
      return
    }

    const prefix =
      host === undefined
        ? `${ROUTE_PATH}/${scheme}/${port}/`
        : `${ROUTE_PATH}/${scheme}/${host}/${port}/`
    // Upstream cache validators pass through so warm tab loads revalidate
    // (304) instead of re-downloading the whole dev-server module graph.
    // The browser caches what this proxy served under the relay URL — for
    // rewritten HTML that is the rewritten copy, so a 304 makes the browser
    // reuse exactly that. `no-store` only when upstream sends no policy.
    const out: Record<string, string | string[]> = { 'cache-control': upstream.cacheControl ?? 'no-store' }
    if (upstream.etag !== undefined) out.etag = upstream.etag
    if (upstream.lastModified !== undefined) out['last-modified'] = upstream.lastModified
    // Range pass-through so media elements seek and skip instead of
    // re-downloading whole files on every navigation.
    if (upstream.contentRange !== undefined) out['content-range'] = upstream.contentRange
    if (upstream.acceptRanges !== undefined) out['accept-ranges'] = upstream.acceptRanges
    const contentType = upstream.contentType
    if (contentType !== undefined) out['content-type'] = contentType
    const location = upstream.location
    if (location !== undefined) out.location = toProxyLocation(location, scheme, host, port)
    const setCookies = upstream.setCookies.map((cookie) => rewriteSetCookie(cookie, prefix))
    if (setCookies.length > 0) out['set-cookie'] = setCookies
    res.writeHead(upstream.status, out)

    if (method === 'HEAD' || upstream.buffer.length === 0) {
      res.end()
      return
    }
    const mediaType = (contentType ?? '').split(';', 1)[0]
    if (mediaType === 'text/html') {
      res.end(rewriteHtml(upstream.buffer.toString('utf-8'), prefix))
      return
    }
    if (mediaType === 'text/css') {
      res.end(rewriteCss(upstream.buffer.toString('utf-8'), prefix))
      return
    }
    if (mediaType === 'text/javascript' || mediaType === 'application/javascript') {
      res.end(rewriteJs(upstream.buffer.toString('utf-8'), prefix))
      return
    }
    res.end(upstream.buffer)
  }

  ctx.effect(
    () => {
      const stop = webServer.register({ kind: 'prefix', path: ROUTE_PATH, handler: handle })
      return () => {
        if (typeof stop === 'function') stop()
      }
    },
    'dsh-loopback-bridge: loopback proxy route',
  )
}
