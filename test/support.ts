/** Shared by the suites: where a real Coda build is, scratch directories, and short links. */

import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DEFAULT_REDIRECT_MAX_CHARS, DEFAULT_REFERRER_MARK, LinkStore } from '../src/links.js'
import type { LinkStoreOptions } from '../src/links.js'

const SIBLING = resolve(import.meta.dirname, '../../coda/dist/mcp/v1/coda.js')

/**
 * `CODA_ARTIFACT` when set — a path, or the deployed URL as CI uses — and otherwise a sibling Coda
 * checkout's build. Undefined skips the suites that need one rather than passing them on a fake,
 * which would only test that this repository agrees with itself.
 */
export const buildLocation: string | undefined =
  process.env.CODA_ARTIFACT || (existsSync(SIBLING) ? SIBLING : undefined)

export function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `${prefix}-`))
}

/** A link store in a scratch directory, answering at `https://mcp.example`. */
export async function tempLinkStore(options: Partial<LinkStoreOptions> = {}): Promise<LinkStore> {
  return new LinkStore({
    dir: await tempDir('coda-links'),
    publicUrl: 'https://mcp.example',
    ttlDays: 0,
    redirectMaxChars: DEFAULT_REDIRECT_MAX_CHARS,
    referrerMark: DEFAULT_REFERRER_MARK,
    ...options,
  })
}

/** The id at the end of a short link. */
export function idOf(link: string): string {
  return link.slice(link.lastIndexOf('/') + 1)
}
