// Regression tests for the relay handler, run against the built lib/:
// `pnpm build && pnpm test`. The webServer/connection services are faked
// with the structural surface the plugin consumes; the fake fence mirrors
// dsh-client-connection's (loopback Host, no cross-site fetch metadata,
// same-authority Origin) in front of a cookie check.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import http from 'node:http'
import { after, before, test } from 'node:test'

import { apply } from '../lib/index.js'

const COOKIE = 'dsh-auth-test=ok'

function fenceAdmit(req) {
  const h = req.headers
  if (!/^127\.0\.0\.1:\d+$/u.test(h.host ?? '')) return { rejection: 403 }
  if (h['sec-fetch-site'] === 'cross-site') return { rejection: 403 }
  if (h.origin !== undefined && h.origin !== `http://${h.host}`) return { rejection: 403 }
  return (h.cookie ?? '').includes(COOKIE) ? { peer: {} } : { rejection: 401 }
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

/** Mount the plugin on a throwaway listener; returns its port and disposer. */
async function mountRelay() {
  let handler
  const disposers = []
  apply({
    get(name) {
      if (name === 'webServer') {
        return {
          register(route) {
            handler = route.handler
            return () => {
              handler = undefined
            }
          },
        }
      }
      if (name === 'connection') {
        return {
          admit: fenceAdmit,
          browserAuth: { isAuthenticated: (req) => (req.headers.cookie ?? '').includes(COOKIE) },
        }
      }
      return undefined
    },
    logger: { warn() {} },
    effect(fn) {
      disposers.push(fn())
    },
  })
  const server = http.createServer((req, res) => {
    if (handler === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    void handler(req, res)
  })
  const port = await listen(server)
  return {
    port,
    dispose: () => {
      for (const dispose of disposers.splice(0)) dispose()
    },
    close: () => {
      server.closeAllConnections()
      server.close()
    },
  }
}

/** Upstream fixtures; each test picks a path. */
const upstreamSeen = []
let holdOpen = []
const upstream = http.createServer((req, res) => {
  upstreamSeen.push({ url: req.url, headers: req.headers })
  if (req.url === '/hello') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('hi')
  } else if (req.url === '/slow-binary') {
    // First chunk now, the rest only when the test releases it.
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': '10' })
    res.write('first')
    holdOpen.push(() => res.end('-last'))
  } else if (req.url === '/broken-binary') {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': '100' })
    res.write('partial')
    setTimeout(() => res.socket.destroy(), 30)
  } else if (req.url === '/latin1') {
    res.writeHead(200, { 'content-type': 'text/html; charset=iso-8859-1' })
    res.end(Buffer.from('<html><head></head><body><img src="/a.png">café</body></html>', 'latin1'))
  } else if (req.url === '/meta-latin1') {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(Buffer.from('<html><head><meta charset="windows-1252"></head><body>naïve</body></html>', 'latin1'))
  } else if (req.url === '/utf8') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<html><head></head><body><img src="/a.png">日本</body></html>')
  } else if (req.url === '/partial.js') {
    res.writeHead(206, { 'content-type': 'text/javascript', 'content-range': 'bytes 0-19/100' })
    res.end('import x from "/a.js"')
  } else if (req.url === '/huge.html') {
    res.writeHead(200, { 'content-type': 'text/html' })
    const chunk = Buffer.alloc(1024 * 1024, 'a')
    let sent = 0
    const pump = () => {
      while (sent < 70) {
        sent++
        if (!res.write(chunk)) {
          res.once('drain', pump)
          return
        }
      }
      res.end()
    }
    res.on('close', () => {
      sent = Number.POSITIVE_INFINITY
    })
    pump()
  } else if (req.url === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: one\n\n')
    holdOpen.push(() => res.end())
    req.on('close', () => upstreamSeen.push({ url: '/events closed' }))
  } else {
    res.writeHead(404)
    res.end()
  }
})

let upstreamPort
let relay

before(async () => {
  upstreamPort = await listen(upstream)
  relay = await mountRelay()
})

after(() => {
  for (const release of holdOpen.splice(0)) release()
  relay.close()
  upstream.closeAllConnections()
  upstream.close()
})

function relayRequest(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        host: '127.0.0.1',
        port: relay.port,
        path: `/dsh-loopback/http/127.0.0.1/${String(upstreamPort)}${path}`,
        headers: { cookie: COOKIE, ...headers },
      },
      resolve,
    )
    req.on('error', reject)
  })
}

