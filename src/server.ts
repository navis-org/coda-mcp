/**
 * One MCP server per session, with the tools bound to that session's draft.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { LoadedArtifact } from './artifact.js'
import { errorMessage } from './errors.js'
import type { LinkStore } from './links.js'
import type { FetchTracker } from './network.js'
import { Session } from './session.js'
import { buildTools } from './tools.js'

export interface CodaServerOptions {
  artifact: LoadedArtifact
  /** Present when dataset servers may be contacted. */
  fetches?: FetchTracker
  /** Present on a hosted instance: links are short and the draft is stored here. */
  links?: LinkStore
  version: string
}

export function createCodaServer(options: CodaServerOptions): Server {
  const { artifact } = options
  const session = new Session(artifact.coda, { siteUrl: artifact.siteUrl, fetches: options.fetches })
  const tools = buildTools(session, options.links)
  const byName = new Map(tools.map((tool) => [tool.name, tool]))

  const server = new Server(
    { name: 'coda-mcp', version: options.version },
    { capabilities: { tools: {} }, instructions: instructions(options) },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name)
    if (!tool) {
      return { content: [{ type: 'text', text: `Unknown tool "${request.params.name}".` }], isError: true }
    }
    try {
      return await tool.run(request.params.arguments ?? {})
    } catch (err) {
      return { content: [{ type: 'text', text: `coda-mcp failed: ${errorMessage(err)}` }], isError: true }
    }
  })

  return server
}

function instructions({ artifact, fetches }: CodaServerOptions): string {
  return [
    `Coda (${artifact.siteUrl}) is a node-graph editor for connectome analysis. These tools build a Coda workflow as a draft and hand back a link that opens it in the app. They do not run workflows or query data.`,
    '',
    'To build one:',
    '1. Call coda_guide once. It holds the rules for writing a plan and the catalogue of every node type.',
    '2. Edit the draft in steps with coda_apply_plan. Use coda_node_details before configuring a node whose params are not obvious.',
    '3. Call coda_check_draft and fix what it reports.',
    '4. Call coda_get_link and give the user the link.',
    '',
    `Coda build ${artifact.coda.BUILD_ID} (version ${artifact.coda.APP_VERSION}). Network access to dataset servers is ${fetches ? 'on' : 'off'}.`,
    ...(artifact.notice ? ['', artifact.notice] : []),
  ].join('\n')
}
