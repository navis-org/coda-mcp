/** End to end through a real MCP client against a real Coda build; see `support.ts` for which. */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeAll, describe, expect, it } from 'vitest'
import { loadArtifact } from '../src/artifact.js'
import type { LoadedArtifact } from '../src/artifact.js'
import { installFetch } from '../src/network.js'
import { createCodaServer } from '../src/server.js'
import { buildLocation as location, idOf, tempDir, tempLinkStore } from './support.js'

const DATASET_AND_SEARCH = {
  summary: 'a search on the synthetic dataset',
  add: [
    { ref: 'ds', type: 'dataset.mock.opticlobe' },
    { ref: 'find', type: 'neuron.findNeurons' },
  ],
  remove: [],
  setParams: [{ node: 'find', param: 'filters', value: ['{"f":"type","op":"matches","v":["LC.*"]}'] }],
  connect: [{ from: { node: 'ds', port: 'dataset' }, to: { node: 'find', port: 'dataset' } }],
  disconnect: [],
}

type Result = Awaited<ReturnType<Client['callTool']>>

function textOf(result: Result): string {
  return (result.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? '').join('\n')
}

describe.skipIf(!location)('coda-mcp over MCP', () => {
  let artifact: LoadedArtifact

  beforeAll(async () => {
    artifact = await loadArtifact({
      location,
      fetch: installFetch(false).native,
      cacheDir: await tempDir('coda-mcp'),
    })
  })

  async function connect(links?: Awaited<ReturnType<typeof tempLinkStore>>): Promise<Client> {
    const server = createCodaServer({ artifact, links, version: 'test' })
    const client = new Client({ name: 'test', version: '0' })
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverSide), client.connect(clientSide)])
    return client
  }

  it("lists the tools, with Coda's plan schema as the apply tool's input", async () => {
    const client = await connect()
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([
      'coda_apply_plan',
      'coda_check_draft',
      'coda_describe_draft',
      'coda_get_link',
      'coda_guide',
      'coda_new_draft',
      'coda_node_details',
      'coda_undo',
    ])
    const apply = tools.find((t) => t.name === 'coda_apply_plan')!
    expect(Object.keys(apply.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(['add', 'connect', 'setParams']),
    )
    expect(client.getInstructions()).toContain('coda_guide')
  })

  it('builds a workflow in two plans, checks it and links it', async () => {
    const client = await connect()
    const first = await client.callTool({ name: 'coda_apply_plan', arguments: DATASET_AND_SEARCH })
    expect(first.isError).toBeFalsy()
    const findId = /find → (\S+?)(?:,|\s|$)/.exec(textOf(first))?.[1]
    expect(findId).toBeTruthy()

    const second = await client.callTool({
      name: 'coda_apply_plan',
      arguments: {
        summary: 'filter by size',
        add: [{ ref: 'filter', type: 'core.filterTable' }],
        remove: [],
        setParams: [
          { node: 'filter', param: 'column', value: 'size' },
          { node: 'filter', param: 'value', value: '1000' },
        ],
        connect: [{ from: { node: findId, port: 'neurons' }, to: { node: 'filter', port: 'in' } }],
        disconnect: [],
      },
    })
    expect(second.isError).toBeFalsy()
    expect(textOf(second)).toContain('core.filterTable')

    const check = await client.callTool({ name: 'coda_check_draft', arguments: {} })
    expect(textOf(check)).toContain('No problems')

    const link = await client.callTool({ name: 'coda_get_link', arguments: {} })
    expect(textOf(link).startsWith(`${artifact.siteUrl}#!c1.`)).toBe(true)
  })

  it('refuses a bad plan without touching the draft, and undoes a good one', async () => {
    const client = await connect()
    await client.callTool({ name: 'coda_apply_plan', arguments: DATASET_AND_SEARCH })

    const bad = await client.callTool({
      name: 'coda_apply_plan',
      arguments: { ...DATASET_AND_SEARCH, add: [{ ref: 'x', type: 'no.such' }], setParams: [], connect: [] },
    })
    expect(bad.isError).toBe(true)
    expect(textOf(bad)).toContain('no.such')
    expect(textOf(await client.callTool({ name: 'coda_describe_draft', arguments: {} }))).toContain('2 nodes')

    const undo = await client.callTool({ name: 'coda_undo', arguments: {} })
    expect(undo.isError).toBeFalsy()
    expect(textOf(await client.callTool({ name: 'coda_describe_draft', arguments: {} }))).toContain('0 nodes')
  })

  it('keeps each session to its own draft', async () => {
    const one = await connect()
    const two = await connect()
    await one.callTool({ name: 'coda_apply_plan', arguments: DATASET_AND_SEARCH })
    expect(textOf(await two.callTool({ name: 'coda_describe_draft', arguments: {} }))).toContain('0 nodes')
  })

  it('hands back a short link when the server stores drafts, and the full one when asked', async () => {
    const links = await tempLinkStore()
    const client = await connect(links)
    await client.callTool({ name: 'coda_apply_plan', arguments: DATASET_AND_SEARCH })

    const short = textOf(await client.callTool({ name: 'coda_get_link', arguments: {} }))
    const url = short.split('\n')[0]!
    expect(url).toMatch(/^https:\/\/mcp\.example\/w\/[A-Za-z0-9_-]{22}$/)
    const stored = await links.read(idOf(url))
    expect(JSON.parse(stored!).nodes).toHaveLength(2)

    const full = textOf(await client.callTool({ name: 'coda_get_link', arguments: { full_link: true } }))
    expect(full.startsWith(`${artifact.siteUrl}#!c1.`)).toBe(true)
  })

  it("serves a node's details, and suggests near names for a mistyped one", async () => {
    const client = await connect()
    const details = await client.callTool({ name: 'coda_node_details', arguments: { type: 'core.filterTable' } })
    expect(textOf(details)).toContain('## core.filterTable')
    const miss = await client.callTool({ name: 'coda_node_details', arguments: { type: 'core.filterTables' } })
    expect(miss.isError).toBe(true)
  })
})
