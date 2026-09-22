import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime, LlmAdapter, createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmImageRequestPricing, Message, StreamChunk, TokenUsage, UserMessage } from '@deepseek-ai/dsh-llm'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { Session, SessionId, canonicalHeader } from '@deepseek-ai/dsh-session'
import type { EpochHeader } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { estimateContent, estimateMessage } from '../src/estimate.ts'

/** Adapter double declaring fixed per-occurrence image prices for one route. */
class PricingAdapter extends LlmAdapter {
  constructor(private readonly pricing: (model: string) => LlmImageRequestPricing | undefined) {
    super()
  }

  override imageRequestPricing(_provider: string, model: string): LlmImageRequestPricing | undefined {
    return this.pricing(model)
  }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('the pricing adapter double does not stream')
  }
}

const VISUAL_TOKENS = 100
const HANDLE_TEXT = 'Image handle text'

const fixedPricing: LlmImageRequestPricing = {
  priceImages: images => images.map(() => ({ visualTokens: VISUAL_TOKENS, text: HANDLE_TEXT })),
}

function imageRef(name: string): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(`sha256:${name.padEnd(8, '0')}`),
    mediaType: 'image/png',
    bytes: 2048,
    width: 800,
    height: 800,
    name,
  }
}

function imageMessage(name: string, text = 'look at this'): UserMessage {
  return createUserMessage({
    content: [
      { type: 'text', text },
      { type: 'image', attachment: imageRef(name) },
    ],
    source: { kind: 'user' },
  })
}

function header(model: string): EpochHeader {
  return canonicalHeader({ config: { provider: 'mock', model } })
}

interface Harness {
  ctx: Context
  llm: LlmRuntime
  meter: TokenMeter
  session: Session
}

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

async function harness(pricing: (model: string) => LlmImageRequestPricing | undefined): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  new SessionProjectionRegistry(ctx)
  const llm = new LlmRuntime(ctx)
  llm.registerAdapter(['mock'], new PricingAdapter(pricing))
  const meter = new TokenMeter(ctx)
  return { ctx, llm, meter, session: Session.create(SessionId('route-priced')) }
}

/** Route price of one image-bearing message under the fixed pricing double. */
function routedMessageTokens(message: Message): number {
  const imageFree = estimateMessage({
    ...message,
    content: message.content.filter(block => block.type !== 'image'),
  })
  return imageFree + VISUAL_TOKENS + estimateContent([{ type: 'text', text: HANDLE_TEXT }])
}

function appendSuccessfulCall(session: Session, value: EpochHeader, usage?: TokenUsage): void {
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/header', { header: value, reason: 'initial' })
  session.append('assistant/message', {
    stream: [],
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'answer' }],
      source: { kind: 'model', provider: value.config.provider, model: value.config.model },
    }),
    ...usage === undefined ? {} : { usage },
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
}

