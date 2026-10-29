# dsh-loopback-bridge

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin:
an auth-gated host-side relay for the right-Sidebar **Browser** tab. It lets
the Browser tab load loopback dev servers (`localhost:5173`, `app.localhost`,
`127.0.0.1:3000`, `[::1]`) on the DSH host no matter which machine the GUI is
open on, render public sites that forbid iframe embedding, and pick page
elements into the chat composer with an OpenCode-style inspector.

## Why

The Sidebar Browser renders typed URLs in a client-side iframe. A loopback
address therefore resolves on the **PC running the browser**, not on the DSH
host — a remote machine (LAN, tunnel, another desk) cannot reach the host's
dev servers. Two more upstream defaults get in the way: schemeless input
normalizes to `https://` while dev servers speak plain HTTP, and public sites
that send `X-Frame-Options` / CSP `frame-ancestors` (google.com, github.com)
refuse to render in an iframe at all.

The bridge fixes all three from the host side:

- every Browser target is rewritten to `/dsh-loopback/<scheme>/<host>/<port><path>`
  on the application origin, and this plugin serves that route by fetching
  host-side over `node:http(s)`, passing the DSH connection service's browser
  authentication first;
- schemeless loopback input parses as `http://` (a Sidebar Browser change, see
  Prerequisites);
- the relay's header surface is minimal: requests forward only `accept`,
  `accept-language`, `content-type`, `if-none-match`, `if-modified-since`,
  and `range` (plus `accept-encoding: identity`), and from upstream only
  `content-type`, `location`, `set-cookie`, cache validators, `vary`, and
  range headers pass through (`content-length`/`content-encoding` too on
  streamed bodies) — framing restrictions never reach the frame;

Public targets ride the same relay: that is what lets the tab open them at all,
and it keeps the element inspector (below) resident in every page.

## Prerequisites

### 1. Sidebar Browser change — needed, not yet upstream

The Browser tab needs two source changes in
`packages/client/ui-sidebar-browser` that upstream does not ship today
(verified against upstream `master` `687f282e`, dsh `v0.2.1-rc.2`, on
2026-10-17: `parseBrowserAddress` in `src/client/browser/url.ts` still
defaults **every** schemeless input to `https://`, and there is no
observed-address state):

- **Loopback HTTP default**: `parseBrowserAddress` parses schemeless input
  naming a loopback host (`localhost` including `*.localhost` subdomains and
  the trailing dot, `127.0.0.0/8`, `[::1]`) as `http://`. Explicit schemes and
  every rejection case are unchanged.
- **Observed addresses**: `IframePresentation` reads the loaded document's
  address in a `try`/`catch` (same-origin frames succeed, cross-origin throws
  to `undefined`) and reports it with each load event; `IframeImpl` remembers
  it for uncontrolled navigations, publishes `address: 'observed'` with that
  URL, clears it on the next controlled request, and falls back to the
  existing `unknown` + "page navigated" notice when the frame is not
  readable. Without this the address bar keeps the stale typed URL after any
  in-frame navigation.

