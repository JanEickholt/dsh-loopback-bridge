/**
 * Relay-origin credentials. Relayed pages live on the bridge's own listener
 * (a separate origin), so they cannot carry the GUI's `dsh-auth-*` session
 * into the GUI's API. The GUI-origin entry route (gated by the connection
 * service) mints a short-lived signed ticket; the relay listener trades it
 * for its own HttpOnly session cookie and authenticates every relayed
 * request with that cookie alone.
 *
 * The HMAC secret lives on `globalThis` so a plugin hot reload keeps
 * existing relay sessions valid; a process restart rotates it.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const SECRET_KEY = Symbol.for('dsh-loopback-bridge.relay-secret')

/** Ticket lifetime: one redirect hop. */
export const TICKET_TTL_MS = 60_000

/** Relay session lifetime; an expired session asks for a tab reload. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Cookie names the relay owns or guards; never forwarded, never settable by upstreams. */
export const RESERVED_COOKIE_RE = /^dsh-(?:auth|relay)-/iu

function secret(): Buffer {
  const holder = globalThis as unknown as Record<symbol, Buffer | undefined>
  holder[SECRET_KEY] ??= randomBytes(32)
  return holder[SECRET_KEY]
}

function mac(kind: string, body: string): string {
  return createHmac('sha256', secret()).update(`${kind}.${body}`).digest('base64url')
}

function sign(kind: string, payload: object): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return `${body}.${mac(kind, body)}`
}

function verify(kind: string, token: string): Record<string, unknown> | undefined {
  const dot = token.indexOf('.')
  if (dot === -1) return undefined
  const body = token.slice(0, dot)
  const expected = Buffer.from(mac(kind, body))
  const actual = Buffer.from(token.slice(dot + 1))
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined
  try {
    const payload: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (typeof payload !== 'object' || payload === null) return undefined
    const record = payload as Record<string, unknown>
    if (typeof record.exp !== 'number' || record.exp <= Date.now()) return undefined
    return record
  } catch {
    return undefined
  }
}

/** One relay hop: the relay path to open and the GUI origin that framed it. */
export interface Ticket {
  to: string
  gui: string
}

export function mintTicket(ticket: Ticket): string {
  return sign('ticket', { ...ticket, exp: Date.now() + TICKET_TTL_MS })
}

export function readTicket(token: string): Ticket | undefined {
  const record = verify('ticket', token)
  if (record === undefined || typeof record.to !== 'string' || typeof record.gui !== 'string') return undefined
  return { to: record.to, gui: record.gui }
}

/** A relay session remembers the GUI origin inspector messages go to. */
export interface Session {
  gui: string
}

export function mintSession(session: Session): string {
  return sign('session', { ...session, exp: Date.now() + SESSION_TTL_MS })
}

/**
 * Session cookie name, keyed by relay port: cookies are scoped per host,
 * not per port, so two bridges on one host must not overwrite each other.
 */
export function sessionCookieName(port: number): string {
  return `dsh-relay-${String(port)}`
}

/**
 * Find a valid session among every cookie of that name. A page on any port
 * of the same host can plant a same-named cookie with a longer path (which
 * the browser sends first); checking each candidate keeps the real one
 * usable.
 */
export function readSession(cookieHeader: string | undefined, name: string): Session | undefined {
  if (cookieHeader === undefined) return undefined
  for (const segment of cookieHeader.split(';')) {
    const eq = segment.indexOf('=')
    if (eq === -1 || segment.slice(0, eq).trim() !== name) continue
    const record = verify('session', segment.slice(eq + 1).trim())
    if (record !== undefined && typeof record.gui === 'string') return { gui: record.gui }
  }
  return undefined
}
