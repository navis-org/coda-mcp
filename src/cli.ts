#!/usr/bin/env node
/**
 * `coda-mcp`: `--http` serves Streamable HTTP, which is how a hosted instance runs; with no flags it
 * serves stdio, for development and for a client that launches the process itself.
 */

import { createRequire } from 'node:module'
import { parseArgs } from 'node:util'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { loadArtifact } from './artifact.js'
import type { ArtifactOptions, LoadedArtifact } from './artifact.js'
import { errorMessage } from './errors.js'
import { isLoopback, serveHttp } from './http.js'
import { DEFAULT_REDIRECT_MAX_CHARS, DEFAULT_REFERRER_MARK, LinkStore, linkRoutes } from './links.js'
import { installFetch, policyFromEnv } from './network.js'
import { FreshArtifact } from './refresh.js'
import { createCodaServer } from './server.js'

const DEFAULT_REFRESH_MINUTES = 10

const USAGE = `Usage: coda-mcp [--http [--host 127.0.0.1] [--port 8787]]

  --http      serve MCP over Streamable HTTP at /mcp, and short links at /w/
  (no flags)  serve MCP over stdio, for a client that launches this process

Environment:
  CODA_MCP_PUBLIC_URL               where this server is reached from outside; turns on short links
  CODA_MCP_LINK_DIR                 where short links are stored (default: ~/.local/share/coda-mcp/links)
  CODA_MCP_LINK_TTL_DAYS            remove a short link unopened for this many days (default: 0, keep)
  CODA_MCP_REDIRECT_MAX_CHARS       longest packed link a short link redirects to (default: ${DEFAULT_REDIRECT_MAX_CHARS})
  CODA_MCP_REFERRER_MARK            ?ref= a short link's redirect carries, so opens through this
                                    server are countable (default: ${DEFAULT_REFERRER_MARK}; empty = none)
  CODA_MCP_ALLOWED_HOSTS            comma-separated Host headers to accept besides loopback
                                    (default: the public URL's host)
  CODA_MCP_REFRESH_MINUTES          how often to check for a newer Coda build (default: ${DEFAULT_REFRESH_MINUTES}; 0 = never)
  CODA_ARTIFACT                     Coda build to load: URL or path (default: the deployed one)
  CODA_SITE_URL                     where links open (default: the site the build came from)
  CODA_MCP_CACHE                    cache directory (default: ~/.cache/coda-mcp)
  CODA_MCP_NETWORK=1                let dataset nodes contact their servers (default: off)
  NEUPRINT_APPLICATION_CREDENTIALS  neuPrint token, used only with the network on
  CODA_CAVE_TOKENS                  JSON object of CAVE server URL -> token, network on only
`

function log(message: string): void {
  process.stderr.write(`coda-mcp: ${message}\n`)
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number, not "${raw}".`)
  }
  return value
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      http: { type: 'boolean', default: false },
      host: { type: 'string', default: '127.0.0.1' },
      port: { type: 'string', default: '8787' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  if (values.help) {
    process.stdout.write(USAGE)
    return
  }

  // Under stdio, stdout is the protocol, so nothing Coda's build prints may reach it.
  if (!values.http) console.log = console.info = console.debug = console.error

  const { version } = createRequire(import.meta.url)('../package.json') as { version: string }
  const policy = policyFromEnv(process.env)
  // Before anything calls into Coda's build, which is what makes requests.
  const fetches = installFetch(policy.network)
  const artifactOptions: ArtifactOptions = {
    location: process.env.CODA_ARTIFACT,
    siteUrl: process.env.CODA_SITE_URL,
    cacheDir: process.env.CODA_MCP_CACHE,
    fetch: fetches.native,
  }
  // Every loaded copy of the build has its own token store, a refreshed one included.
  const prepare = (loaded: LoadedArtifact) => {
    if (policy.network) loaded.coda.setCredentials(policy.credentials)
  }

  const artifact = await loadArtifact(artifactOptions)
  if (artifact.notice) log(artifact.notice)
  prepare(artifact)
  log(
    `Coda build ${artifact.coda.BUILD_ID} (${artifact.coda.APP_VERSION}) from ${artifact.location}; network ${policy.network ? 'on' : 'off'}`,
  )

  if (!values.http) {
    const server = createCodaServer({ artifact, fetches: fetches.tracker, version })
    await server.connect(new StdioServerTransport())
    return
  }

  const port = Number(values.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`--port must be a port number, not "${values.port}".`)
  }
  const fresh = new FreshArtifact(artifact, { artifact: artifactOptions, prepare, log })
  fresh.start(numberFromEnv('CODA_MCP_REFRESH_MINUTES', DEFAULT_REFRESH_MINUTES) * 60_000)

  const publicUrl = process.env.CODA_MCP_PUBLIC_URL?.trim() || undefined
  const links = publicUrl
    ? new LinkStore({
        dir: process.env.CODA_MCP_LINK_DIR?.trim() || undefined,
        publicUrl,
        ttlDays: numberFromEnv('CODA_MCP_LINK_TTL_DAYS', 0),
        redirectMaxChars: numberFromEnv('CODA_MCP_REDIRECT_MAX_CHARS', DEFAULT_REDIRECT_MAX_CHARS),
        // `??`, not `||`: an empty setting is how an operator turns the marker off.
        referrerMark: process.env.CODA_MCP_REFERRER_MARK?.trim() ?? DEFAULT_REFERRER_MARK,
      })
    : undefined
  if (links) {
    links.startSweep(log)
    log(
      `short links at ${links.publicUrl}/w/, stored in ${links.dir}, ${links.ttlDays ? `removed after ${links.ttlDays} days unopened` : 'kept forever'}`,
    )
    if (!links.publicUrl.startsWith('https://')) {
      log('CODA_MCP_PUBLIC_URL is not https: a workflow too long to redirect to cannot be opened, since Coda fetches only https links.')
    }
  } else {
    log('CODA_MCP_PUBLIC_URL is not set, so links are full packed links rather than short ones.')
  }

  if (policy.network && (publicUrl || !isLoopback(values.host))) {
    log("network access is on for an instance others can reach: every user's drafts reach dataset servers from this machine, with its tokens.")
  }

  const listed = process.env.CODA_MCP_ALLOWED_HOSTS?.split(',')
    .map((host) => host.trim())
    .filter(Boolean)
  const publicHosts = listed?.length ? listed : publicUrl ? [new URL(publicUrl).host] : undefined

  // `fresh.current` is read per session and per redirect, so a newer build reaches both.
  await serveHttp(
    () => createCodaServer({ artifact: fresh.current, fetches: fetches.tracker, links, version }),
    {
      host: values.host,
      port,
      publicHosts,
      routes: links ? linkRoutes(links, () => fresh.current) : undefined,
      log,
    },
  )
}

main().catch((err: unknown) => {
  log(errorMessage(err))
  process.exit(1)
})