Both live as one commit on top of upstream `master` `d743267` on the branch
[`browser-loopback-observed-addresses`](https://github.com/JanEickholt/deepseek-harness/tree/browser-loopback-observed-addresses)
(`d94121cca`, +102/−17 over 9 files, tests included). Upstream does not
accept external PRs at the moment, so it is offered there as a branch; until
it merges, this repo carries a copy:

- `host-bundle-patches/ui-sidebar-browser-observed-addresses.patch` — apply to
  the harness source tree (`git apply`) when you build DSH yourself. It
  applies cleanly to upstream `master` (`687f282e`, verified 2026-10-17)
  despite being cut against `d743267`; re-check after further upstream
  changes to `ui-sidebar-browser`.

If you run the prebuilt installed bundle instead of building from source, do
not apply that patch: the host-bundle instructions below recreate the same
behavior directly in `client.js` (steps 1 and 3), and the bundled reference
diff already includes them in its base.

### 2. Host-bundle patch (relay routing + inspector)

Routing Browser targets through the relay, the Inspect toggle, and one
sandbox tweak live in the built client bundle, which a dsh update overwrites.
The reference diff is regenerated from the current working state:

- `host-bundle-patches/client.js.inspect.diff` — 13 hunks against the
  documented pre-inspect base, `client.js.bak-pre-inspect`
  (sha256 `393bf9df…280d2`), producing the current patched `client.js`
  (sha256 `020d9b97…5c83`). Verified against
  `@deepseek-ai/dsh-client-ui-sidebar-browser` `0.2.0-rc.2`.
- `host-bundle-patches/smoke.cjs` — parse/check harness; run it from the
  installed `lib/` directory of the sidebar-browser package
  (`node <repo>/host-bundle-patches/smoke.cjs`), it expects `client.js` in
  the working directory.

Re-apply after every dsh update (see the hunk list under
[Host-bundle hunks](#host-bundle-hunks) for the semantics; the diff is the
authoritative shape for the pinned bundle version):

1. `parseBrowserAddress`: for schemeless input with a `LOOPBACK_HOSTNAME`
   (`/^(?:(?:[a-z0-9-]+\.)*localhost\.?|127(?:\.\d{1,3}){3}|\[::1\])$/iu` —
   subdomain-prefixed `*.localhost` for dev tenant hosts, bracketed `\[::1\]`
   because `URL.hostname` serializes IPv6 bracketed) set `url.protocol = "http:"`.
2. `presentationSrc(url)`: map **every** parsed target to
   `${location.origin}/dsh-loopback/<scheme>/<host>/<port><path><search>` —
   no on-host native shortcut. Always-relay is deliberate: the relay is the
   one seam where the inspector can be injected resident into every page, so
   arming pick mode never reloads (OpenCode's CDP picker gets the same
   zero-reload arming by owning the webview). Do NOT add a special loopback
   sandbox; keep `render()` at
   `if (current.sandboxed) element.setAttribute("sandbox", WEB_BROWSER_SANDBOX)`.
3. Readable address after in-frame navigation: in `render()`'s load listener,
   read `element.contentWindow.location.href` in a `try`/`catch` and pass it
   through `events.loaded(revision, href)` → `IframeImpl.handleLoaded` →
   an `observed` field → `observedUrl` in `snapshot()`; `BrowserBody` feeds
   `frameAddressDisplay(observedUrl)` (strips the
   `/dsh-loopback/<scheme>/<host>/<port>` prefix via
   `/^\/dsh-loopback\/(https?)\/([^/]+)\/(\d+)(\/.*)?$/`) to the address draft,
   gates the dim class and "page navigated" badge on `observedUrl === void 0`,
   and lets the external-open button use `frame.observedUrl`.

The reference diff's base already contains 1–3 in an earlier hybrid form
(loopback native when the GUI origin was loopback); its third hunk is the
always-relay rewrite, so a pristine bundle gets 1–3 as described above and
the diff still applies conceptually — re-derive positions by content, not
line numbers.

## Install

Wired like any other DSH plugin; the `dsh.bundle.patch` export mounts the
route automatically, no configuration.

1. Add the package to your profile (e.g. `~/.dsh/profiles/<profile>/package.json`):
   `"dsh-loopback-bridge": "github:JanEickholt/dsh-loopback-bridge"`.
2. Add `"dsh-loopback-bridge"` to `dsh.profile.bundles` in the same file.
3. Install (`pnpm install` in the profile directory) and restart the web
   service.
4. Apply the Prerequisites to the Sidebar Browser (source patch if you build
   DSH, host-bundle hunks if you run the installed bundle). Editing the
   installed `client.js` takes effect per request — open windows just need a
   refresh; plugin (`lib/`) changes need the service restart.

## Route

- `/dsh-loopback/<scheme>/<host>/<port><path>` — host form. The request's
  `Host` header is set to `<host>` (plus `:port` unless scheme-default) via an
  explicit `node:http(s)` socket call, because undici silently drops the
  forbidden `host` header. Host-header virtual hosting (`<tenant>.localhost`
  dev subdomains) works through the tab.
- `/dsh-loopback/<scheme>/<port><path>` — legacy hostless form, still served,
  pinned to `127.0.0.1`.
- Upstream redirects are not followed; `Location` responses are rewritten to
  the prefix form (`toProxyLocation`), so absolute public redirects
  (`google.com` → `www.google.com`) stay inside the relay where framing
  restrictions are already stripped.

## Relay behavior

- Every request passes the connection service's browser authentication
  (`admit`, the same gate as `/api`) before anything else.
- `text/html` responses get root-relative URLs rewritten to the prefix
  (`src`, `href`, `srcset`, `poster`, `action`, `data-src`, CSS `url(...)`)
  plus a `<base href="/dsh-loopback/<scheme>/<host>/<port>/">` injection for
  plain relative references. Absolute `http(s)` values in navigation
  attributes (`href`, `action`) map to the relay form too — public pages link
  with absolute URLs, and a native in-frame navigation would die on the
  target's framing restrictions. Absolute subresource URLs (`src`, `srcset`)
  stay native: they are not framed, and proxying them only adds host
  bandwidth. `text/css` bodies get the same `url(...)` rewrite.
- Attribute values are extracted by which quote alternative matched: a
  matched empty `src=""` leaves the other capture `undefined`, and the guard
  must return it unchanged — public pages carry empty URL attributes, and
  feeding `undefined` into the path rewriter throws inside the response,
  which the web server's request guard turns into `res.destroy()` — the frame
  dies with `ERR_EMPTY_RESPONSE` and no server-side trace.
- Served JavaScript (`text/javascript`, `application/javascript`) and inline
  code scripts get root-relative ES module specifiers (`from "/x"`,
  `import "/x"`, `import("/x")`) and root-relative asset-path string literals
  (extension-gated: images, video, fonts) rewritten to the prefix. This is
  what makes Vite/SvelteKit hydration work through the tab: the dev bootstrap
  imports its entry via `import("/@fs/...")`. Every quote-consuming pattern
  is escape-aware: it only opens at an unescaped quote and treats `\…`
  sequences inside the literal as content. Serialized payloads (devalue
  hydration data) embed escaped quotes around URLs inside HTML text
  (`href=\"https://…\"`), and a rewrite that opened there would eat the
  closing escape and turn the inline bootstrap into a `SyntaxError` — spans
  inside such embedded text stay unrewritten; only real string literals are
  rewritten.
- Inline code scripts additionally get **absolute loopback URL literals**
  rewritten to the root-relative relay form (route + target, no origin).
  Server-rendered payloads embed upstream-built absolute loopback URLs, and
  client-side `location.replace(...)` would navigate the frame off the proxy
  to a loopback a remote client cannot reach. Root-relative is deliberate:
  the `Host` header inside the web app is the internal hop, not the external
  origin the client reached, so absolute relay forms would point remote
  clients at a dead loopback — inline scripts resolve against the injected
  `<base>` instead, which is correct on every listener. **Origin-only**
  literals (`http://localhost:5173`, no path) are skipped: they are
  URL-builder inputs (dev toolbars do `new URL(baseOrigin)` and stack
  subdomains onto `base.host`), and rewriting the origin breaks the builder —
  the `__dshNav` wrap catches the runtime navigations built from them. Module
  chunks keep their literals: their values are parsed the same way at runtime.
- The injected helper (`__dshNav`, first `<head>` script) maps every absolute
  `http(s)` URL to the relay form — other origins directly, app-origin ones
  folded back under the current relay prefix (inside a relayed frame every
  app-origin URL is an escaped request, because framework routers resolve
  root-relative links at the origin, load `__data.json` from the GUI origin,
  404, and render their own error page). It also wraps:
  - `fetch` and `EventSource`: root-relative string inputs would otherwise
    resolve against the GUI origin instead of the proxied app; app-origin
    absolute strings fold into the relay. `Request`/`URL` objects pass
    through unchanged.
  - `history.pushState`/`history.replaceState`: client-side routers push the
    origin-resolved URL, which would drag the frame address out of the relay
    and break the prefix extraction every later mapping depends on.
  - `Element.prototype.setAttribute` for URL-shaped attributes (`src`,
    `action`, `poster`, `data-src`, `href` off non-anchor elements): hydrated
    layouts re-set resource attributes at runtime (a root layout rewriting
    `<link href="/theme.css?v=…">` on the first router hop would otherwise
    404 at the GUI origin and silently drop the theme). Anchor `href` stays
    unwrapped on purpose: the router needs the app-relative value to keep
    doing client-side hops.
- Runtime `location` navigations in served JS are wrapped:
  `location.href = <value>` / `location.replace(<value>)` becomes
  `globalThis.__dshNav?.(value) ?? value` (Svelte 5's compiled `$.get(value)`
  call form included). Only a value that ends the assigned expression is
  wrapped: `location.href = next || '/'` or `base + '/x'` stays as written,
  because the wrap's `??` cannot mix with `||`/`&&` and binds looser than `+`.
  Not covered: `window.open`, navigations built through string concatenation
  inside a single expression, and values with call side effects (left
  unwrapped by design). The served app itself stays pristine.
- Only bodies the relay rewrites (`text/html`, `text/css`, JavaScript) are
  buffered, capped at 64 MiB (502 past it, so no upstream can grow the host
  process without bound). Everything else — media, downloads, event
  streams, 206 partial bodies, still-encoded bodies — streams through with
  backpressure and no idle timeout once headers arrived; an upstream failure
  mid-body destroys the client response instead of ending it cleanly, so a
  truncated body is never cached as complete. `GET` with
  `Accept: text/event-stream` gets no idle timeout at all. Client disconnect
  destroys the upstream request, and disposing the plugin (hot reload, stop)
  aborts every exchange still running.
- Rewritten bodies keep their bytes: UTF-8 (declared, or undeclared and
  valid) is decoded as UTF-8, any other declared charset or invalid-UTF-8
  body round-trips through latin1, so legacy-encoded pages do not mojibake.
- Conditional caching: `if-none-match`, `if-modified-since`, and `range` are
  forwarded; `etag`, `last-modified`, `cache-control`, `vary`,
  `content-range`, and `accept-ranges` pass through, with `no-store` forced
  only when upstream sends no policy. Warm tab loads revalidate (304)
  instead of re-downloading the whole dev-server module graph, and media
  elements seek via range instead of re-fetching whole files. The browser caches what the relay
  served under the relay URL — for rewritten HTML that is the rewritten copy.
- Cookies cross the boundary selectively: the request's `Cookie` header is
  forwarded minus the DSH gate cookies (`dsh-auth-*`), and upstream
  `Set-Cookie` responses are rewritten to `Path=/dsh-loopback/...` with
  `Domain` dropped, so per-host dev cookies stay isolated on the app origin
  and keep working across proxied sessions.
- The proxied iframe uses the product's standard sandbox policy
  (`WEB_BROWSER_SANDBOX`), not a hardened one.

## Security model

- Plugin routes on the web origin are otherwise **public** — this route's
  `admit` gate is load-bearing. Unauthenticated requests get 401/403.
- One documented gate exception: the Host/Origin fence rejects `Origin: null`,
  which some fetches from the presentation iframe carry. A 403 on a request
  with exactly `Origin: null` and `Sec-Fetch-Site` `same-origin`, `none`, or
  absent is retried as a full `admit` on the request minus that header, so
  the Host fence (DNS rebinding), the cross-site check, and the cookie check
  under the listener's own protocol all stay authoritative. A `same-site`
  sibling origin (which does carry the SameSite=Strict session cookie) or
  any real foreign `Origin` stays rejected.
- The legacy hostless route form stays pinned to `127.0.0.1`; the host-form
  route resolves `<host>` host-side over DNS for **authenticated** users
  only — the gate is the boundary. That is what lets the tab reach public
  sites (they would otherwise die on `X-Frame-Options`), and it is the same
  trust level as any authenticated server-side fetch the app makes.
- Loopback tabs render with the product-standard sandbox plus `allow-modals`
  (host-bundle hunk), exactly like any other site in the tab.
  A sandbox without `allow-same-origin` is NOT viable here: the opaque origin
  strips cookies, fetch metadata and referer from every subresource, so the
  gate would 403 all assets and no network-side check can tell our sandboxed
  frame from a third-party sandboxed embed.
- Because the relayed frame is same-origin (`allow-same-origin`), a proxied
  dev server's page could script against the app origin — the same trust
  level the tab's "Disable sandbox restrictions" toggle already grants for
  any site.

## Element inspector

An OpenCode-style element picker, dormant in every relayed `text/html` page
(`src/inspector.ts`) and armed from a toolbar **Inspect** toggle in each
Browser tab. Always-relay routing means the inspector is resident before you
arm it, so arming never reloads the page; a frame that somehow predates the
inspector falls back to one relayed reload.

Protocol (both sides correlate by `event.source` plus origin, messages via
`postMessage(payload, location.origin)`):

- parent → frame: `{__dshInspect:'arm'}` / `{__dshInspect:'disarm'}`
- frame → parent: `{__dshInspectReady:true}` (script-exec time — unlocks the
  GUI toolbar and arms pending picks long before the `load` event, which
  media preloading can hold for seconds; also re-arms a stale arm after a
  navigation), `{__dshInspectAck:true}` (arm confirmed), 
  `{__dshInspectSelected:true, selector, xpath, tagName, role, name, text,
  rect:{x,y,width,height}, url, title, viewport:{w,h}}`, or
  `{__dshInspectCancelled:true}`.

Picking inserts a one-line reference into the chat composer:

```
Browser element on <url> (viewport <w>x<h>) — CSS <sel> · XPath <xp> · <label> — 
```

`selector` prefers a unique `#id` (CSS-escaped) and falls back to a structural
`tag:nth-of-type(n)` path trimmed of `html`/`body`; `xpath` is the matching
absolute path. Insertion targets the leftmost visible
`[contenteditable="true"][role="textbox"]` so a side chat panel cannot shadow
the session composer; with no textbox in view it copies to the clipboard.
Escape disarms every armed tab (frame focus is unreachable by mouse once
armed); Ctrl/Cmd+Shift+C toggles the visible tab's Inspect button. The
desktop (Electron webview) carrier has no relay to arm through, so the toggle
is hidden there.

The bridge side (`src/inspector.ts`) is versioned here and needs no re-apply;
only the client hunks live in the host bundle.

## Host-bundle hunks

The hunks of `host-bundle-patches/client.js.inspect.diff` (13 in the file),
grouped in file order — the shape to re-derive when a dsh update replaces
`client.js` (positions by content, not line numbers; the grep guard token is
`dsh-inspect hunk 1/7`):

1. `BrowserBody`: `useInspectArmed(tab.id)` reactivity hook.
2. Toolbar: Inspect toggle between the address box and the external button
   (`IconInspectOutlineRegular`, `aria-pressed`, active reuses the
   tool + `sandboxOff` classes; disabled when reload is). ON: if the live
   frame's inspector has not announced readiness yet, mark the tab pending
   and wait for its `DOMContentLoaded` arming (no reload — reloading would
   restart the load and swallow the user's next click); else arm in place;
   else reload the target through the relay with the tab marked pending.
   OFF: disarm, no navigation.
3. `presentationSrc`: always-relay rewrite (see Prerequisites step 2).
4. Inspect module block near the top of the plugin closure: per-tab state
   (`INSPECT_ARMED`/`INSPECT_PENDING`/`INSPECT_FRAMES`/`INSPECT_ACK` maps),
   `useSyncExternalStore` version counter, `inspectClearAck`, `inspectDisarm`,
   `inspectTryDirectArm` (in-place arm when the frame is already relayed,
   ack-verified with a 700 ms timeout that falls back to a reload-arm),
   `inspectReferenceText`, `inspectComposerInsert` (leftmost visible
   contenteditable, clipboard fallback via a temporary `textarea` +
   `execCommand`), the window `message` listener (origin check, then
   `event.source` correlation; ready → unlock + re-arm, ack → clear timer,
   selected → disarm + insert, cancelled → disarm), and a capture-phase
   window `keydown` (Escape disarms all; Ctrl/Cmd+Shift+C toggles Inspect).
   Desktop guard `INSPECT_ENABLED`; idempotence guard
   `window.__dshInspectPickInstalled`.
5. `BrowserController`: thread `options.tabId` into `createPage` events;
   `dispose` clears the tab's inspect state (armed, pending, frame ref, ack
   timer).
6. `WEB_BROWSER_SANDBOX` gets `allow-modals` appended. Without the token the
   sandboxed frame's `confirm()`/`alert()`/`prompt()` calls are suppressed —
   they return `false`/`undefined` with no dialog, so confirm-gated
   destructive actions appear dead.
7. `IframePresentation.render()`: `INSPECT_FRAMES.set(tabId, element)`, and a
   `frameReady` listener wired both as `element.dshFrameReady` (called by
   the inspector's script-exec-time ready announcement) and as the `load`
   fallback — exactly one trigger runs per navigation. A pending tab arms on
   readiness; any other load clears the armed map (fresh document, dormant
   inspector).
8. `createIframePage`: pass `tabId` into the `IframePresentation` events.
9. Locales `zh`/`en`: append `inspect.enable` / `inspect.disable`
   (`选取页面元素` / `停止选取`, `Inspect element` / `Stop inspecting`).

Baseline shas: pre-inspect base `393bf9df…280d2` (keep a backup
`client.js.bak-pre-inspect` before patching), patched `020d9b97…5c83`.
Picked URLs omit default ports (`https://host/`, not `https://host:443/`) —
normalization lives in `src/inspector.ts` `targetUrl()`.

## Ceilings (deliberate)

- No WebSocket upgrade proxy: Vite HMR does not connect through the tab.
  Reload the Browser tab manually after dev-server code changes.
- Rewritten responses (HTML/CSS/JS) are buffered up to 64 MiB; request
  bodies are buffered and cap at 5 MiB.
- URL rewriting is lexical: unquoted attribute values, protocol-relative
  references (`//host/...`), and template-literal imports
  (`` import(`/${x}`) ``) stay unrewritten and can escape the prefix
  (usually failing as app-origin 404s). URLs inside escaped-quote string
  data (serialized payloads) also stay unrewritten: the link a remote client
  opens points at the raw loopback and fails, but the page stays alive.
- Framework client-navigation leftovers (accepted): after a client-side hop
  SvelteKit's internal `page.url` keeps the GUI-origin form, so components
  reading `$page.url.origin` see the GUI origin (absolute links they build
  are caught by `__dshNav` at runtime, but `page.url`-derived comparisons
  could surprise); `fetch(new Request(...))` objects with app-origin URLs
  pass the wrapper through; runtime `srcset` writes and `setAttributeNS`
  (SVG) stay unwrapped; dev toolbars that match `location.pathname` against
  unprefixed paths may skip their carry-over query params after a
  client-side hop.
- `site.webmanifest` fetches are 401'd by the gate (manifest fetches carry no
  cookie through the sandbox path); PWA install metadata stays broken,
  cosmetic only.

## Development

- `pnpm run build` (tsdown → `lib/`), `pnpm run typecheck`, `pnpm test`
  (`node --test` against the built `lib/`, so build first). The built `lib/`
  is committed so `github:` installs work without a toolchain — rebuild and
  commit it together with `src/` changes.
- Smoke the installed bundle: run `host-bundle-patches/smoke.cjs` from the
  sidebar-browser package's `lib/` directory (see Prerequisites 2).
- Regenerate the reference diff after patching:
  `diff -u client.js.bak-pre-inspect client.js > client.js.inspect.diff`
  in the installed `lib/` directory, then update the patched sha in this
  README.
- Upstream sync check: whether the Sidebar Browser prerequisite landed
  upstream — grep `packages/client/ui-sidebar-browser/src/client/browser/url.ts`
  for the loopback HTTP default (`https://` fallback for schemeless input
  means it has not landed).
- The plugin side is plain TypeScript with no configuration surface; the
  route shape, gate, and rewrite rules are all in `src/index.ts`.

## License

MIT — see [LICENSE](LICENSE).
