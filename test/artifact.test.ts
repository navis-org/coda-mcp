/**
 * Loading and refreshing a Coda build: by digest, from a path, and over HTTP with an ETag.
 *
 * Uses a copy of a real build rather than a stand-in module, because part of what is under test is
 * Node handing back a *fresh* module instance for changed bytes — which a fake that exports the same
 * object twice would pass. The build comes from `support.ts`; a URL is downloaded first, so CI's
 * deployed build is exercised too.
 */

import { createHash } from 'node:crypto'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { loadArtifact, refreshArtifact } from '../src/artifact.js'
import type { LoadedArtifact } from '../src/artifact.js'
import { installFetch } from '../src/network.js'
import { FreshArtifact } from '../src/refresh.js'
import { buildLocation as location, tempDir } from './support.js'

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

describe.skipIf(!location)('loading and refreshing a build', () => {
  let native: typeof fetch
  let original: Buffer

  beforeAll(async () => {
    // Loading a build fires requests at dataset servers; none of these tests wants them.
    native = installFetch(false).native
    original = /^https?:/i.test(location!)
      ? Buffer.from(await (await native(location!)).arrayBuffer())
      : await readFile(location!)
  })

  async function copyOfBuild(): Promise<string> {
    const file = join(await tempDir('coda-build'), 'coda.mjs')
    await writeFile(file, original)
    return file
  }

  it('reloads a local build only when its bytes change, as a new module instance', async () => {
    const file = await copyOfBuild()
    const options = { location: file, fetch: native }
    const first = await loadArtifact(options)
    expect(first.digest).toBe(sha256(original))
    expect(typeof first.coda.BUILD_ID).toBe('string')

    expect(await refreshArtifact(first, options)).toBeUndefined()

    await appendFile(file, '\n// a later deploy\n')
    const next = await refreshArtifact(first, options)
    expect(next).toBeDefined()
    expect(next!.digest).not.toBe(first.digest)
    expect(next!.coda).not.toBe(first.coda)
    expect(next!.coda.nodeTypeIds()).toEqual(first.coda.nodeTypeIds())
  })

  it('asks with the ETag over HTTP and loads a changed build once', async () => {
    let body = original
    const seen: string[] = []
    const server = createServer((req, res) => {
      const etag = `"${sha256(body).slice(0, 16)}"`
      seen.push(req.headers['if-none-match'] ?? '-')
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304).end()
        return
      }
      res.writeHead(200, { etag, 'content-type': 'text/javascript' }).end(body)
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const { port } = server.address() as AddressInfo
    const firstEtag = `"${sha256(original).slice(0, 16)}"`

    try {
      const options = {
        location: `http://127.0.0.1:${port}/mcp/v1/coda.js`,
        cacheDir: await tempDir('coda-cache'),
        fetch: native,
      }
      const first = await loadArtifact(options)
      expect(first.siteUrl).toBe(`http://127.0.0.1:${port}/`)

      expect(await refreshArtifact(first, options)).toBeUndefined()

      body = Buffer.concat([original, Buffer.from('\n// a later deploy\n')])
      const next = await refreshArtifact(first, options)
      expect(next?.digest).toBe(sha256(body))
      expect(seen).toEqual(['-', firstEtag, firstEtag])
    } finally {
      server.close()
    }
  })

  it('keeps the running build when a check fails, and prepares a newer one once', async () => {
    const file = await copyOfBuild()
    const first = await loadArtifact({ location: file, fetch: native })
    const logs: string[] = []
    const prepared: LoadedArtifact[] = []
    const log = (message: string) => logs.push(message)
    const prepare = (artifact: LoadedArtifact) => prepared.push(artifact)

    const broken = new FreshArtifact(first, {
      artifact: { location: join(tmpdir(), 'no-such-build.mjs'), fetch: native },
      prepare,
      log,
    })
    expect(await broken.check()).toBe(false)
    expect(broken.current).toBe(first)
    expect(logs[0]).toContain('could not check')

    const fresh = new FreshArtifact(first, { artifact: { location: file, fetch: native }, prepare, log })
    await appendFile(file, '\n// a later deploy\n')
    const [a, b] = await Promise.all([fresh.check(), fresh.check()])
    expect([a, b]).toEqual([true, true])
    expect(prepared).toEqual([fresh.current])
    expect(fresh.current).not.toBe(first)
    expect(await fresh.check()).toBe(false)
  })
})
