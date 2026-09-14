/**
 * Streamable HTTP at `/mcp`, which is how a hosted instance serves, plus whatever `routes` answers.
 *
 * Each MCP session gets its own server and so its own draft, and sessions idle for an hour are
 * closed. A draft lives in this process's memory, so the instance receives every workflow built
 * through it; the README's Privacy section is what users are told.
 */

import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'

const MAX_BODY_BYTES = 4 * 1024 * 1024
const IDLE_MS = 60 * 60 * 1000
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])

/** Whether a bind address is reachable only from this machine. */
export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host)
}

/** Answers a path other than `/mcp`, returning false when it is not one it handles. */
export type Routes = (req: IncomingMessage, res: ServerResponse, path: string) => Promise<boolean>

export interface HttpOptions {
  host: string
  port: number
  /** Host headers to accept besides loopback, port included: the public name behind a proxy. */
  publicHosts?: string[]
  routes?: Routes
  log: (message: string) => void
}

interface Entry {
  transport: StreamableHTTPServerTransport
  touched: number
}

class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function serveHttp(makeServer: () => Server, options: HttpOptions): Promise<HttpServer> {
  const sessions = new Map<string, Entry>()
  // The SDK compares the whole Host header, port included. Loopback is always accepted: the proxy
  // in front, a health check and a person on the machine all arrive by it.
  const allowedHosts = [
    ...(options.publicHosts ?? []),
    `127.0.0.1:${options.port}`,
    `localhost:${options.port}`,
    `[::1]:${options.port}`,
  ]

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (path !== '/mcp') {
      if (!(await options.routes?.(req, res, path))) res.writeHead(404).end()
      return
    }
    if (req.method !== 'POST' && req.method !== 'GET' && req.method !== 'DELETE') {
      res.writeHead(405, { allow: 'GET, POST, DELETE' }).end()
      return
    }

    const header = req.headers['mcp-session-id']
    const id = Array.isArray(header) ? header[0] : header
    const body = req.method === 'POST' ? await readJson(req) : undefined
    const existing = id ? sessions.get(id) : undefined
    if (existing) {
      existing.touched = Date.now()
      await existing.transport.handleRequest(req, res, body)
      return
    }
    if (id) throw new HttpError(404, 'Session not found.')
    if (!isInitializeRequest(body)) throw new HttpError(400, 'No session: send an initialize request first.')

    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, { transport, touched: Date.now() })
      },
      enableDnsRebindingProtection: true,
      allowedHosts,
    })
    // The one place a session leaves the map: a DELETE, the idle sweep and a dropped connection all
    // close the transport. Set before `connect`, which chains its own handler onto this one.
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId)
    }
    await makeServer().connect(transport)
    await transport.handleRequest(req, res, body)
  }

  const http = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500
      if (status === 500) options.log(`request failed: ${err instanceof Error ? err.stack : String(err)}`)
      if (res.headersSent) {
        res.end()
        return
      }
      const message = err instanceof HttpError ? err.message : 'Internal server error.'
      res
        .writeHead(status, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }))
    })
  })

  setInterval(() => {
    const now = Date.now()
    for (const entry of sessions.values()) {
      if (now - entry.touched >= IDLE_MS) void entry.transport.close()
    }
  }, 60_000).unref()

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(options.port, options.host, () => resolve())
  })

  const shown = options.host.includes(':') ? `[${options.host}]` : options.host
  options.log(`listening on http://${shown}:${options.port}/mcp`)
  if (!isLoopback(options.host) && !options.publicHosts?.length) {
    options.log(
      `bound to ${options.host} with no public host name, so MCP requests are accepted only when addressed to loopback. Set CODA_MCP_PUBLIC_URL, or CODA_MCP_ALLOWED_HOSTS.`,
    )
  }
  return http
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large.')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'Request body is not JSON.')
  }
}
