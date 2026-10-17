# dsh-loopback-bridge

Auth-gated host-side proxy for the right-Sidebar **Browser** tab.

## Problem

The Sidebar Browser renders typed URLs in a client-side iframe. A loopback
address like `localhost:5173` therefore resolves on the **PC running the
browser**, not on the DSH host — a remote PC (LAN or pocket tunnel) cannot
reach the host's dev servers, and schemeless input also defaulted to `https://`
while dev servers speak plain HTTP.

## Behavior

- The host bundle of `@deepseek-ai/dsh-client-ui-sidebar-browser` routes
  loopback targets (`localhost`, `*.localhost`, `127.0.0.0/8`, `[::1]`)
  **hybrid**: when the GUI is opened on the host (loopback origin), the
  iframe stays native (`element.src = url`); when the GUI is opened
  remotely (e.g. the LAN address), loopback targets are rewritten to
  `/dsh-loopback/<scheme>/<host>/<port><path>` on the application origin,
  at the single point where the iframe `src` is assigned. Public targets
  ride the relay in both cases: sites that forbid embedding
  (`X-Frame-Options`, CSP `frame-ancestors` — google.com, github.com)
  cannot render in an iframe natively, and the relay drops those headers
  because it forwards only `content-type`, `location`, and `set-cookie`
  upstream headers. Address bar, Back/Forward and checkpoints keep the
  honest original URL. The pre-host form `/dsh-loopback/<scheme>/<port><path>`
  is still served (legacy links, upstream pinned to `127.0.0.1`).
- Schemeless loopback input parses as `http://`; public schemeless input stays
  `https://`.
- This plugin serves that route: every request passes the connection
  service's browser authentication (`admit`, same gate as `/api`), then is
  fetched host-side over `node:http(s)` from
  `<scheme>://<host>:<port><path>` (the legacy hostless form stays pinned
  to `127.0.0.1`) with the request's `Host` header set to `<host>`, plus
  the `:port` suffix unless it is the scheme default — explicit socket
  call, because undici silently drops the forbidden `host` header.
  Host-header virtual hosting (`<tenant>.localhost` dev subdomains)
  therefore works through the tab, and public sites receive the browser
  form of their Host header. Upstream redirects are not followed;
  `Location` responses are rewritten to the prefix form (absolute public
  redirects like `google.com` → `www.google.com` stay inside the relay).
