// Origin isolation: the GUI origin only redirects; relayed content, its
// session, header forwarding, and the WebSocket relay live on the relay
// listener. Run against the built lib/.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import http from 'node:http'
import { after, before, test } from 'node:test'

import { apply } from '../lib/index.js'
import { GUI_COOKIE, listen, mountBridge, openRelaySession, readAll, request } from './helpers/harness.mjs'

const seen = []
const upstream = http.createServer((req, res) => {
  seen.push({ url: req.url, method: req.method, headers: req.headers })
  if (req.url === '/page') {
    res.writeHead(200, {
      'content-type': 'text/html',
      'set-cookie': ['sid=1; Path=/', 'dsh-auth-evil=x; Path=/', 'dsh-relay-1=x'],
    })
    res.end('<html><head></head><body><a href="/next">n</a></body></html>')
  } else if (req.url === '/form') {
    // SvelteKit's CSRF rule: a form POST must carry the app's own origin.
    const own = `http://${req.headers.host}`
    res.writeHead(req.headers.origin === own ? 200 : 403, { 'content-type': 'text/plain' })
    res.end(req.headers.origin === own ? 'accepted' : 'Cross-site POST form submissions are forbidden')
  } else {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
  }
})
// Minimal WebSocket upstream: accept, then send one unmasked text frame.
upstream.on('upgrade', (req, socket) => {
  seen.push({ url: req.url, upgrade: true, headers: req.headers })
  const accept = createHash('sha1')
    .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64')
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )
  socket.write(Buffer.concat([Buffer.from([0x81, 5]), Buffer.from('hello')]))
})

let upstreamPort
let bridge
let session
let base

before(async () => {
  upstreamPort = await listen(upstream)
  bridge = await mountBridge()
  base = `/dsh-loopback/http/127.0.0.1/${String(upstreamPort)}`
  session = await openRelaySession(bridge, `${base}/page`)
})

after(async () => {
  await bridge.dispose()
  bridge.close()
  upstream.closeAllConnections()
  upstream.close()
})

const relayOrigin = () => `http://127.0.0.1:${String(bridge.relayPort)}`
const guiOrigin = () => `http://127.0.0.1:${String(bridge.guiPort)}`

function relayRequest(path, init = {}) {
  return request(bridge.relayPort, path, { ...init, headers: { cookie: session.cookie, ...(init.headers ?? {}) } })
}

test('the relay listens on its own origin and the GUI boot page learns its port', () => {
  assert.equal(typeof bridge.relayPort, 'number')
  assert.notEqual(bridge.relayPort, bridge.guiPort)
  assert.deepEqual(
    bridge.rows.find((row) => row.name === '__DSH_LOOPBACK_RELAY__'),
    { kind: 'global', name: '__DSH_LOOPBACK_RELAY__', value: { port: bridge.relayPort } },
  )
})

test('the GUI origin serves no relayed content: it only redirects with a ticket', async () => {
  const entry = await request(bridge.guiPort, `${base}/page?q=1`, { headers: { cookie: GUI_COOKIE } })
  assert.equal(entry.statusCode, 302)
  assert.equal((await readAll(entry)).length, 0)
  const location = new URL(entry.headers.location)
  assert.equal(location.origin, relayOrigin())
  assert.equal(location.pathname, '/dsh-loopback/__enter')
  assert.equal(seen.filter((entry) => entry.url === '/page?q=1').length, 0, 'nothing fetched upstream yet')

  const post = await request(bridge.guiPort, `${base}/form`, { method: 'POST', headers: { cookie: GUI_COOKIE } })
  assert.equal(post.statusCode, 405)
  post.resume()
  const anonymous = await request(bridge.guiPort, `${base}/page`)
  assert.equal(anonymous.statusCode, 401)
  anonymous.resume()
})

test('the ticket exchange lands on the target and sets a relay-scoped session', async () => {
  assert.equal(session.location, `${base}/page`)
  const tampered = await request(bridge.relayPort, '/dsh-loopback/__enter?t=e30.AAAA')
  assert.equal(tampered.statusCode, 401)
  tampered.resume()
})

test('relay requests need the relay session; the GUI cookie alone is not one', async () => {
  const none = await request(bridge.relayPort, `${base}/x`, { headers: { cookie: GUI_COOKIE } })
  assert.equal(none.statusCode, 401)
  none.resume()
  const forged = await request(bridge.relayPort, `${base}/x`, {
    headers: { cookie: `${session.cookie.split('=')[0]}=eyJndWkiOiJ4IiwiZXhwIjo5OTk5OTk5OTk5OTk5fQ.AAAA` },
  })
  assert.equal(forged.statusCode, 401)
  forged.resume()
  // A shadowing cookie with the same name sent first does not lock the user out.
  const shadowed = await request(bridge.relayPort, `${base}/x`, {
    headers: { cookie: `${session.cookie.split('=')[0]}=junk; ${session.cookie}` },
  })
  assert.equal(shadowed.statusCode, 200)
  shadowed.resume()
})

