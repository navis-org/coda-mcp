/**
 * Keeping a long-lived server on the current Coda build.
 *
 * A hosted server runs for days, so it asks again periodically; a stdio server needs none of this,
 * its client relaunching it about once per conversation. Every build a process loads stays in memory,
 * since Node cannot unload a module, so a hosted instance wants an occasional restart.
 *
 * A newer build goes to sessions created after it arrives; an open session keeps the build its draft
 * was checked against, since its model has already read that build's catalogue. See Coda's
 * `docs/mcp.md`.
 */

import { refreshArtifact } from './artifact.js'
import type { ArtifactOptions, LoadedArtifact } from './artifact.js'
import { errorMessage } from './errors.js'

export interface FreshOptions {
  artifact: ArtifactOptions
  /**
   * Readies a newly loaded build before any session can see it. Credentials, in practice: each
   * loaded copy of the build has its own token store.
   */
  prepare: (artifact: LoadedArtifact) => void
  log: (message: string) => void
}

export class FreshArtifact {
  current: LoadedArtifact
  private readonly options: FreshOptions
  private pending: Promise<boolean> | undefined

  constructor(initial: LoadedArtifact, options: FreshOptions) {
    this.current = initial
    this.options = options
  }

  /** Check every `intervalMs`, each wait starting when the last check ends. Zero or less never checks. */
  start(intervalMs: number): void {
    if (intervalMs <= 0) return
    const tick = () => void this.check().finally(() => setTimeout(tick, intervalMs).unref())
    setTimeout(tick, intervalMs).unref()
  }

  /** Whether a newer build is now current. Calls made while one check is running share it. */
  check(): Promise<boolean> {
    this.pending ??= this.refresh().finally(() => {
      this.pending = undefined
    })
    return this.pending
  }

  private async refresh(): Promise<boolean> {
    let next: LoadedArtifact | undefined
    try {
      next = await refreshArtifact(this.current, this.options.artifact)
    } catch (err) {
      this.options.log(`could not check for a newer Coda build: ${errorMessage(err)}`)
      return false
    }
    if (!next) return false
    this.options.prepare(next)
    // The digest beside the id: two builds of one modified tree share a commit and differ only there.
    const name = (artifact: LoadedArtifact) => `${artifact.coda.BUILD_ID} [${artifact.digest.slice(0, 8)}]`
    this.options.log(
      `Coda build ${name(this.current)} → ${name(next)}; new sessions use it, open ones keep theirs`,
    )
    this.current = next
    return true
  }
}
