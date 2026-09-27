import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { canonicalHeader, Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '../src/index.ts'
import { estimateMessage } from '../src/estimate.ts'

const fixture = fileURLToPath(new URL('./fixtures/request-files.cordis.yml', import.meta.url))
const worlds: Context[] = []
let root: string | undefined

afterEach(async () => {
  const settled = await Promise.allSettled(worlds.splice(0).map(ctx => ctx.fiber.dispose()))
  if (root !== undefined) {
    settled.push(await rm(root, { recursive: true, force: true }).then(
      () => ({ status: 'fulfilled' as const, value: undefined }),
      (reason: unknown) => ({ status: 'rejected' as const, reason }),
    ))
    root = undefined
  }
  const failures = settled.filter(result => result.status === 'rejected')
  if (failures.length > 0) throw new AggregateError(failures.map(result => result.reason as unknown), 'file pricing fixture cleanup failed')
})

/** Captures the model input after the real LLM runtime projects durable file references. */
class RequestCapture extends LlmAdapter {
  readonly requests: Message[][] = []

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(structuredClone(options.messages))
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function loadWorld(directory: string): Promise<Context> {
  await mkdir(directory, { recursive: true })
  const configPath = join(directory, 'cordis.yml')
  await writeFile(configPath, await readFile(fixture))
  const ctx = new Context()
  worlds.push(ctx)
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  // The source-plane importer keeps the actual plugin exports while the real Loader owns composition and injection.
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-attachment-local', LocalAttachmentStore],
    ['@deepseek-ai/dsh-fs-local', LocalFileSystem],
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-token-meter', TokenMeter],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  expect([...ctx.loader.entries()].filter(entry => !entry.disabled && entry.fiber === undefined)).toEqual([])
  return ctx
}

it('matches emitted file-handle requests after restoring the same log under a different attachment root', async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-meter-files-'))
  const first = await loadWorld(join(root, 'first'))
  const source = Buffer.from('verbatim attachment bytes\n')
  const file = await first.attachments.saveFile({ data: source, name: 'notes.txt' })
  const session = first.sessions.create(SessionId('file-pricing'))
  const message = createUserMessage({ content: [{ type: 'file', attachment: file }], source: { kind: 'user' } })
  session.append('user/message', message, { surfaceOp: 'append' })
  session.append('request/header', { header: canonicalHeader({ config: { provider: 'capture', model: 'files' } }), reason: 'initial' })

  const firstModel = new RequestCapture()
  first.llm.registerAdapter(['capture'], firstModel)
  for await (const _chunk of first.llm.stream({ provider: 'capture', model: 'files', messages: session.deriveMessages() })) { /* drain */ }
  const sent = firstModel.requests[0]?.[0]
  if (sent === undefined) throw new Error('the provider received no file request')
  const path = first.attachments.fileHostPath(file)
  if (path === undefined) throw new Error('the local attachment has no stored path')
  expect(await readFile(path)).toEqual(source)
  expect(sent.content).toHaveLength(1)
  const sentFile = sent.content[0]
  if (sentFile?.type !== 'text') throw new Error('the provider did not receive a text file handle')
  expect(sentFile.text).toContain(JSON.stringify(path))
  expect(sent.content).not.toEqual(message.content)
  const measured = first.tokenMeter.measure(session)
  expect(measured.surfaceTokens).toBe(estimateMessage(sent))
  expect(measured.nodes[0]?.heuristicTokens).toBe(estimateMessage(message))
  const firstProjection = first.sessionProjections.snapshot(session).values.contextBreakdown
  expect(firstProjection?.messageTokens).toBe(estimateMessage(message))

  // Both stores contain the same bytes and durable identity; only the actual read path changes on restore.
  const restoredWorld = await loadWorld(join(root, 'restored-in-a-longer-execution-world'))
  expect(await restoredWorld.attachments.saveFile({ data: source, name: 'notes.txt' })).toEqual(file)
  const restored = Session.create(SessionId('restored-file-pricing'), structuredClone(session.snapshotEvents()))
  const restoredModel = new RequestCapture()
  restoredWorld.llm.registerAdapter(['capture'], restoredModel)
  for await (const _chunk of restoredWorld.llm.stream({
    provider: 'capture', model: 'files', messages: restored.deriveMessages(),
  })) { /* drain */ }
  const resent = restoredModel.requests[0]?.[0]
  if (resent === undefined) throw new Error('the provider received no restored file request')
  expect(resent.content).not.toEqual(sent.content)
  const remeasured = restoredWorld.tokenMeter.measure(restored)
  expect(remeasured.surfaceTokens).toBe(estimateMessage(resent))
  expect(remeasured.surfaceTokens).toBeGreaterThan(measured.surfaceTokens)
  expect(remeasured.nodes[0]?.heuristicTokens).toBe(measured.nodes[0]?.heuristicTokens)
  expect(restoredWorld.sessionProjections.snapshot(restored).values.contextBreakdown).toEqual(firstProjection)
})
