/**
 * Offline by default, the switch that lifts it, and knowing when what a check started has arrived.
 *
 * Asking Coda's build for its catalogue fires requests at CATMAID and Virtual Fly Brain (it infers
 * every node type, and a CATMAID dataset node's inference starts a project listing), and checking a
 * draft that holds a real dataset node starts a listing fetch against that dataset's server. From an
 * LLM session that is traffic on shared production servers nobody asked for. `fetch` is the one thing
 * every one of those requests goes through, so it is replaced before anything calls into the build.
 * See Coda's `docs/mcp.md`.
 */

import type { Credentials } from './contract.js'

export interface Policy {
  /** Whether Coda's code may reach dataset servers. */
  network: boolean
  credentials: Credentials
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on'])
const CAVE_TOKENS_SHAPE = 'CODA_CAVE_TOKENS must be a JSON object mapping a CAVE server URL to a token.'

export function policyFromEnv(env: NodeJS.ProcessEnv): Policy {
  const network = TRUTHY.has((env.CODA_MCP_NETWORK ?? '').trim().toLowerCase())
  // neuprint-python's own variable, so a machine already set up for it needs nothing new.
  const neuprint = env.NEUPRINT_APPLICATION_CREDENTIALS?.trim() || undefined
  return { network, credentials: { neuprint, cave: caveTokens(env.CODA_CAVE_TOKENS) } }
}

function caveTokens(raw: string | undefined): Record<string, string> | undefined {
  if (!raw?.trim()) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(CAVE_TOKENS_SHAPE)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(CAVE_TOKENS_SHAPE)
  return Object.fromEntries(
    Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}

/** Requests Coda's code has in flight, so a check can wait for what it started. */
export interface FetchTracker {
  pending(): number
  /** Resolves true once nothing is in flight, or false if `ms` passes first. */
  idle(ms: number): Promise<boolean>
}

export interface Fetches {
  /** The real `fetch`, which the server keeps for downloading Coda itself. */
  native: typeof fetch
  /** Present only when the network is allowed. */
  tracker?: FetchTracker
}

/**
 * Replace the global `fetch`: refusing every request when the network is off, counting them when it
 * is on.
 */
export function installFetch(network: boolean): Fetches {
  const native = globalThis.fetch.bind(globalThis)

  if (!network) {
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      throw new TypeError(
        `coda-mcp is offline, so ${url} was not requested. Set CODA_MCP_NETWORK=1 to let dataset nodes fetch their schemas.`,
      )
    }) as typeof fetch
    return { native }
  }

  let inFlight = 0
  let waiters: Array<() => void> = []
  const finished = () => {
    if (--inFlight > 0) return
    for (const wake of waiters) wake()
    waiters = []
  }

  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    inFlight++
    let response: Response
    try {
      response = await native(...args)
    } catch (err) {
      finished()
      throw err
    }
    // Counted until the body has arrived rather than the headers, since the caller learns nothing
    // until it has parsed the body. A copy is drained for that, leaving the response untouched.
    void drain(response.clone()).finally(finished)
    return response
  }) as typeof fetch

  return {
    native,
    tracker: {
      pending: () => inFlight,
      idle: (ms) =>
        inFlight === 0
          ? Promise.resolve(true)
          : new Promise((resolve) => {
              const timer = setTimeout(() => resolve(false), ms)
              waiters.push(() => {
                clearTimeout(timer)
                resolve(true)
              })
            }),
    },
  }
}

async function drain(response: Response): Promise<void> {
  const reader = response.body?.getReader()
  if (!reader) return
  try {
    while (!(await reader.read()).done) {
      // Discarded: only the end of the body matters here.
    }
  } catch {
    // The caller reads the same failure from its own copy.
  }
}