describe('route-aware image pricing', () => {
  it('prices a first multimodal request estimate with the routed visual tokens', async () => {
    const { meter, session } = await harness(() => fixedPricing)
    const message = imageMessage('photo')
    session.append('user/message', message, { surfaceOp: 'append' })
    session.append('request/header', { header: header('vision'), reason: 'initial' })

    const measurement = meter.measure(session)
    const expectedNode = routedMessageTokens(message)
    expect(measurement.nodes).toHaveLength(1)
    const node = measurement.nodes[0]!
    expect(node.tokens).toBe(expectedNode)
    expect(node.heuristicTokens).toBe(estimateMessage(message))
    expect(node.tokens).toBeGreaterThan(node.heuristicTokens)
    expect(measurement.baseline.kind).toBe('estimated')
    expect(measurement.surfaceTokens).toBe(expectedNode)
    expect(measurement.totalTokens).toBe(expectedNode)
  })

  it('adds a post-anchor image at its routed price on top of provider usage', async () => {
    const { meter, session } = await harness(() => fixedPricing)
    const usage: TokenUsage = { inputTokens: 5000, outputTokens: 50 }
    appendSuccessfulCall(session, header('vision'), usage)
    const before = meter.measure(session)
    expect(before.baseline).toMatchObject({ kind: 'usage', tokens: 5050 })

    const message = imageMessage('fresh')
    session.append('user/message', message, { surfaceOp: 'append' })
    const after = meter.measure(session)
    expect(after.baseline).toMatchObject({ kind: 'usage', tokens: 5050 })
    expect(after.surfaceDeltaTokens - before.surfaceDeltaTokens).toBe(routedMessageTokens(message))
    expect(after.totalTokens).toBe(5050 + after.surfaceDeltaTokens)
  })

  it('reprices the surface under the substitution pricing of a text-only route', async () => {
    const placeholder = '[image omitted for the text-only route]'
    const substitution: LlmImageRequestPricing = {
      priceImages: images => images.map(() => ({ visualTokens: 0, text: placeholder })),
    }
    const { meter, session } = await harness(model => (model === 'vision' ? fixedPricing : substitution))
    const message = imageMessage('photo')
    session.append('user/message', message, { surfaceOp: 'append' })
    session.append('request/header', { header: header('vision'), reason: 'initial' })

    const textOnly = meter.measure(session, header('text-only'))
    const imageFree = estimateMessage({
      ...message,
      content: message.content.filter(block => block.type !== 'image'),
    })
    expect(textOnly.nodes[0]!.tokens)
      .toBe(imageFree + estimateContent([{ type: 'text', text: placeholder }]))
    expect(textOnly.totalTokens).toBeLessThan(meter.measure(session).totalTokens)
  })

  it('keeps the fixed heuristic for routes and services that declare no pricing', async () => {
    const { meter, session } = await harness(() => undefined)
    const message = imageMessage('photo')
    session.append('user/message', message, { surfaceOp: 'append' })
    session.append('request/header', { header: header('vision'), reason: 'initial' })
    const declared = meter.measure(session)
    expect(declared.nodes[0]!.tokens).toBe(estimateMessage(message))

    const unknownRoute = meter.measure(
      session,
      canonicalHeader({ config: { provider: 'unregistered', model: 'any' } }),
    )
    expect(unknownRoute.nodes[0]!.tokens).toBe(estimateMessage(message))
  })

  it('fails loud when a route answers a mismatched occurrence count', async () => {
    const broken: LlmImageRequestPricing = { priceImages: () => [] }
    const { meter, session } = await harness(() => broken)
    session.append('user/message', imageMessage('photo'), { surfaceOp: 'append' })
    session.append('request/header', { header: header('vision'), reason: 'initial' })
    expect(() => meter.measure(session))
      .toThrow('route image pricing answered 0 prices for 1 occurrences')
  })

  it('rejects a negative visual price instead of reducing request pressure', async () => {
    const broken: LlmImageRequestPricing = {
      priceImages: images => images.map(() => ({ visualTokens: -1, text: HANDLE_TEXT })),
    }
    const { meter, session } = await harness(() => broken)
    session.append('user/message', imageMessage('photo'), { surfaceOp: 'append' })
    session.append('request/header', { header: header('vision'), reason: 'initial' })
    expect(() => meter.measure(session)).toThrow('route image pricing returned an invalid visual token count')
  })

  it('prices nested tool-result images through the same route pricing', async () => {
    const { meter, session } = await harness(() => fixedPricing)
    const nested = createUserMessage({
      content: [{
        type: 'tool-result',
        toolCallId: 'call-1' as never,
        content: [
          { type: 'text', text: 'screenshot below' },
          { type: 'image', attachment: imageRef('nested') },
        ],
      }],
      source: { kind: 'user' },
    })
    session.append('user/message', nested, { surfaceOp: 'append' })
    session.append('request/header', { header: header('vision'), reason: 'initial' })
    const measurement = meter.measure(session)
    const imageFree = estimateMessage({
      ...nested,
      content: [{
        ...nested.content[0] as Extract<Message['content'][number], { type: 'tool-result' }>,
        content: [{ type: 'text', text: 'screenshot below' }],
      }],
    })
    expect(measurement.nodes[0]!.tokens)
      .toBe(imageFree + VISUAL_TOKENS + estimateContent([{ type: 'text', text: HANDLE_TEXT }]))
  })
})

const file: FileAttachmentRef = { attachmentId: AttachmentId(`sha256:${'ab'.repeat(32)}`), name: 'notes.txt', bytes: 3 }

function fileMessage(): UserMessage {
  return createUserMessage({ content: [{ type: 'file', attachment: file }], source: { kind: 'user' } })
}

function requestFileMessage(llm: LlmRuntime): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text: llm.fileRequestText(file) }], source: { kind: 'user' } })
}

