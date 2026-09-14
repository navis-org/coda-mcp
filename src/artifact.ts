/**
 * Finding, downloading, caching and importing Coda's headless build — and noticing a newer one.
 *
 * The build is served beside the app at `<site>/mcp/v1/coda.js`, so every deploy of Coda updates
 * what this server checks graphs against — see Coda's `docs/mcp.md` for why that beats a package.
 * A local path works too (`CODA_ARTIFACT=../coda/dist/mcp/v1/coda.js`), which is how to develop
 * against an unreleased change or work with no network.
 *
 * **A build is identified by a SHA-256 of its bytes.** Coda's `APP_VERSION` does not change between
 * deploys, and the digest needs nothing from Coda to be right.
 *
 * **Each digest is imported under its own URL.** Node caches a module by URL, so re-importing a
 * changed file at the same path hands back the build already running. The cost is that a module
 * cannot be unloaded: every build a process has loaded stays in memory.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CONTRACT_VERSION, REQUIRED_EXPORTS } from './contract.js'
import type { CodaContract } from './contract.js'
import { errorMessage } from './errors.js'
import { appDir, writeAtomic } from './files.js'

export const DEFAULT_ARTIFACT_URL = `https://coda.science/mcp/v${CONTRACT_VERSION}/coda.js`
const DEFAULT_SITE_URL = 'https://coda.science/'

export interface ArtifactOptions {
  /** An https URL, a `file:` URL or a path. Defaults to the deployed build. */
  location?: string
  /** Where links open. Defaults to the site the build was downloaded from. */
  siteUrl?: string
  cacheDir?: string
  /** The real `fetch`, captured before the offline guard replaced the global. */
  fetch: typeof fetch
  timeoutMs?: number
}

export interface LoadedArtifact {
  coda: CodaContract
  location: string
  siteUrl: string
  /** SHA-256 of the file, in hex: what tells one build from another. */
  digest: string
  /** Something the user should hear, such as a stale cache. */
  notice?: string
}

export async function loadArtifact(options: ArtifactOptions): Promise<LoadedArtifact> {
  const location = locationOf(options)
  return importArtifact(location, await readSource(location, options), options)
}

/**
 * The configured build if it differs from `current`, or undefined when it is the same one.
 *
 * Throws when it cannot tell, and the caller keeps what it has. A stale cache is deliberately not an
 * answer here: on a refresh, the cached build is the one already running.
 */
export async function refreshArtifact(
  current: LoadedArtifact,
  options: ArtifactOptions,
): Promise<LoadedArtifact | undefined> {
  const location = locationOf(options)
  const source = await readSource(location, options)
  if (source.notice) throw new Error(source.notice)
  return source.digest === current.digest ? undefined : importArtifact(location, source, options)
}

function locationOf(options: ArtifactOptions): string {
  return options.location?.trim() || DEFAULT_ARTIFACT_URL
}

function isUrl(location: string): boolean {
  return /^https?:\/\//i.test(location)
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

interface Source {
  file: string
  digest: string
  notice?: string
}

async function readSource(location: string, options: ArtifactOptions): Promise<Source> {
  if (isUrl(location)) return download(location, options)
  const file = location.startsWith('file:') ? fileURLToPath(location) : resolve(location)
  return { file, digest: sha256(await readFile(file)) }
}

async function importArtifact(
  location: string,
  source: Source,
  options: ArtifactOptions,
): Promise<LoadedArtifact> {
  const remote = isUrl(location)
  const site = options.siteUrl ?? (remote ? new URL('../../', location).href : DEFAULT_SITE_URL)
  return {
    coda: await importContract(source, location),
    location: remote ? location : source.file,
    // With its trailing slash, once, so nothing that builds a link from it has to ask.
    siteUrl: site.endsWith('/') ? site : `${site}/`,
    digest: source.digest,
    notice: source.notice,
  }
}

interface CacheMeta {
  url: string
  digest: string
  etag?: string
  fetchedAt: string
}

async function download(url: string, options: ArtifactOptions): Promise<Source> {
  const dir = join(options.cacheDir ?? appDir('cache'), `v${CONTRACT_VERSION}`)
  // `.mjs`, because the cache directory has no package.json to say the file is a module.
  const file = join(dir, 'coda.mjs')
  const metaFile = join(dir, 'meta.json')
  const meta = await readMeta(metaFile)
  const cached = meta?.url === url && meta.digest && (await exists(file)) ? meta : undefined

  try {
    const response = await options.fetch(url, {
      headers: cached?.etag ? { 'if-none-match': cached.etag } : {},
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
    })
    if (response.status === 304 && cached) return { file, digest: cached.digest }
    if (!response.ok) throw new Error(`HTTP ${response.status}`)

    const bytes = new Uint8Array(await response.arrayBuffer())
    const digest = sha256(bytes)
    await mkdir(dir, { recursive: true })
    if (digest !== cached?.digest) await writeAtomic(file, bytes)
    const next: CacheMeta = {
      url,
      digest,
      etag: response.headers.get('etag') ?? undefined,
      fetchedAt: new Date().toISOString(),
    }
    await writeAtomic(metaFile, JSON.stringify(next, null, 2))
    return { file, digest }
  } catch (err) {
    const reason = errorMessage(err)
    if (cached) {
      return {
        file,
        digest: cached.digest,
        notice: `Could not refresh Coda from ${url} (${reason}); using the copy cached at ${cached.fetchedAt}, which may not match the live app.`,
      }
    }
    throw new Error(
      `Could not download Coda from ${url} (${reason}). To work without a network, set CODA_ARTIFACT to a local build: dist/mcp/v${CONTRACT_VERSION}/coda.js in a Coda checkout.`,
    )
  }
}

async function importContract(source: Source, location: string): Promise<CodaContract> {
  const url = `${pathToFileURL(source.file).href}?build=${source.digest.slice(0, 16)}`
  const module = (await import(url)) as Record<string, unknown>
  if (module.CONTRACT_VERSION !== CONTRACT_VERSION) {
    throw new Error(
      `This server speaks contract v${CONTRACT_VERSION}, and the Coda build at ${location} is v${String(module.CONTRACT_VERSION)}. Update coda-mcp, or point CODA_ARTIFACT at a v${CONTRACT_VERSION} build.`,
    )
  }
  const missing = REQUIRED_EXPORTS.filter((name) => !(name in module))
  if (missing.length) {
    throw new Error(`The Coda build at ${location} is missing ${missing.join(', ')}.`)
  }
  return module as unknown as CodaContract
}

async function readMeta(file: string): Promise<CacheMeta | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as CacheMeta
  } catch {
    return undefined
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}