test('relay fence: other origins on the same host may navigate, never fetch or post', async () => {
  const cases = [
    [{ origin: guiOrigin(), 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors' }, 403],
    [{ 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'no-cors' }, 403],
    [{ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' }, 403],
    [{ 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate' }, 200],
    [{ origin: relayOrigin(), 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }, 200],
  ]
  for (const [headers, status] of cases) {
    const res = await relayRequest(`${base}/x`, { headers })
    assert.equal(res.statusCode, status, JSON.stringify(headers))
    res.resume()
  }
  const sameSitePost = await relayRequest(`${base}/form`, {
    method: 'POST',
    headers: { origin: guiOrigin(), 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate' },
  })
  assert.equal(sameSitePost.statusCode, 403)
  sameSitePost.resume()
})

test('relayed HTML names the GUI origin as its only message partner', async () => {
  const res = await relayRequest(`${base}/page`)
  const html = (await readAll(res)).toString()
  assert.ok(html.includes(`globalThis.__dshParentOrigin="${guiOrigin()}"`))
  // Reserved cookie names never reach the browser; others are path-scoped.
  assert.deepEqual(res.headers['set-cookie'], [`sid=1; Path=${base}`])
})

test('upstream sees its own Origin/Referer, the user agent, and no relay cookies', async () => {
  const res = await relayRequest(`${base}/form`, {
    method: 'POST',
    headers: {
      origin: relayOrigin(),
      referer: `${relayOrigin()}${base}/page?a=1`,
      'user-agent': 'TestBrowser/1.0',
      'content-type': 'application/x-www-form-urlencoded',
      cookie: `${session.cookie}; dsh-auth-x=1; dsh-relay-9=2; app=3`,
      'sec-fetch-site': 'same-origin',
    },
    body: 'a=1',
  })
  assert.equal(res.statusCode, 200)
  assert.equal((await readAll(res)).toString(), 'accepted')
  const hit = seen.findLast((entry) => entry.url === '/form')
  assert.equal(hit.headers.origin, `http://127.0.0.1:${String(upstreamPort)}`)
  assert.equal(hit.headers.referer, `http://127.0.0.1:${String(upstreamPort)}/page?a=1`)
  assert.equal(hit.headers['user-agent'], 'TestBrowser/1.0')
  assert.equal(hit.headers.cookie, 'app=3')

  const foreignRef = await relayRequest(`${base}/x`, { headers: { referer: `${guiOrigin()}/secret/path` } })
  foreignRef.resume()
  await new Promise((resolve) => foreignRef.on('end', resolve))
  assert.equal(seen.findLast((entry) => entry.url === '/x').headers.referer, undefined)
})

test('the route tail is the normalized pathname, as the web server matched it', async () => {
  const res = await relayRequest(`/elsewhere/..${base}/x`)
  assert.equal(res.statusCode, 200)
  res.resume()
  const absolute = await relayRequest(`http://127.0.0.1:${String(bridge.relayPort)}${base}/x`)
  assert.equal(absolute.statusCode, 200)
  absolute.resume()
})

test('escaped root-relative requests return under their referrer\'s prefix', async () => {
  const res = await request(bridge.relayPort, '/src/main.ts?v=2', {
    headers: { referer: `${relayOrigin()}${base}/page` },
  })
  assert.equal(res.statusCode, 307)
  assert.equal(res.headers.location, `${base}/src/main.ts?v=2`)
  res.resume()
  const orphan = await request(bridge.relayPort, '/src/main.ts')
  assert.equal(orphan.statusCode, 404)
  orphan.resume()
})

function upgrade(headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: bridge.relayPort,
      path: `${base}/hmr?token=t`,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-protocol': 'vite-hmr',
        ...headers,
      },
    })
    req.on('upgrade', (res, socket, head) => resolve({ status: 101, res, socket, head }))
    req.on('response', (res) => {
      res.resume()
      resolve({ status: res.statusCode })
    })
    req.on('error', reject)
    req.end()
  })
}

test('WebSocket upgrades relay to the target with its own origin', async () => {
  const ok = await upgrade({ cookie: session.cookie, origin: relayOrigin() })
  assert.equal(ok.status, 101)
  const frame = ok.head.length >= 7 ? ok.head : await new Promise((resolve) => ok.socket.once('data', resolve))
  assert.equal(frame.subarray(2, 7).toString(), 'hello')
  ok.socket.destroy()
  const hit = seen.findLast((entry) => entry.upgrade === true)
  assert.equal(hit.url, '/hmr?token=t')
  assert.equal(hit.headers.origin, `http://127.0.0.1:${String(upstreamPort)}`)
  assert.equal(hit.headers['sec-websocket-protocol'], 'vite-hmr')
  assert.equal(hit.headers.cookie, undefined)

  assert.equal((await upgrade({ origin: relayOrigin() })).status, 401)
  assert.equal((await upgrade({ cookie: session.cookie, origin: guiOrigin() })).status, 403)
})

test('wildcard relay bind addresses are refused', async () => {
  const ctx = {
    get: (name) =>
      name === 'webServer'
        ? { register: () => () => {}, host: '127.0.0.1', port: 1, protocol: 'http:' }
        : { admit: () => ({ peer: {} }) },
    on: () => () => true,
    logger: { warn() {} },
    effect: () => undefined,
  }
  await assert.rejects(apply(ctx, { host: '0.0.0.0' }), /concrete IP address/u)
  await assert.rejects(apply(ctx, { host: '::' }), /concrete IP address/u)
  await assert.rejects(apply(ctx, { origin: 'http://x/path' }), /bare http\(s\) origin/u)
})
