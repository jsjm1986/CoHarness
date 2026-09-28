/** Test-only Client transport: one provider failure, then a page that never answers. */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

export const name = 'client-inspect-timeout-fixture'
export const inject = ['cordisInspect', 'agents', 'llm']

/**
 * Mirror a Client manifest and deliver only the first query's failure.
 * @param {import('@deepseek-ai/cordis').Context} ctx - isolated snapshot Host.
 */
export function apply(ctx) {
  const expected = readFileSync(process.env.DSH_SNAPSHOT_FILE, 'utf8').trim().split('\n')
    .map(line => JSON.parse(line))
    .filter(event => event.type === 'tool/result')
    .map(event => event.data.message)
  const resultFields = message => ({
    toolCallId: message.toolCallId,
    content: message.content,
    isError: message.isError,
  })
  let requests = 0
  ctx.on('llm/stream', (options, next) => {
    assert.deepEqual(
      options.messages.filter(message => message.role === 'tool').map(resultFields),
      expected.slice(0, requests++).map(resultFields),
      'Each continuing model request receives the recorded Client timeout errors',
    )
    return next()
  })
  ctx.cordisInspect.syncClientManifest([{
    id: 'Service',
    description: 'Snapshot Client Service provider.',
    methods: [{
      name: 'listService',
      description: 'Inspect one Client Service.',
      inputSchema: {
        type: 'object',
        properties: { service: { type: 'string' } },
        additionalProperties: false,
      },
      outputSchema: { type: 'object' },
    }],
  }])
  let queries = 0
  ctx.on('cordis/inspect-query', (request) => {
    if (++queries !== 1) return
    const agent = ctx.agents.get(request.agentId)
    if (agent === undefined) throw new Error('Client inspect request has no owning Agent')
    ctx.cordisInspect.resolveClientQuery(agent, request.requestId, {
      ok: false,
      reason: 'provider-error',
      message: 'no catalogued Service named "remote"',
    })
  })
}
