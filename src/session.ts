/**
 * One LLM conversation's draft: the graph being built and how to take a step back.
 *
 * Under stdio there is one per process; under HTTP, one per MCP session. Nothing here knows which.
 */

import type { ApplyResult, CodaContract, CodaGraph } from './contract.js'
import type { FetchTracker } from './network.js'

const HISTORY_LIMIT = 100
const SETTLE_MAX_MS = 8_000

export interface SessionOptions {
  siteUrl: string
  /** Present when dataset servers may be contacted. */
  fetches?: FetchTracker
}

export class Session {
  readonly coda: CodaContract
  readonly siteUrl: string
  readonly fetches: FetchTracker | undefined
  graph: CodaGraph
  private readonly history: Array<{ graph: CodaGraph; label: string }> = []

  constructor(coda: CodaContract, options: SessionOptions) {
    this.coda = coda
    this.siteUrl = options.siteUrl
    this.fetches = options.fetches
    this.graph = coda.newGraph()
  }

  /** Start over. Undoable, so a mistaken reset loses nothing. */
  reset(name?: string): void {
    this.remember('start over')
    this.graph = this.coda.newGraph(name)
  }

  /** Apply a plan written as JSON text. The draft changes only if the whole plan applies. */
  apply(planText: string): ApplyResult {
    const parsed = this.coda.parsePlan(planText)
    if (!parsed.ok) return { ok: false, errors: [parsed.error] }
    const result = this.coda.applyPlan(this.graph, parsed.plan)
    // An empty plan hands the same graph back; that is not a step worth undoing.
    if (result.ok && result.graph !== this.graph) {
      this.remember(parsed.plan.summary || 'plan')
      this.graph = result.graph
    }
    return result
  }

  /** Step back one edit, returning what was undone, or undefined when there is nothing. */
  undo(): string | undefined {
    const last = this.history.pop()
    if (!last) return undefined
    this.graph = last.graph
    return last.label
  }

  /**
   * With the network allowed, let the draft's nodes learn what they asked for.
   *
   * Inference answers from what is cached and starts a fetch for what is not. So: check, wait for the
   * requests in flight to finish, and check again — an arrival can make the next question askable, a
   * dataset's schema once its id resolves — until a check starts nothing or the cap passes. Offline
   * there is nothing to wait for, and a draft that has settled costs one check.
   */
  async settle(): Promise<void> {
    if (!this.fetches) return
    const deadline = Date.now() + SETTLE_MAX_MS
    for (;;) {
      this.coda.check(this.graph)
      const left = deadline - Date.now()
      if (this.fetches.pending() === 0 || left <= 0 || !(await this.fetches.idle(left))) return
      // The bodies have arrived; give the code that asked a turn to parse and cache them.
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }

  private remember(label: string): void {
    this.history.push({ graph: this.graph, label })
    if (this.history.length > HISTORY_LIMIT) this.history.shift()
  }
}