describe('request-time file pricing', () => {
  it('prices the no-path request handle without an image pricing hook or a request header', async () => {
    const { llm, meter, session } = await harness(() => undefined)
    const message = fileMessage()
    session.append('user/message', message, { surfaceOp: 'append' })
    expect(llm.fileRequestText(file)).toContain('cannot access a readable path')
    const measurement = meter.measure(session)
    expect(measurement.nodes[0]).toMatchObject({
      tokens: estimateMessage(requestFileMessage(llm)), heuristicTokens: estimateMessage(message),
    })
    expect(measurement.totalTokens).toBe(estimateMessage(requestFileMessage(llm)))
  })

  it('keeps the structural fallback when the LLM service is absent', () => {
    const ctx = new Context()
    contexts.push(ctx)
    const meter = new TokenMeter(ctx)
    const session = Session.create(SessionId('no-llm-file'))
    const message = fileMessage()
    session.append('user/message', message, { surfaceOp: 'append' })
    expect(meter.measure(session).nodes[0]).toMatchObject({
      tokens: estimateMessage(message), heuristicTokens: estimateMessage(message),
    })
  })

  it('reads execution-path changes without appending events or rewriting an earlier snapshot', async () => {
    const { ctx, llm, meter, session } = await harness(() => undefined)
    let readPath: string | undefined = '/short/notes.txt'
    // The filesystem mapping is an external execution-world input, independent of the durable reference.
    ctx.provide('attachments', { fileHostPath: () => '/host/notes.txt' } as never)
    ctx.provide('fs', { processPathFromHostPath: () => readPath } as never)
    session.append('user/message', fileMessage(), { surfaceOp: 'append' })
    const first = meter.measure(session)
    expect(first.surfaceTokens).toBe(estimateMessage(requestFileMessage(llm)))
    readPath = '/sandbox/a-longer-mounted-workspace/attachments/notes.txt'
    const moved = meter.measure(session)
    expect(moved.logRevision).toBe(first.logRevision)
    expect(moved.surfaceTokens).toBeGreaterThan(first.surfaceTokens)
    expect(moved.surfaceTokens).toBe(estimateMessage(requestFileMessage(llm)))
    expect(moved.nodes[0]?.heuristicTokens).toBe(first.nodes[0]?.heuristicTokens)
    readPath = undefined
    expect(meter.measure(session).surfaceTokens).toBe(estimateMessage(requestFileMessage(llm)))
    expect(first.surfaceTokens).toBeLessThan(moved.surfaceTokens)
  })

  it('prices every file and image occurrence inside mixed nested tool results', async () => {
    const { llm, meter, session } = await harness(() => fixedPricing)
    const message = createUserMessage({
      content: [
        { type: 'file', attachment: file },
        { type: 'image', attachment: imageRef('outer') },
        { type: 'tool-result', toolCallId: 'nested-files' as never, content: [
          { type: 'text', text: 'attachments' },
          { type: 'file', attachment: file },
          { type: 'image', attachment: imageRef('inner') },
        ] },
      ], source: { kind: 'user' },
    })
    const projected = createUserMessage({
      content: [
        { type: 'text', text: llm.fileRequestText(file) },
        { type: 'text', text: HANDLE_TEXT },
        { type: 'tool-result', toolCallId: 'nested-files' as never, content: [
          { type: 'text', text: 'attachments' },
          { type: 'text', text: llm.fileRequestText(file) },
          { type: 'text', text: HANDLE_TEXT },
        ] },
      ], source: { kind: 'user' },
    })
    session.append('user/message', message, { surfaceOp: 'append' })
    session.append('request/header', { header: header('vision'), reason: 'initial' })
    expect(meter.measure(session).nodes[0]).toMatchObject({
      tokens: estimateMessage(projected) + 2 * VISUAL_TOKENS, heuristicTokens: estimateMessage(message),
    })
  })

  it('reprices usage anchors and cold-restored files on the same execution-world scale', async () => {
    const { ctx, llm, meter, session } = await harness(() => undefined)
    let readPath = '/short/notes.txt'
    ctx.provide('attachments', { fileHostPath: () => '/host/notes.txt' } as never)
    ctx.provide('fs', { processPathFromHostPath: () => readPath } as never)
    session.append('user/message', fileMessage(), { surfaceOp: 'append' })
    appendSuccessfulCall(session, header('files'), { inputTokens: 5000, outputTokens: 50 })
    const before = meter.measure(session)
    readPath = '/sandbox/a-longer-mounted-workspace/attachments/notes.txt'
    const moved = meter.measure(session)
    expect(moved.surfaceTokens).toBeGreaterThan(before.surfaceTokens)
    expect(moved.baseline).toEqual(before.baseline)
    expect(moved.surfaceDeltaTokens).toBe(before.surfaceDeltaTokens)
    expect(moved.totalTokens).toBe(before.totalTokens)

    session.append('user/message', fileMessage(), { surfaceOp: 'append' })
    const current = meter.measure(session)
    expect(current.surfaceDeltaTokens - moved.surfaceDeltaTokens).toBe(estimateMessage(requestFileMessage(llm)))
    const cold = Session.create(SessionId('cold-files'), structuredClone(session.snapshotEvents()))
    expect(meter.measure(cold)).toEqual({ ...current, logRevision: cold.seq })

    readPath = `/mounted/${'long-path'.repeat(3000)}/notes.txt`
    const large = meter.measure(cold)
    expect(large.baseline.kind).toBe('estimated')
    expect(large.totalTokens).toBe(large.surfaceTokens)
  })
})
