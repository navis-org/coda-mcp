/**
 * Short links: a draft stored under its content hash, opened through a redirect.
 *
 * - `save` names a draft by 22 base64url characters of SHA-256 over the draft object, so asking twice
 *   is one entry, and an id cannot be guessed without the workflow.
 * - `/w/<id>` redirects to the packed `#!c1.` link, or, past `redirectMaxChars`, to Coda's
 *   `#!https://` form naming `/w/<id>.json`, which Coda fetches after asking the recipient.
 * - Both redirect targets carry `?ref=<referrerMark>`, which is the only thing that can say an open
 *   came from here; see `markReferrer`.
 * - Links are kept forever unless `ttlDays` is set, and opening one counts as use.
 *
 * Why each of those, and what the threshold protects against, is recorded under "Short links" in
 * Coda's `docs/mcp.md`.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import type { CodaContract, CodaGraph } from './contract.js'
import { errorMessage } from './errors.js'
import { appDir, writeAtomic } from './files.js'
import type { Routes } from './http.js'

const ID = /^[A-Za-z0-9_-]{22}$/
const DAY_MS = 86_400_000
const SWEEP_EVERY_MS = 3_600_000

/** Kept under the proxy's response-header buffer, which the README's nginx block sets to 32k. */
export const DEFAULT_REDIRECT_MAX_CHARS = 16_000

/** What a redirect names itself as in the site's analytics. Empty turns the marker off. */
export const DEFAULT_REFERRER_MARK = 'coda-mcp'

export interface LinkStoreOptions {
  /** Defaults to `~/.local/share/coda-mcp/links`. */
  dir?: string
  /** Where this server is reached from outside, e.g. `https://mcp.example.org`. */
  publicUrl: string
  /** Remove a link not opened for this many days. Zero keeps links forever. */
  ttlDays: number
  redirectMaxChars: number
  /** The `?ref=` a redirect carries; empty sends the target no marker at all. */
  referrerMark: string
}

export class LinkStore {
  readonly dir: string
  readonly publicUrl: string
  readonly ttlDays: number
  readonly redirectMaxChars: number
  readonly referrerMark: string

  constructor(options: LinkStoreOptions) {
    this.dir = options.dir ?? join(appDir('data'), 'links')
    this.publicUrl = new URL(options.publicUrl).href.replace(/\/+$/, '')
    this.ttlDays = options.ttlDays
    this.redirectMaxChars = options.redirectMaxChars
    this.referrerMark = options.referrerMark
  }

  /** Store a draft as its `.coda.json`, returning its short link. The same draft is the same link. */
  async save(graph: CodaGraph, json: string): Promise<string> {
    const id = createHash('sha256').update(JSON.stringify(graph)).digest('base64url').slice(0, 22)
    const file = this.fileFor(id)
    try {
      await touch(file)
    } catch {
      await mkdir(this.dir, { recursive: true })
      await writeAtomic(file, json)
    }
    return `${this.publicUrl}/w/${id}`
  }

  /** The stored `.coda.json`, counting the read as use; undefined for an unknown or malformed id. */
  async read(id: string): Promise<string | undefined> {
    if (!ID.test(id)) return undefined
    const file = this.fileFor(id)
    try {
      const json = await readFile(file, 'utf8')
      await touch(file)
      return json
    } catch {
      return undefined
    }
  }

  /**
   * Remove links not opened for `ttlDays`, returning how many went. With no retention it removes
   * nothing, which is what stops a sweep reading "older than zero days" as every link there is.
   */
  async sweep(now = Date.now()): Promise<number> {
    if (this.ttlDays <= 0) return 0
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch {
      return 0
    }
    let removed = 0
    for (const name of names) {
      const file = join(this.dir, name)
      try {
        if (now - (await stat(file)).mtimeMs < this.ttlDays * DAY_MS) continue
        await rm(file, { force: true })
        removed++
      } catch {
        // Gone already, or opened and rewritten mid-sweep; either way nothing to remove.
      }
    }
    return removed
  }

  /** Sweep now and hourly. */
  startSweep(log: (message: string) => void): void {
    if (this.ttlDays <= 0) return
    const run = () =>
      this.sweep().then(
        (removed) => removed && log(`removed ${removed} short link${removed === 1 ? '' : 's'} unused for ${this.ttlDays} days`),
        (err: unknown) => log(`could not sweep short links: ${errorMessage(err)}`),
      )
    void run()
    setInterval(() => void run(), SWEEP_EVERY_MS).unref()
  }

  private fileFor(id: string): string {
    return join(this.dir, `${id}.json`)
  }
}

async function touch(file: string): Promise<void> {
  const now = new Date()
  await utimes(file, now, now)
}

/**
 * `https://coda.science/?ref=coda-mcp#!c1.…` — where an open through this server says so.
 *
 * **A 302 does not name the host that sent it.** A browser carries the referrer of the *original*
 * navigation through a redirect, so `/w/<id>` never reaches the site's analytics: an open from a
 * chat client arrives with no referrer at all, one from a browser tab arrives as that tab's origin,
 * and both read exactly like a pasted link. The query parameter is the only channel left, and it is
 * the documented one — GoatCounter reads `ref`, `src`, `source` or `utm_source` and falls back to
 * the HTTP referrer, which is the convention every other analytics follows too.
 *
 * It goes **before the fragment**, which is where the workflow is: the fragment never leaves the
 * browser, and a marker appended after it would be part of the packed graph rather than a query.
 * Nothing in Coda reads `location.search`, so this is inert to the app that receives it — and it is
 * the redirect only: `full_link` reaches no server and carries no marker, which leaves that escape
 * hatch exactly as it was for anybody who wants no trace of their workflow anywhere.
 */
export function markReferrer(url: string, mark: string): string {
  if (!mark) return url
  const cut = url.indexOf('#')
  const head = cut === -1 ? url : url.slice(0, cut)
  const fragment = cut === -1 ? '' : url.slice(cut)
  return `${head}${head.includes('?') ? '&' : '?'}ref=${encodeURIComponent(mark)}${fragment}`
}

/**
 * `GET /w/<id>` and `GET /w/<id>.json`, and `HEAD` for both. Answers false for any other path.
 *
 * `current` is read per request, so a redirect is packed by the Coda build this server holds now.
 */
export function linkRoutes(store: LinkStore, current: () => { coda: CodaContract; siteUrl: string }): Routes {
  return async (req, res, path) => {
    const match = /^\/w\/([^/]+?)(\.json)?$/.exec(path)
    if (!match) return false
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end()
      return true
    }
    const [, id = '', asJson] = match
    const json = await store.read(id)
    if (json === undefined) {
      res
        .writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        .end('There is no workflow at this link. It may have expired.\n')
      return true
    }
    if (asJson) {
      // Coda reads this cross-origin, and sends no credentials. Node sends no body for a HEAD.
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }).end(json)
      return true
    }
    const { coda, siteUrl } = current()
    const mark = store.referrerMark
    const packed = markReferrer(await coda.shareLink(JSON.parse(json) as CodaGraph, siteUrl), mark)
    // Measured after marking: what the proxy's header buffer has to hold is the header sent.
    const location =
      packed.length <= store.redirectMaxChars
        ? packed
        : markReferrer(`${siteUrl}#!${store.publicUrl}/w/${id}.json`, mark)
    res.writeHead(302, { location, 'cache-control': 'no-cache' }).end()
    return true
  }
}
