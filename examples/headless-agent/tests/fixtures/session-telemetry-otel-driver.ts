#!/usr/bin/env node
/**
 * Test driver: start a mock OTLP/HTTP collector, boot the telemetry Loader
 * composition against it, run one credential-bearing turn, explicitly share
 * feedback, then run a second private turn before persisting everything the
 * collector captured to `./otlp-captures.json` for the e2e's inspect step.
 */

import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { gunzipSync } from 'node:zlib'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { recordFeedback } from '@deepseek-ai/dsh-command-feedback'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'
import { agentEvents } from '@deepseek-ai/dsh-agent'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('session-telemetry-otel driver requires a config path')

const captures: unknown[] = []
const server = createServer((request, response) => {
  const chunks: Buffer[] = []
  request.on('data', chunk => chunks.push(chunk as Buffer))
  request.on('end', () => {
    const body = Buffer.concat(chunks)
    const decoded = request.headers['content-encoding'] === 'gzip' ? gunzipSync(body) : body
    captures.push(JSON.parse(decoded.toString()))
    response.writeHead(200, { 'content-type': 'application/json' }).end('{}')
  })
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const address = server.address()
if (address === null || typeof address === 'string') throw new Error('collector has no port')
process.env.DSH_TELEMETRY_E2E_URL = `http://127.0.0.1:${address.port}/v1/logs`

const ctx = await boot('telemetry-otel-e2e', resolveConfigPath(configPath, undefined))
try {
  // The fixture credential rides the model-visible user message; the exported
  // copy must scrub it while the canonical log keeps the original bytes.
  await runFixtureTurn(ctx, { task: 'prove telemetry with key sk-e2efixture1234567890' })
  const [agent] = ctx.get('agents')?.roots() ?? []
  if (agent === undefined) throw new Error('session-telemetry-otel driver requires one root agent')
  if (process.env.DSH_TELEMETRY_E2E_FEEDBACK !== 'none') {
    recordFeedback(agent.session, { text: 'fixture feedback' })
  }
  await runFixtureTurn(ctx, { task: 'post-feedback private suffix' })
  agentEvents(ctx, agent).emit('agent/error', { turn: 2, step: 1, error: new Error('private operational error') })
} finally {
  await ctx.fiber.dispose()
}
await writeFile('./otlp-captures.json', JSON.stringify(captures))
server.close()
server.closeAllConnections()
