/** Actual native translation carries auxiliary purpose into the governance outbox. */
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { paidFixture } from '../../../packages/experimental/translator/tests/paid-fixture.ts'
import * as Governance from '../src/index.ts'
import type { UsageRecord } from '../src/outbox.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { errors.push(error) }
  }
  if (errors.length) throw new AggregateError(errors, 'Translation billing fixture cleanup failed')
})

it('classifies actual independent native translations in governed usage', async () => {
  const b = await paidFixture(cleanups, { withSessionLog: true })
  const server = createServer((request, response) => { request.resume(); response.writeHead(503).end() })
  cleanups.push(async () => {
    if (!server.listening) return
    const closed = new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve() }))
    server.closeAllConnections()
    await closed
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Translation billing fixture requires loopback TCP')
  await writeFile(join(b.root, 'model-governance.json'), JSON.stringify({ version: 1, defaultAllowed: true,
    userDeclaredAllowed: false, models: [], providers: [], intakeUrl: `http://127.0.0.1:${address.port}/usage`,
    intakeToken: 'translation-fixture-token' }))
  const governance = await b.ctx.plugin(Governance)
  cleanups.push(() => governance.dispose())
  for (const provider of ['deepseek-official', 'deepseek-account'] as const) {
    expect(await b.translate(provider)).toBe('翻译结果')
  }
  const directory = join(b.root, 'model-governance-outbox'), files = await readdir(directory)
  const records = await Promise.all(files.filter(file => file.endsWith('.json')).map(async file =>
    JSON.parse(await readFile(join(directory, file), 'utf8')) as UsageRecord))
  expect(records).toHaveLength(2)
  expect(records.map(record => ({ purpose: record.purpose, status: record.status, usage: record.usage }))).toEqual([
    { purpose: 'translation', status: 'succeeded', usage: { inputTokens: 3, outputTokens: 3, totalTokens: 6 } },
    { purpose: 'translation', status: 'succeeded', usage: { inputTokens: 3, outputTokens: 3, totalTokens: 6 } },
  ])
  expect(b.requests).toHaveLength(2)
  for (const request of b.requests) {
    expect(request.sessionHeader).toBe(false)
    expect(request.body).not.toHaveProperty('dsh_session_log')
    expect(request.body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Original paragraph' }] }])
  }
})
