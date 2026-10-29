// Shared harness: mounts the built plugin (lib/) on a throwaway GUI listener
// with faked webServer/connection services. The fake fence mirrors
// dsh-client-connection's (loopback Host, no cross-site fetch metadata,
// same-authority Origin) in front of a cookie check.
import assert from 'node:assert/strict'
import http from 'node:http'

import { apply } from '../../lib/index.js'

export const GUI_COOKIE = 'dsh-auth-test=ok'

function fenceAdmit(req) {
  const h = req.headers
  if (!/^127\.0\.0\.1:\d+$/u.test(h.host ?? '')) return { rejection: 403 }
  if (h['sec-fetch-site'] === 'cross-site') return { rejection: 403 }
  if (h.origin !== undefined && h.origin !== `http://${h.host}`) return { rejection: 403 }
  return (h.cookie ?? '').includes(GUI_COOKIE) ? { peer: {} } : { rejection: 401 }
}

export function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

/**
 * Mount the plugin. Returns the GUI port, the relay port (from the injected
 * boot global), the index rows, and disposers.
 */
export async function mountBridge(config = { port: 0 }) {
  let handler
  const disposers = []
  const injectListeners = []
  const gui = http.createServer((req, res) => {
    if (handler === undefined || !new URL(req.url, 'http://x').pathname.startsWith('/dsh-loopback/')) {
      res.writeHead(404)
      res.end()
      return
    }
    void handler(req, res)
  })
  const guiPort = await listen(gui)
  await apply(
    {
      get(name) {
        if (name === 'webServer') {
          return {
            host: '127.0.0.1',
            port: guiPort,
            protocol: 'http:',
            register(route) {
              handler = route.handler
              return () => {
                handler = undefined
              }
            },
          }
        }
        if (name === 'connection') return { admit: fenceAdmit }
        return undefined
      },
      on(name, listener) {
        if (name === 'webserver/index-inject') injectListeners.push(listener)
        return () => true
      },
      logger: { warn() {} },
      effect(fn) {
        const result = fn()
        if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
          return result.then((dispose) => {
            disposers.push(dispose)
          })
        }
        disposers.push(result)
        return undefined
      },
    },
    config,
  )
  const rows = []
  for (const listener of injectListeners) listener(rows)
  const relayRow = rows.find((row) => row.name === '__DSH_LOOPBACK_RELAY__')
  return {
    guiPort,
    relayPort: relayRow?.value.port,
    rows,
    dispose: async () => {
      for (const dispose of disposers.splice(0).reverse()) await dispose?.()
    },
    close: () => {
      gui.closeAllConnections()
      gui.close()
    },
  }
}

/** One raw request; resolves with the response (body unread). */
export function request(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, resolve)
    req.on('error', reject)
    req.end(body)
  })
}

export async function readAll(res) {
  const chunks = []
  for await (const chunk of res) chunks.push(chunk)
  return Buffer.concat(chunks)
}

/**
 * Walk the GUI entry → relay ticket exchange like the browser frame does.
 * @returns the relay session cookie pair and the final relay location.
 */
export async function openRelaySession(bridge, targetPath) {
  const entry = await request(bridge.guiPort, targetPath, { headers: { cookie: GUI_COOKIE } })
  assert.equal(entry.statusCode, 302)
  entry.resume()
  const enterUrl = new URL(entry.headers.location)
  assert.equal(enterUrl.origin, `http://127.0.0.1:${String(bridge.relayPort)}`)
  const enter = await request(bridge.relayPort, `${enterUrl.pathname}${enterUrl.search}`, {
    headers: { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate' },
  })
  assert.equal(enter.statusCode, 302)
  enter.resume()
  const setCookie = enter.headers['set-cookie']?.[0] ?? ''
  assert.match(setCookie, /HttpOnly/u)
  assert.match(setCookie, /SameSite=Strict/u)
  return { cookie: setCookie.split(';', 1)[0], location: enter.headers.location }
}
