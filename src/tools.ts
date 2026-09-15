/**
 * The tools, independent of transport.
 *
 * Every tool is a thin wording layer over one call into Coda's build. What a node is, what a plan
 * may say, what a card complains about and how a link is packed are all answered there — this file
 * only decides how to say it to a model.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ApplyWarning, CheckResult } from './contract.js'
import type { LinkStore } from './links.js'
import type { Session } from './session.js'

export interface Tool {
  name: string
  description: string
  inputSchema: { type: 'object'; [key: string]: unknown }
  run(args: Record<string, unknown>): Promise<CallToolResult>
}

/** Above this many nodes a successful plan reports counts, and the listing is a separate call. */
const INLINE_LISTING_MAX_NODES = 25

function reply(text: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text }], isError }
}

const NO_ARGS = { type: 'object', properties: {}, additionalProperties: false } as const

export function buildTools(session: Session, links?: LinkStore): Tool[] {
  const { coda } = session
  return [
    {
      name: 'coda_guide',
      description:
        "Read before the first edit. Coda's own rules for writing a plan, then the catalogue of every node type with its ports and params. `lean` omits most param help; use coda_node_details for one node's full help.",
      inputSchema: {
        type: 'object',
        properties: { detail: { type: 'string', enum: ['lean', 'full'], default: 'lean' } },
        additionalProperties: false,
      },
      async run(args) {
        const detail = args.detail === 'full' ? 'full' : 'lean'
        return reply(`${guidePreface(session)}\n\n---\n\n${coda.guide(detail)}`)
      },
    },
    {
      name: 'coda_node_details',
      description:
        "One node type's full catalogue entry, with every param's help, followed by its documentation. Use it before configuring a node whose params are not obvious.",
      inputSchema: {
        type: 'object',
        properties: { type: { type: 'string', description: 'A node type id, e.g. core.filterTable.' } },
        required: ['type'],
        additionalProperties: false,
      },
      async run(args) {
        const type = String(args.type ?? '').trim()
        const entry = coda.nodeEntry(type, 'full')
        if (!entry) {
          const word = type.split('.').pop()?.toLowerCase() ?? ''
          const near = word
            ? coda.nodeTypeIds().filter((id) => id.toLowerCase().includes(word)).slice(0, 12)
            : []
          return reply(
            `There is no node type "${type}".${near.length ? ` Similar: ${near.join(', ')}.` : ' coda_guide lists every type.'}`,
            true,
          )
        }
        const help = await coda.nodeHelp(type)
        return reply(help ? `${entry}\n\n---\n\n${help}` : entry)
      },
    },
    {
      name: 'coda_new_draft',
      description:
        'Start an empty workflow draft, discarding the current one (coda_undo brings it back). A session starts with an empty draft, so this is only needed to start over.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'The workflow name shown in Coda.' } },
        additionalProperties: false,
      },
      async run(args) {
        session.reset(String(args.name ?? '').trim() || undefined)
        return reply(`Started an empty draft named "${session.graph.meta?.name}".`)
      },
    },
    {
      name: 'coda_apply_plan',
      description:
        'Edit the draft with a plan: nodes to add, params to set, wires to make or cut, nodes to remove. The plan is applied whole or refused whole, and a refusal names every problem. Existing nodes are named by the ids coda_describe_draft shows; new ones by refs you invent in this plan.',
      inputSchema: coda.planSchema() as Tool['inputSchema'],
      async run(args) {
        const result = session.apply(JSON.stringify(args))
        if (!result.ok) {
          return reply(
            ['Refused, so nothing was applied. Problems:', ...result.errors.map((e) => `- ${e}`)].join('\n'),
            true,
          )
        }
        await session.settle()
        const lines = ['Applied.']
        const created = Object.entries(result.created)
        if (created.length) lines.push(`Created: ${created.map(([ref, id]) => `${ref} → ${id}`).join(', ')}`)
        if (result.warnings.length) {
          lines.push('', 'Warnings on the nodes this plan touched:', ...result.warnings.map(warningLine))
        }
        lines.push('')
        const { nodes, edges } = session.graph
        if (nodes.length <= INLINE_LISTING_MAX_NODES) {
          lines.push('The draft now:', coda.describe(session.graph))
        } else {
          lines.push(
            `The draft now has ${nodes.length} nodes and ${edges.length} wires. Call coda_describe_draft for the listing.`,
          )
        }
        return reply(lines.join('\n'))
      },
    },
    {
      name: 'coda_describe_draft',
      description:
        'The draft as it stands: every node id and type, the columns each output carries, params that differ from their defaults, the options a param offers as wired, every wire, and every problem the cards would show.',
      inputSchema: NO_ARGS,
      async run() {
        await session.settle()
        const { graph } = session
        const name = graph.meta?.name ? ` "${graph.meta.name}"` : ''
        const header = `Draft${name}: ${graph.nodes.length} nodes, ${graph.edges.length} wires.`
        return reply(`${header}\n\n${coda.describe(graph)}\n\n${checkText(coda.check(graph))}`)
      },
    },
    {
      name: 'coda_check_draft',
      description:
        'Every problem the cards in Coda would show for the draft, errors first. Checking does not run the workflow: it catches wiring, types, missing params and columns that are known before any data arrives.',
      inputSchema: NO_ARGS,
      async run() {
        await session.settle()
        const result = coda.check(session.graph)
        return reply(checkText(result), !result.ok)
      },
    },
    {
      name: 'coda_undo',
      description: 'Step the draft back by one edit.',
      inputSchema: NO_ARGS,
      async run() {
        const undone = session.undo()
        return reply(undone ? `Undid: ${undone}.` : 'Nothing to undo.', !undone)
      },
    },
    {
      name: 'coda_get_link',
      description: `A link that opens the draft in Coda. Give it to the user exactly as returned. Check the draft first; a link to a draft with errors opens with those cards marked.${
        links ? ' The link is short, and stores the draft on this server.' : ''
      }`,
      inputSchema: {
        type: 'object',
        properties: {
          include_json: {
            type: 'boolean',
            default: false,
            description: 'Also return the workflow as a .coda.json document.',
          },
          ...(links
            ? {
                full_link: {
                  type: 'boolean',
                  default: false,
                  description:
                    'Return the long link that carries the workflow itself, which never expires and stores nothing here, instead of the short one.',
                },
              }
            : {}),
        },
        additionalProperties: false,
      },
      async run(args) {
        if (session.graph.nodes.length === 0) {
          return reply('The draft is empty, so there is nothing to link to.', true)
        }
        await session.settle()
        const errors = coda.check(session.graph).issues.filter((i) => i.severity === 'error').length
        const short = links && args.full_link !== true
        // Once: serialising stamps the time, so a second call would not match what was stored.
        const json = coda.toJson(session.graph)
        const lines = [
          short ? await links.save(session.graph, json) : await coda.shareLink(session.graph, session.siteUrl),
          '',
          `Checked against Coda build ${coda.BUILD_ID}. Dataset queries wait for the user to press Run.`,
        ]
        if (short) {
          const expiry = links.ttlDays ? `, and removed after ${links.ttlDays} days without being opened` : ''
          lines.push(`The workflow is stored on this server behind the short link${expiry}.`)
        }
        if (errors) lines.push(`The draft still has ${errors} error${errors === 1 ? '' : 's'}; see coda_check_draft.`)
        if (args.include_json === true) lines.push('', json)
        return reply(lines.join('\n'))
      },
    },
  ]
}