async function readAll(res) {
  const chunks = []
  for await (const chunk of res) chunks.push(chunk)
  return Buffer.concat(chunks)
}

test('Origin: null retry admits only our own frame, through the full fence', async () => {
  const ok = await relayRequest('/hello', { origin: 'null', 'sec-fetch-site': 'same-origin' })
  assert.equal(ok.statusCode, 200)
  assert.equal((await readAll(ok)).toString(), 'hi')

  // A same-site sibling origin carries the SameSite=Strict cookie too.
  const sibling = await relayRequest('/hello', { origin: 'null', 'sec-fetch-site': 'same-site' })
  assert.equal(sibling.statusCode, 403)
  sibling.resume()
  // A foreign Origin is not the documented fence artifact.
  const foreign = await relayRequest('/hello', { origin: 'https://evil.example', 'sec-fetch-site': 'same-site' })
  assert.equal(foreign.statusCode, 403)
  foreign.resume()
  // The Host fence (DNS rebinding) still applies on the retry.
  const rebound = await relayRequest('/hello', { origin: 'null', host: `rebind.example:${String(relay.port)}` })
  assert.equal(rebound.statusCode, 403)
  rebound.resume()
  // And so does the cookie check.
  const anonymous = await relayRequest('/hello', { origin: 'null', cookie: '' })
  assert.equal(anonymous.statusCode, 403)
  anonymous.resume()
})

test('identity coding is requested upstream', async () => {
  const res = await relayRequest('/hello')
  await readAll(res)
  const seen = upstreamSeen.findLast((entry) => entry.url === '/hello')
  assert.equal(seen.headers['accept-encoding'], 'identity')
  assert.equal(seen.headers.cookie, undefined, 'dsh-auth-* cookies never travel upstream')
})

test('non-rewritten bodies stream through before upstream finishes', async () => {
  const res = await relayRequest('/slow-binary')
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-length'], '10')
  const [first] = await once(res, 'data')
  assert.equal(first.toString(), 'first')
  holdOpen.shift()()
  assert.equal((await readAll(res)).toString(), '-last')
})

test('an upstream failure mid-body truncates the client response visibly', async () => {
  const res = await relayRequest('/broken-binary')
  assert.equal(res.statusCode, 200)
  await assert.rejects(readAll(res))
})

test('rewritten HTML keeps a declared latin1 charset byte-exact', async () => {
  const res = await relayRequest('/latin1')
  const body = await readAll(res)
  assert.ok(body.includes(Buffer.from('café', 'latin1')), 'é stays the single byte 0xE9')
  assert.ok(body.toString('latin1').includes(`src="/dsh-loopback/http/127.0.0.1/${String(upstreamPort)}/a.png"`))
})

test('undeclared non-UTF-8 bytes round-trip; UTF-8 stays UTF-8', async () => {
  const meta = await readAll(await relayRequest('/meta-latin1'))
  assert.ok(meta.includes(Buffer.from('naïve', 'latin1')))
  const utf8 = await readAll(await relayRequest('/utf8'))
  assert.ok(utf8.toString('utf-8').includes('日本'))
  assert.ok(utf8.toString('utf-8').includes(`src="/dsh-loopback/http/127.0.0.1/${String(upstreamPort)}/a.png"`))
})

test('partial (206) bodies pass through unrewritten', async () => {
  const res = await relayRequest('/partial.js', { range: 'bytes=0-19' })
  assert.equal(res.statusCode, 206)
  assert.equal(res.headers['content-range'], 'bytes 0-19/100')
  assert.equal((await readAll(res)).toString(), 'import x from "/a.js"')
})

test('a rewritable body past the buffer cap fails instead of filling host memory', async () => {
  const res = await relayRequest('/huge.html')
  assert.equal(res.statusCode, 502)
  assert.match((await readAll(res)).toString(), /exceeds/u)
})

test('dispose ends open event streams and their upstream requests', async () => {
  const res = await relayRequest('/events', { accept: 'text/event-stream' })
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'text/event-stream')
  const [first] = await once(res, 'data')
  assert.equal(first.toString(), 'data: one\n\n')
  const ended = new Promise((resolve) => res.on('close', resolve))
  relay.dispose()
  await ended
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(upstreamSeen.some((entry) => entry.url === '/events closed'), 'upstream saw the abort')
  holdOpen = []
})
