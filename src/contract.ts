/**
 * Contract v1: what the Coda build at `<site>/mcp/v1/coda.js` exports.
 *
 * Coda's `src/mcp/index.ts` is the source of truth and `src/mcp/contract.test.ts` there pins it;
 * this is the server's statement of what it relies on. The types are deliberately loose where the
 * server only passes a value back to Coda (a graph, a plan) — the server never looks inside one,
 * so describing its shape here would be a second copy of Coda's types to keep in step.
 *
 * Adding an export on Coda's side needs nothing here. Relying on a new one means adding it to
 * `CodaContract`, and the compiler then requires it in `REQUIRED` — which makes the server refuse an
 * older build by name rather than failing on a call.
 */

export const CONTRACT_VERSION = 1

export type CatalogueDetail = 'lean' | 'full'

/** Opaque to the server: made by Coda, handed back to Coda. */
export interface CodaGraph {
  version: number
  nodes: Array<{ id: string; type: string }>
  edges: unknown[]
  meta?: { name?: string }
}

/** Opaque apart from the summary, which labels an undo step. */
export interface AssistantPlan {
  summary: string
}

export interface ApplyWarning {
  nodeId: string
  label: string
  severity: 'error' | 'warning'
  message: string
  aboutColumns?: true
}

export type ApplyResult =
  | { ok: true; graph: CodaGraph; created: Record<string, string>; warnings: ApplyWarning[] }
  | { ok: false; errors: string[] }

export interface CheckResult {
  ok: boolean
  cyclic: string[]
  issues: ApplyWarning[]
}

export interface Credentials {
  neuprint?: string
  cave?: Record<string, string>
}

export interface CodaContract {
  CONTRACT_VERSION: number
  /** Coda's package.json version. Does not change between deploys. */
  APP_VERSION: string
  /** Names the build for people and logs. The server compares builds by digest. */
  BUILD_ID: string
  guide(detail?: CatalogueDetail): string
  nodeTypeIds(): string[]
  nodeEntry(type: string, detail?: CatalogueDetail): string | undefined
  nodeHelp(type: string): Promise<string | undefined>
  planSchema(): Record<string, unknown>
  parsePlan(text: string): { ok: true; plan: AssistantPlan } | { ok: false; error: string }
  newGraph(name?: string): CodaGraph
  applyPlan(graph: CodaGraph, plan: AssistantPlan): ApplyResult
  describe(graph: CodaGraph): string
  check(graph: CodaGraph): CheckResult
  toJson(graph: CodaGraph): string
  shareLink(graph: CodaGraph, siteUrl: string): Promise<string>
  setCredentials(credentials: Credentials): void
}

/** Every member of `CodaContract`, so the compiler keeps this list and the interface in step. */
const REQUIRED: Record<keyof CodaContract, true> = {
  CONTRACT_VERSION: true,
  APP_VERSION: true,
  BUILD_ID: true,
  guide: true,
  nodeTypeIds: true,
  nodeEntry: true,
  nodeHelp: true,
  planSchema: true,
  parsePlan: true,
  newGraph: true,
  applyPlan: true,
  describe: true,
  check: true,
  toJson: true,
  shareLink: true,
  setCredentials: true,
}

/** Checked on load, so an incompatible build is refused with a sentence rather than a TypeError. */
export const REQUIRED_EXPORTS = Object.keys(REQUIRED) as Array<keyof CodaContract>