- `text/html` responses get their root-relative URLs rewritten to the prefix
  (`src`, `href`, `srcset`, `poster`, `action`, `data-src`, CSS `url(...)`) plus
  a `<base href="/dsh-loopback/<scheme>/<host>/<port>/">` injection for plain
  relative references. Absolute `http(s)` values in navigation attributes
  (`href`, `action`) map to the relay form too — public pages link with
  absolute URLs (Google's result links), and a native in-frame navigation
  would die on the target's framing restrictions. Absolute subresource
  URLs (`src`, `srcset`) stay native: they are not framed, and proxying
  them only adds host bandwidth. `text/css` bodies get the same `url(...)`
  rewrite.
- Attribute values are extracted by which quote alternative matched: a
  matched empty `src=""` leaves the other capture `undefined`, and the
  guard must return it unchanged — public pages (Google, GitHub) carry
  empty URL attributes, and feeding `undefined` into the path rewriter
  throws inside the response, which the web server's request guard turns
  into `res.destroy()` — the frame dies with `ERR_EMPTY_RESPONSE` and no
  server-side trace.
- Served JavaScript (`text/javascript`, `application/javascript`) and inline
  code scripts get root-relative ES module specifiers (`from "/x"`,
  `import "/x"`, `import("/x")`) and root-relative asset-path string literals
  (extension-gated: images, video, fonts) rewritten to the prefix. This is
  what makes Vite/SvelteKit hydration work through the tab: the dev bootstrap
  imports its entry via `import("/@fs/...")`, and runtime URL resolution —
  property or attribute — discards the base path exactly like every other
  RFC 3986 root-relative reference.
- Inline code scripts additionally get **absolute loopback URL literals**
  rewritten to the root-relative relay form (route + target, no origin).
  Server-rendered payloads embed upstream-built absolute loopback URLs —
  with a Host-pinned request the app builds them from the virtual host
  (serveio's `devDestination: "http://sarayli.localhost:5173/…"`), and
  client-side `location.replace(devDestination)` would navigate the frame
  off the proxy to a loopback a remote client cannot reach. Root-relative
  is deliberate: the `Host` header inside the web app is the internal hop
  (`127.0.0.1:3080`), not the external origin the client actually reached,
  so absolute relay forms would point remote clients at a dead loopback —
  inline scripts resolve against the injected `<base>` instead, which is
  correct on every listener. **Origin-only** literals
  (`http://localhost:5173`, no path) are skipped: they are URL-builder
  inputs (serveio's dev toolbar does `new URL(baseOrigin)` and stacks
  subdomains onto `base.host`), and rewriting the origin breaks the
  builder — the `__dshNav` wrap catches the runtime navigations built from
  them. Module chunks keep their literals: their values are parsed the same
  way at runtime.
- The injected helper also wraps `fetch` and `EventSource`: root-relative
  inputs (`'/api/…'`) would otherwise resolve against the GUI origin —
  landing in the host app's own `/api` namespace — instead of the proxied
  app. String inputs map through `__dshNav`, which also folds app-origin
  absolute strings into the relay: SvelteKit's dev data loads
  (`__data.json`) call `fetch` with the origin-resolved absolute URL, and
  passing those through made the router's data fetch hit the GUI origin
  and 404. `Request`/`URL` objects pass through unchanged (serveio's
  `apiRequest` and SvelteKit's data loads both pass strings). SvelteKit's
  dev client later re-wraps `fetch` for its load-node lock; the helper's
  wrapper stays in that closure chain.
- `GET` requests with `Accept: text/event-stream` stream through unbuffered
  (status, content-type, then `pipe`): the buffering path holds a response
  open until its timeout, which kills board feeds (serveio's
  `/api/shop/board/events`). Client disconnect destroys the upstream
  request; streams get no upstream timeout.
- The proxied iframe uses the product's standard sandbox policy
  (`WEB_BROWSER_SANDBOX`), not a hardened one.

## Security model

- Plugin routes on the web origin are otherwise **public** — this route's
  `admit` gate is load-bearing. Unauthenticated requests get 401/403.
- The one documented gate exception: the Host/Origin fence rejects
  `Origin: null`, which every fetch from an opaque-origin iframe carries. A
  403 that arrives with a non-`cross-site` `Sec-Fetch-Site` is retried against
  the connection service's browser-session cookie check
  (`browserAuth.isAuthenticated`), which stays authoritative. Cross-site
  embeds cannot carry the SameSite=Strict session cookie, so they still fail.
- The legacy hostless route form stays pinned to `127.0.0.1`; the host-form
  route resolves `<host>` host-side over DNS for **authenticated** users
  only — the gate is the boundary. That is what lets the tab reach public
  sites (they would otherwise die on `X-Frame-Options`), and it is the
  same trust level as any authenticated server-side fetch the app makes.
- Cookies cross the boundary selectively: the request's `Cookie` header is
  forwarded minus the DSH gate cookies (`dsh-auth-*`), and upstream
  `Set-Cookie` responses are rewritten to `Path=/dsh-loopback/...` with
  `Domain` dropped, so per-host dev cookies stay isolated on the app origin
  and keep working across proxied sessions (serveio dev-auth, per-tenant
  sessions).
- Loopback tabs render with the product-standard sandbox plus
  `allow-modals` (`allow-scripts allow-forms allow-same-origin
  allow-popups allow-popups-to-escape-sandbox allow-modals`), exactly
  like any other site in the tab. `allow-modals` is a local addition:
  dev apps gate destructive actions on native `confirm()` dialogs, and a
  sandbox without the token makes those calls return `false` silently —
  the dialog never appears and the button looks dead.
  A sandbox without `allow-same-origin` is NOT viable here: the opaque origin
  strips cookies, fetch metadata and referer from every subresource, so the
  gate would 403 all assets and no network-side check can tell our sandboxed
  frame from a third-party sandboxed embed.

## Ceilings (deliberate)

- No WebSocket upgrade proxy: Vite HMR does not connect through the tab.
  Reload the Browser tab manually after dev-server code changes.
- Responses are buffered (`arrayBuffer`), not streamed — except `GET` +
  `Accept: text/event-stream`, which pipes unbuffered (see Behavior);
  request bodies cap at 5 MiB.
- URL rewriting is lexical: unquoted attribute values and protocol-relative
  references (`//host/...`) stay unrewritten and can escape the prefix
  (usually failing as app-origin 404s). In JS, template-literal imports
  (`import(\`/${x}\`)`) stay unrewritten. Runtime `location` navigations get
  a different treatment: served JS is scanned for
  `location.href = <value>` / `location.replace(<value>)` and the value is
  wrapped as `globalThis.__dshNav?.(value) ?? value` (Svelte 5's compiled
  `$.get(value)` call form included). `__dshNav`, injected as the first
  `<head>` script, maps every absolute `http(s)` URL to the relay form —
  other origins directly (public navigations must ride the relay or the
  frame dies on framing restrictions), app-origin ones folded back under
  the current relay prefix: inside a relayed frame every app-origin URL is
  an escaped request, because framework routers resolve root-relative
  links at the origin (a `/management/tables` link on a relayed page
  resolves at the GUI origin, not the relay path — SvelteKit's client
  router then loads `/management/tables/__data.json` from the GUI origin,
  404s, and renders its own error page). Root-relative paths map to the
  current
  prefix, and passes already-prefixed values through — so serveio's dev
  toolbar **Go** (which builds `<tenant>.<base.host>` at runtime), its
  `/dev/switch` auto-login leg and the role landing all stay in-relay.
  The helper also wraps `history.pushState`/`history.replaceState`:
  client-side routers push the origin-resolved URL (GUI origin, no
  prefix), which would drag the frame address out of the relay and break
  the prefix extraction every later mapping depends on; the wrap folds
  those URLs back into the prefix form first. And it wraps
  `Element.prototype.setAttribute` for URL-shaped attributes (`src`,
  `action`, `poster`, `data-src`, and `href` off anchors): hydrated
  layouts re-set resource attributes at runtime — serveio's root layout
  rewrites `<link href="/theme.css?v=…">` on the first router hop
  (Svelte 5 calls plain `setAttribute`), and the root-relative value
  resolves at the GUI origin, 404s, and silently drops the tenant
  palette: the page keeps rendering with the default colors. Anchor
  `href` stays unwrapped on purpose: the router needs the app-relative
  value to keep doing client-side hops. Verified: dev bar
  sarayli+manager, client-side link clicks Tische → Bestellungen render
  in-relay with `__data.json` served through the relay (200), the theme
  link staying on the relay form (`--color-primary` keeps the tenant
  brand color across hops), Back landing on the previous page via
  SvelteKit's popstate fallback — an unmatched (prefixed) route makes
  SvelteKit do a native navigation, which the relay serves as a full
  reload. Not covered: `window.open`, navigations
  built through string concatenation inside a single expression, and
  navigations whose value is a call with side effects (left unwrapped by
  design). The app itself stays pristine (its earlier proxy-aware edits
  were reverted).
- Framework client navigation leftovers (accepted): after a client-side
  hop SvelteKit's internal `page.url` keeps the GUI-origin form, so
  components reading `$page.url.origin` see the GUI origin (any absolute
  link they build is caught by `__dshNav` at runtime, but
  `page.url`-derived comparisons could surprise); `fetch(new Request(...))`
  objects with app-origin URLs pass the wrapper through; runtime
  `srcset` writes and `setAttributeNS` (SVG) stay unwrapped; the dev
  toolbar's `redirectSuffix` matches `location.pathname` against
  unprefixed management/staff/owner paths, so Go from a
  client-navigated page may skip the `&redirect=` carry-over.
- `site.webmanifest` fetches are 401'd by the gate (manifest fetch carries no
  cookie through the sandbox path); PWA install metadata stays broken,
  cosmetic only.
- Full-URL redirects are rewritten back into the proxy form
  (`toProxyLocation`): loopback origins re-enter the relay, and public
  redirects (`google.com` → `www.google.com`) stay inside the relay too,
  where their framing restrictions are already stripped.
- Because the loopback frame is same-origin (`allow-same-origin`), a proxied
  dev server's page could script against the app origin — the same trust level
  the tab's "Disable sandbox restrictions" toggle already grants for any site.

## Host-bundle dependency (re-apply after dsh updates)

The client rewrite lives in the installed host package, which a dsh update
overwrites. Re-apply the hybrid hunks (1-3), the element-pick hunks (4-10),
and the sandbox-modals hunk (11) in
`node_modules/@deepseek-ai/dsh-client-ui-sidebar-browser/lib/client.js`:

1. `parseBrowserAddress`: track `hasScheme`, and for schemeless input with a
   `LOOPBACK_HOSTNAME` (`/^(?:(?:[a-z0-9-]+\.)*localhost\.?|127(?:\.\d{1,3}){3}|\[::1\])$/iu`
   — note the subdomain-prefixed `*.localhost` arm, needed for dev tenant
   hosts, and the bracketed `\[::1\]`, because `URL.hostname` serializes IPv6
   bracketed) set `url.protocol = "http:"`.
2. `IframePresentation`: helper `presentationSrc(url)` — loopback targets stay
   native when the GUI origin is loopback; otherwise map to
   `${location.origin}/dsh-loopback/<scheme>/<host>/<port><path>` (host
   segment required for host-header virtual hosting) — and in `render()` use
   it for `element.src`. Do NOT add a special loopback sandbox: leave
   `render()` at `if (current.sandboxed) element.setAttribute("sandbox",
   WEB_BROWSER_SANDBOX)`.
3. Readable address after in-frame navigation: the topbar otherwise keeps the
   stale address plus a "URL changed" badge because cross-origin frames hide
   their URL. In `render()`'s load listener, read
   `element.contentWindow.location.href` in a `try`/`catch` (same-origin relay
   frames succeed; cross-origin throws) and pass it through the
   `events.loaded(revision, href)` callback → `IframeImpl.handleLoaded(revision,
   href)` → store on an `observed` field when the navigation state is
   `unknown`, clear it in `load(request)`, and expose it as `observedUrl` in
   `snapshot()`. In `BrowserBody`: feed `frameAddressDisplay(observedUrl)` to
   `useBrowserDraft` (helper next to `presentationSrc`: strips the
   `/dsh-loopback/<scheme>/<host>/<port>` prefix via
   `/^\/dsh-loopback\/(https?)\/([^/]+)\/(\d+)(\/.*)?$/` so the bar shows the
   target form, which re-parses and re-loads identically), gate the
   `addressUnknown` dim class and the "URL changed" badge on
   `frame.observedUrl === void 0`, and let the external button open
   `frame.observedUrl` (the absolute relay URL) when `unknown`.

### Element-pick hunks (click-to-reference)

Adds the OpenCode-style element picker: a toolbar "Inspect" toggle in
each Browser tab that arms a click-picker injected by this bridge
(`src/inspector.ts`, dormant in every relayed HTML page) and inserts
the picked element's CSS selector + XPath + label into the chat
composer as a one-line reference. Arming re-loads the target through
the relay only when the live frame is not already relayed (native
on-host frames are cross-origin, so they cannot be armed in place);
relayed frames arm in place — postMessage `arm` + 700ms ack timeout,
falling back to the relay reload when the document predates inspector
injection. The bridge side is versioned here and needs no re-apply;
only the client hunks below live in the host bundle. Protocol:
parent→frame `{__dshInspect:'arm'|'disarm'}` via
`postMessage(msg, location.origin)` on the iframe's `contentWindow`;
frame→parent `{__dshInspectAck:true}` (arm confirmed — enables the
no-reload fast path), `{__dshInspectSelected:true, selector, xpath,
tagName, role, name, text, rect, url, title, viewport}` or
`{__dshInspectCancelled:true}` via
`window.parent.postMessage(payload, location.origin)`. Both sides
correlate by `event.source` (`window.parent` / the armed tab's
`iframe.contentWindow`) plus origin.

Re-apply after dsh updates (apply on top of the hybrid hunks above;
full diff against the pre-inspect base in
`host-bundle-patches/client.js.inspect.diff`, smoke harness
`host-bundle-patches/smoke.cjs`):

4. Inspect module block near the top of the plugin closure: per-tab state
   (`INSPECT_ARMED: Map<tabId, iframeEl>`, `INSPECT_PENDING: Set`,
   `INSPECT_FRAMES: Map<tabId, iframeEl>` registered in `render()`,
   `INSPECT_ACK: Map<tabId, timeout>`), `useSyncExternalStore`
   reactivity, `inspectClearAck`, `inspectDisarm` (also clears the ack
   timer), `inspectTryDirectArm(tabId, onStale)` (in-place arm when the
   frame's live href is `${origin}/dsh-loopback/…`, ack-verified with
   700ms fallback to `onStale`), `inspectComposerInsert` (targets the
   LEFTMOST visible `[contenteditable="true"][role="textbox"]` so the
   Side Chat panel can not shadow the session composer; when no
   textbox exists — e.g. Trajectory/Context view — copies the
   reference to the clipboard via a temporary `textarea` +
   `execCommand('copy')`; focus, caret to end,
   `execCommand('insertText')` with
   `Browser element on <url> — CSS <sel> · XPath <xp> · <label> — `),
   the window `message` listener (origin check, then
   `event.source === armed iframe.contentWindow`; ack → clear timer,
   selected → disarm + insert, cancelled → disarm only), and a
   capture-phase window `keydown` (Escape in the GUI window disarms
   every armed tab — frame focus is unreachable by mouse once armed).
   Idempotence guard `window.__dshInspectPickInstalled`.
5. `presentationSrc(url, forceRelay)`: second arg skips the on-host
   loopback-native shortcut.
6. `BrowserBody` toolbar: "Inspect" toggle between the address box and
   the external button (`IconInspectOutlineRegular`, `aria-pressed`,
   active reuses tool+`sandboxOff` classes; disabled when reload is).
   ON: try `inspectTryDirectArm` first (relayed frame → instant, no
   reload); else parse current address → `INSPECT_PENDING.add` →
   plain navigate through the relay. OFF: `inspectDisarm`, no
   navigation.
7. `IframePresentation.render()`: `element.src = presentationSrc(url,
   INSPECT_PENDING.has(tabId))`, `INSPECT_FRAMES.set(tabId, element)`;
   load listener arms (pending → set armed + postMessage arm, delete
   pending) or clears armed (non-pending load = fresh document, dormant
   inspector).
8. `BrowserController`: thread `options.tabId` into `createPage` events;
   `dispose` clears the tab's inspect state (armed, pending, frame
   ref, ack timer).
9. `createIframePage`: pass `tabId` into the `IframePresentation` events.
10. Locales `zh`/`en`: append `inspect.enable` / `inspect.disable`
    (comma on the prior last key).

Baseline shas: pre-inspect base
`393bf9df…280d2` (backup `client.js.bak-pre-inspect`), patched
`0776b16e…68219fb` (v1.2: in-place arm + hardened composer
targeting). The grep guard token is
`dsh-inspect hunk 1/7`. Picked URLs omit default ports
(`https://host/`, not `https://host:443/`) — normalization lives in
`src/inspector.ts` `targetUrl()`.

### Sandbox-modals hunk (11)

One line in the plugin closure: the `WEB_BROWSER_SANDBOX` constant gets
`allow-modals` appended. Without the token the sandboxed frame's
`confirm()`/`alert()`/`prompt()` calls are suppressed — they return
`false`/`undefined` with no dialog, so confirm-gated actions (serveio's
tenant delete, user delete, catalog deletes) appear dead. With the token
the native dialog appears over the GUI; playwright-driven verification
must handle it (`browser_handle_dialog`) or the tab hangs on the modal.
