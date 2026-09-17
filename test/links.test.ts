/**
 * The short-link store, and its routes served through `serveHttp`'s hook.
 *
 * Requests use `redirect: 'manual'`, since what matters is the status and the `Location` a browser
 * would follow. The Coda build is a stand-in whose `shareLink` is the only thing called: what is under
 * test is the routing and the length rule, and `server.test.ts` makes a short link through the tools
 * against a real build.
 */

import { readdir, utimes } from 'node:fs/promises'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CodaContract, CodaGraph } from '../src/contract.js'
import { serveHttp } from '../src/http.js'
import { LinkStore, linkRoutes, markReferrer } from '../src/links.js'
import { idOf, tempLinkStore } from './support.js'

const SITE = 'https://coda.example/'
const PUBLIC = 'https://mcp.example'

const graph = (name: string): CodaGraph => ({ version: 1, nodes: [], edges: [], meta: { name } })

describe('LinkStore', () => {
  it('stores a draft once under an unguessable id, and reads it back', async () => {
    const links = await tempLinkStore()
    const a = await links.save(graph('a'), '{"a":1}')
    expect(a).toMatch(/^https:\/\/mcp\.example\/w\/[A-Za-z0-9_-]{22}$/)
    expect(await links.save(graph('a'), '{"a":1}')).toBe(a)
    expect(await links.save(graph('b'), '{"b":1}')).not.toBe(a)
    expect(await readdir(links.dir)).toHaveLength(2)
    expect(await links.read(idOf(a))).toBe('{"a":1}')
  })

  it('answers nothing for an unknown id, and never reads outside its directory', async () => {
    const links = await tempLinkStore()
    expect(await links.read('AAAAAAAAAAAAAAAAAAAAAA')).toBeUndefined()
    expect(await links.read('../../../../etc/passwd')).toBeUndefined()
  })

  it('removes only links left unopened past the retention, and nothing without one', async () => {
    const links = await tempLinkStore({ ttlDays: 30 })
    const old = idOf(await links.save(graph('old'), '{}'))
    await links.save(graph('new'), '{}')
    const longAgo = new Date(Date.now() - 31 * 86_400_000)
    await utimes(join(links.dir, `${old}.json`), longAgo, longAgo)

    const forever = new LinkStore({ dir: links.dir, publicUrl: PUBLIC, ttlDays: 0, redirectMaxChars: 1, referrerMark: '' })
    expect(await forever.sweep()).toBe(0)
    expect(await links.sweep()).toBe(1)
    expect(await links.read(old)).toBeUndefined()
    expect(await readdir(links.dir)).toHaveLength(1)
  })
})

describe('short links over HTTP', () => {
  let links: LinkStore
  let server: Server
  let base: string
  let packed = `${SITE}#!c1.short`

  beforeAll(async () => {
    links = await tempLinkStore({ redirectMaxChars: 100 })
    const coda = { shareLink: async () => packed } as unknown as CodaContract
    server = await serveHttp(
      () => {
        throw new Error('MCP is not under test here')
      },
      { host: '127.0.0.1', port: 0, routes: linkRoutes(links, () => ({ coda, siteUrl: SITE })), log: () => {} },
    )
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(() => {
    server.close()
  })

  const get = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { redirect: 'manual', ...init })

  it('redirects a short link to the packed link, and serves its JSON cross-origin', async () => {
    const id = idOf(await links.save(graph('r'), '{"nodes":[]}'))
    const redirect = await get(`/w/${id}`)
    expect(redirect.status).toBe(302)
    // Marked, and before the fragment: a 302 names no referrer of its own, and the fragment is the
    // workflow. `?ref=` is what puts an open through this server in the site's referrer list.
    expect(redirect.headers.get('location')).toBe(`${SITE}?ref=coda-mcp#!c1.short`)

    const json = await get(`/w/${id}.json`)
    expect(json.status).toBe(200)
    expect(json.headers.get('access-control-allow-origin')).toBe('*')
    expect(await json.text()).toBe('{"nodes":[]}')
  })

  it('points a workflow too long to redirect to at its JSON instead', async () => {
    const id = idOf(await links.save(graph('long'), '{}'))
    packed = `${SITE}#!c1.${'x'.repeat(200)}`
    const redirect = await get(`/w/${id}`)
    expect(redirect.headers.get('location')).toBe(`${SITE}?ref=coda-mcp#!${PUBLIC}/w/${id}.json`)
  })

  it('marks a redirect before the fragment, keeps any query the site URL has, and obeys an empty mark', () => {
    expect(markReferrer('https://coda.example/#!c1.x', 'coda-mcp')).toBe('https://coda.example/?ref=coda-mcp#!c1.x')
    expect(markReferrer('https://coda.example/?a=1#!c1.x', 'coda-mcp')).toBe(
      'https://coda.example/?a=1&ref=coda-mcp#!c1.x',
    )
    expect(markReferrer('https://coda.example/#!c1.x', '')).toBe('https://coda.example/#!c1.x')
  })

  it('answers 404 for an unknown link or path, and 405 for a write', async () => {
    expect((await get('/w/AAAAAAAAAAAAAAAAAAAAAA')).status).toBe(404)
    expect((await get('/elsewhere')).status).toBe(404)
    expect((await get('/w/AAAAAAAAAAAAAAAAAAAAAA', { method: 'POST' })).status).toBe(405)
  })
})