/**
 * The one fact about this server the guide cannot know. Coda frames the guide itself for a model
 * working through tools; this server once re-read Coda's in-app wording in a preface, which a model
 * rightly flagged as a tool result rewriting instructions.
 */
function guidePreface(session: Session): string {
  return session.fetches
    ? 'Network access is on: dataset nodes can learn their real columns, which may take a moment after an edit.'
    : "Network access is off: nodes on a real dataset cannot learn that dataset's columns, so their `carries:` lines may be missing. Treat a missing line as unknown, as the guide says. The synthetic dataset (dataset.mock.opticlobe) is fully checkable."
}

function warningLine(warning: ApplyWarning): string {
  const note = warning.aboutColumns ? ' (a column not known yet; often fine before the input has run)' : ''
  return `- ${warning.nodeId} (${warning.label}) ${warning.severity}: ${warning.message}${note}`
}

function checkText(result: CheckResult): string {
  if (result.ok && result.issues.length === 0) {
    return 'No problems: every node is wired and configured as far as can be checked without running it.'
  }
  const errors = result.issues.filter((i) => i.severity === 'error')
  const warnings = result.issues.filter((i) => i.severity === 'warning')
  const lines: string[] = []
  if (result.cyclic.length) lines.push(`Cycle through: ${result.cyclic.join(', ')}`)
  if (errors.length) lines.push(`Errors (${errors.length}):`, ...errors.map(warningLine))
  if (warnings.length) lines.push(`Warnings (${warnings.length}):`, ...warnings.map(warningLine))
  return lines.join('\n')
}
