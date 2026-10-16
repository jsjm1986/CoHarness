import { Buffer } from 'node:buffer'
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'
import { Context, LoggerLevel } from '@deepseek-ai/cordis'
import SessionStore, {
  SESSION_FORMAT_VERSION,
  Session,
  SessionId,
  SessionLogOffset,
  SessionSeq,
  type CreateSessionOptions,
  type SessionEvent,
} from '@deepseek-ai/dsh-session'
import DeepSeekLlmApiExtensionRegistry from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import * as SessionLogDeepSeek from '../src/index.ts'
import type { DeepSeekSessionLogExtension } from '../src/types.ts'

const contexts: Context[] = []
const SIGNAL = new AbortController().signal

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function harness(
  id: string,
  seed?: readonly SessionEvent[],
  creation?: Omit<CreateSessionOptions, 'seed'>,
): Promise<{
  ctx: Context
  session: Session
  disposeUpload: () => Promise<void>
}> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(DeepSeekLlmApiExtensionRegistry)
  const upload = ctx.plugin(SessionLogDeepSeek, { enabled: true })
  await upload
  const options = seed === undefined
    ? undefined
    : { seed, ...creation }
  const session = ctx.sessions.create(SessionId(id), options)
  return { ctx, session, disposeUpload: () => upload.dispose() }
}

function body(text = 'x'.repeat(300)) {
  return { messages: [{ role: 'user', content: text }] }
}

function userMessages(texts: readonly string[]): SessionEvent[] {
  return texts.map((text, index): SessionEvent => ({
    type: 'user/message',
    seq: SessionSeq(index),
    time: index + 1,
    data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    surfaceOp: 'append',
  }))
}

function bytes(value: DeepSeekSessionLogExtension): number {
  return Buffer.byteLength(JSON.stringify(value))
}

/** The field value carrying only the first `count` events of `value`. */
function prefix(value: DeepSeekSessionLogExtension, count: number): DeepSeekSessionLogExtension {
  return { ...value, throughSeq: value.events[count - 1]!.seq, events: value.events.slice(0, count) }
}

async function prepareField(ctx: Context, session: Session): Promise<DeepSeekSessionLogExtension | undefined> {
  return (await ctx.deepseekLlmApiExtensions.prepare({ body: body(), signal: SIGNAL, sessionId: session.id })).fields.dsh_session_log
}

/** Mount the contribution with one byte limit around `run`. */
async function withMaxBytes<T>(ctx: Context, maxBytes: number, run: () => Promise<T>): Promise<T> {
  const upload = ctx.plugin(SessionLogDeepSeek, { enabled: true, maxBytes })
  await upload
  try {
    return await run()
  } finally {
    await upload.dispose()
  }
}

/** Capture every pending event under the default limit, which these small logs stay below. */
async function unbounded(id: string, texts: readonly string[]): Promise<{
  ctx: Context
  session: Session
  full: DeepSeekSessionLogExtension
}> {
  const { ctx, session, disposeUpload } = await harness(id, userMessages(texts))
  const full = await prepareField(ctx, session)
  if (full === undefined) throw new Error('expected a session-log field')
  await disposeUpload()
  return { ctx, session, full }
}

describe('incremental DeepSeek session-log upload', () => {
  it('publishes raw numeric sequence fields on its external wire DTO', () => {
    expectTypeOf<DeepSeekSessionLogExtension['sessionFormatVersion']>().toEqualTypeOf<number>()
    expectTypeOf<DeepSeekSessionLogExtension['afterSeq']>().toEqualTypeOf<number>()
    expectTypeOf<DeepSeekSessionLogExtension['throughSeq']>().toEqualTypeOf<number>()
    expectTypeOf<DeepSeekSessionLogExtension['events'][number]['seq']>().toEqualTypeOf<number>()
    expectTypeOf<DeepSeekSessionLogExtension['events'][number]['data']>().toEqualTypeOf<JsonValue>()
    expectTypeOf<DeepSeekSessionLogExtension['session']['seedLength']>()
      .toEqualTypeOf<number | undefined>()
  })

  it('does not contribute the session log under its default configuration', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(DeepSeekLlmApiExtensionRegistry)
    await ctx.plugin(SessionLogDeepSeek)
    const session = ctx.sessions.create(SessionId('default-off'))
    session.append('turn/start', { turn: 1 })

    const prepared = await ctx.deepseekLlmApiExtensions.prepare({
      body: body(), signal: SIGNAL, sessionId: session.id,
    })
    expect(prepared.fields).not.toHaveProperty('dsh_session_log')
  })

  it('treats an empty kill-switch value as disabled and any non-empty value as enabled', async () => {
    const variable = 'DSH_TEST_SESSION_LOG_KILL_SWITCH'
    const previous = process.env[variable]
    try {
      process.env[variable] = ''
      const emptyCtx = new Context()
      contexts.push(emptyCtx)
      await emptyCtx.plugin(SessionStore)
      await emptyCtx.plugin(DeepSeekLlmApiExtensionRegistry)
      await emptyCtx.plugin(SessionLogDeepSeek, { enabled: true, killSwitchEnv: variable })
      const empty = { ctx: emptyCtx, session: emptyCtx.sessions.create(SessionId('kill-switch-empty')) }
      empty.session.append('turn/start', { turn: 1 })
      await expect(empty.ctx.deepseekLlmApiExtensions.prepare({
        body: body(), signal: SIGNAL, sessionId: empty.session.id,
      })).resolves.toHaveProperty('fields.dsh_session_log')

      process.env[variable] = '1'
      const nonEmptyCtx = new Context()
      contexts.push(nonEmptyCtx)
      await nonEmptyCtx.plugin(SessionStore)
      await nonEmptyCtx.plugin(DeepSeekLlmApiExtensionRegistry)
      await nonEmptyCtx.plugin(SessionLogDeepSeek, { enabled: true, killSwitchEnv: variable })
      const nonEmpty = { ctx: nonEmptyCtx, session: nonEmptyCtx.sessions.create(SessionId('kill-switch-non-empty')) }
      nonEmpty.session.append('turn/start', { turn: 1 })
      const prepared = await nonEmpty.ctx.deepseekLlmApiExtensions.prepare({
        body: body(), signal: SIGNAL, sessionId: nonEmpty.session.id,
      })
      expect(prepared.fields).not.toHaveProperty('dsh_session_log')
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, variable)
      else process.env[variable] = previous
    }
  })

  it('normalizes allowlisted endpoints and rejects invalid allowlist entries', async () => {
    const allowed = await (async () => {
      const ctx = new Context()
      contexts.push(ctx)
      await ctx.plugin(SessionStore)
      await ctx.plugin(DeepSeekLlmApiExtensionRegistry)
      const upload = ctx.plugin(SessionLogDeepSeek, {
        enabled: true,
        allowedEndpoints: ['https://api.example.test/v1/?ignored=yes#fragment'],
      })
      await upload
      const session = ctx.sessions.create(SessionId('endpoint-normalization'))
      session.append('turn/start', { turn: 1 })
      return ctx.deepseekLlmApiExtensions.prepare({
        body: body(), signal: SIGNAL, sessionId: session.id,
        endpoint: 'https://api.example.test/v1',
      })
    })()
    expect(allowed.fields).toHaveProperty('dsh_session_log')

    const invalid = new Context()
    contexts.push(invalid)
    await invalid.plugin(SessionStore)
    await invalid.plugin(DeepSeekLlmApiExtensionRegistry)
    await expect(invalid.plugin(SessionLogDeepSeek, {
      enabled: true,
      allowedEndpoints: ['not-an-absolute-url'],
    })).rejects.toThrow(/allowedEndpoints must contain absolute http\(s\) URLs/)
  })

  it('applies the 8 MiB default when the composition sets no limit', async () => {
    const { ctx, session } = await harness('bounded-default', userMessages(['a', 'b', 'c'].map(letter => letter.repeat(3 * 1024 * 1024))))
    const value = await prepareField(ctx, session)
    expect(value?.events.map(event => event.seq)).toEqual([0, 1])
    expect(bytes(value!)).toBeLessThanOrEqual(8 * 1024 * 1024)
  })

  it('fills a request up to exactly maxBytes and leaves the next event for a later request', async () => {
    const { ctx, session, full } = await unbounded('bounded-exact', ['a'.repeat(200), 'b'.repeat(200), 'c'.repeat(200)])
    const limit = bytes(prefix(full, 2))
    const atLimit = await withMaxBytes(ctx, limit, () => prepareField(ctx, session))
    expect(atLimit).toEqual(prefix(full, 2))
    expect(bytes(atLimit!)).toBe(limit)
    expect(await withMaxBytes(ctx, limit - 1, () => prepareField(ctx, session))).toEqual(prefix(full, 1))
  })

  it('measures maxBytes in UTF-8 bytes', async () => {
    const { ctx, session, full } = await unbounded('bounded-utf8', ['界'.repeat(100), '界'.repeat(100)])
    const one = bytes(prefix(full, 1))
    const two = bytes(prefix(full, 2))
    expect(await withMaxBytes(ctx, two, () => prepareField(ctx, session))).toEqual(prefix(full, 2))
    expect(await withMaxBytes(ctx, two - 1, () => prepareField(ctx, session))).toEqual(prefix(full, 1))
    expect(await withMaxBytes(ctx, one - 1, () => prepareField(ctx, session))).toBeUndefined()
  })

  it('drains a backlog larger than maxBytes through consecutive accepted requests', async () => {
    const { ctx, session, full } = await unbounded('bounded-drain', Array.from({ length: 6 }, (_, index) => String(index).repeat(200)))
    const maxBytes = bytes(prefix(full, 2))
    const batches = await withMaxBytes(ctx, maxBytes, async () => {
      const values: DeepSeekSessionLogExtension[] = []
      for (let request = 0; request < 10 && SessionLogDeepSeek.acceptedThrough(session) < full.throughSeq; request++) {
        const prepared = await ctx.deepseekLlmApiExtensions.prepare({ body: body(), signal: SIGNAL, sessionId: session.id })
        values.push(prepared.fields.dsh_session_log!)
        await prepared.accept()
      }
      return values
    })
    expect(SessionLogDeepSeek.acceptedThrough(session)).toBeGreaterThanOrEqual(full.throughSeq)
    expect(batches[0]).toEqual(prefix(full, 2))
    expect(batches.length).toBeGreaterThan(2)
    for (const value of batches) {
      expect(bytes(value)).toBeLessThanOrEqual(maxBytes)
      expect(value.events.map(event => event.seq))
        .toEqual(Array.from({ length: value.throughSeq - value.afterSeq }, (_, index) => value.afterSeq + 1 + index))
    }
    expect(batches.map(value => value.afterSeq)).toEqual([-1, ...batches.slice(0, -1).map(value => value.throughSeq)])
    expect(batches.flatMap(value => value.events).filter(event => event.type !== 'session-log-deepseek/delivery-accepted'))
      .toEqual(full.events)
  })

  it('omits the field and keeps the watermark while the next pending event alone exceeds maxBytes', async () => {
    const { ctx, session, full } = await unbounded('bounded-oversized', ['x'.repeat(1000)])
    const warnings: unknown[][] = []
    ctx.logger.exporter({ levels: { default: LoggerLevel.WARN }, export: (message) => { if (message.type === 'warn') warnings.push(message.args) } })
    const limit = bytes(prefix(full, 1)) - 1
    await withMaxBytes(ctx, limit, async () => {
      const prepared = await ctx.deepseekLlmApiExtensions.prepare({ body: body(), signal: SIGNAL, sessionId: session.id })
      expect(prepared.fields).not.toHaveProperty('dsh_session_log')
      await prepared.accept()
      session.append('turn/start', { turn: 1 })
      expect(await prepareField(ctx, session)).toBeUndefined()
    })
    expect(SessionLogDeepSeek.acceptedThrough(session)).toBe(-1)
    const warning = `session-log-deepseek: event 0 of session "bounded-oversized" needs a ${String(limit + 1)}-byte dsh_session_log field,`
    expect(warnings).toEqual([[expect.stringContaining(warning)]])
  })

  it('uploads the full first prefix, records acceptance, then sends only the appended suffix', async () => {
    const { ctx, session } = await harness('incremental')
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })

    const first = await ctx.deepseekLlmApiExtensions.prepare({ body: body(), signal: SIGNAL, sessionId: session.id })
    const firstPayload = first.fields.dsh_session_log
    expect(firstPayload).toMatchObject({ afterSeq: -1, throughSeq: 1 })
    expect(firstPayload?.events).toHaveLength(2)
    await first.accept()
    expect(SessionLogDeepSeek.acceptedThrough(session)).toBe(1)

    session.append('step/end', { turn: 1, step: 1 })
    const second = await ctx.deepseekLlmApiExtensions.prepare({ body: body(), signal: SIGNAL, sessionId: session.id })
    expect(second.fields.dsh_session_log).toMatchObject({ afterSeq: 1, throughSeq: 3 })
    expect(second.fields.dsh_session_log?.events).toHaveLength(2)
    expect(second.fields.dsh_session_log?.events[0]).toMatchObject({
      type: 'session-log-deepseek/delivery-accepted',
      seq: 2,
    })
  })

  it('reconstructs a persisted cursor and ignores an inherited parent watermark in a fork', async () => {
    const first = await harness('parent')
    first.session.append('turn/start', { turn: 1 })
    const prepared = await first.ctx.deepseekLlmApiExtensions.prepare({ body: body(), signal: SIGNAL, sessionId: first.session.id })
    await prepared.accept()
    const seed = first.session.snapshotEvents()

    const resumed = await harness('parent', seed)
    expect(SessionLogDeepSeek.acceptedThrough(resumed.session)).toBe(0)
    const resumedPayload = await resumed.ctx.deepseekLlmApiExtensions.prepare({
      body: body(), signal: SIGNAL, sessionId: resumed.session.id,
    })
    expect(resumedPayload.fields.dsh_session_log?.afterSeq).toBe(0)

    const fork = await harness('child', seed, {
      inheritedEventCount: SessionLogOffset(seed.length),
      meta: { parentSession: first.session.id, isSeeded: true },
    })
    expect(SessionLogDeepSeek.acceptedThrough(fork.session)).toBe(-1)
    const forkPayload = await fork.ctx.deepseekLlmApiExtensions.prepare({ body: body(), signal: SIGNAL, sessionId: fork.session.id })
    expect(forkPayload.fields.dsh_session_log).toMatchObject({ afterSeq: -1, throughSeq: fork.session.seq - 1 })
  })

  it('takes the maximum watermark when concurrent acceptances settle out of order', async () => {
    const { ctx, session } = await harness('concurrent')
    session.append('turn/start', { turn: 1 })
    const earlier = await ctx.deepseekLlmApiExtensions.prepare({ body: body(), signal: SIGNAL, sessionId: session.id })
    session.append('step/start', { turn: 1, step: 1 })
    const later = await ctx.deepseekLlmApiExtensions.prepare({ body: body(), signal: SIGNAL, sessionId: session.id })

    await later.accept()
    await earlier.accept()
    expect(SessionLogDeepSeek.acceptedThrough(session)).toBe(1)
  })

  it('folds only events appended after the cached acceptance scan', () => {
    const id = SessionId('incremental-fold')
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      {
        type: 'session-log-deepseek/delivery-accepted',
        seq: SessionSeq(1),
        time: 2,
        data: { sessionId: id, throughSeq: SessionSeq(0), sessionFormatVersion: SESSION_FORMAT_VERSION },
      },
    ]
    let reads = 0
    const session = {
      id,
      header: { version: SESSION_FORMAT_VERSION },
      get seq() { return events.length },
      eventAt(seq: number) {
        reads++
        return events[seq]
      },
    } as Partial<Session> as Session

    expect(SessionLogDeepSeek.acceptedThrough(session)).toBe(0)
    expect(reads).toBe(2)
    reads = 0
    expect(SessionLogDeepSeek.acceptedThrough(session)).toBe(0)
    expect(reads).toBe(0)

    events.push(
      { type: 'step/start', seq: SessionSeq(2), time: 3, data: { turn: 1, step: 1 } },
      {
        type: 'session-log-deepseek/delivery-accepted',
        seq: SessionSeq(3),
        time: 4,
        data: { sessionId: id, throughSeq: SessionSeq(2), sessionFormatVersion: SESSION_FORMAT_VERSION },
      },
    )
    expect(SessionLogDeepSeek.acceptedThrough(session)).toBe(2)
    expect(reads).toBe(2)
  })

  it('rejects a missing event below the captured Session length', () => {
    const session = {
      id: SessionId('missing-event'),
      seq: 1,
      eventAt: () => undefined,
    } as never as Session

    expect(() => SessionLogDeepSeek.acceptedThrough(session))
      .toThrow('session-log-deepseek: missing event 0 below captured length 1')
  })

  it('omits the field for direct or stale requests and uploads the prior acceptance marker next', async () => {
    const { ctx, session } = await harness('edges')
    await expect(ctx.deepseekLlmApiExtensions.prepare({ body: body(), signal: SIGNAL }))
      .resolves.toMatchObject({ fields: {} })
    await expect(ctx.deepseekLlmApiExtensions.prepare({ body: body(), signal: SIGNAL, sessionId: 'missing' }))
      .resolves.toMatchObject({ fields: {} })
    await expect(ctx.deepseekLlmApiExtensions.prepare({ body: body(), signal: SIGNAL, sessionId: session.id }))
      .resolves.toMatchObject({ fields: {} })
    session.append('turn/start', { turn: 1 })
    const first = await ctx.deepseekLlmApiExtensions.prepare({ body: body(), signal: SIGNAL, sessionId: session.id })
    await first.accept()
    const current = await ctx.deepseekLlmApiExtensions.prepare({ body: body(), signal: SIGNAL, sessionId: session.id })
    expect(current.fields.dsh_session_log).toMatchObject({
      afterSeq: 0,
      throughSeq: 1,
      events: [{ type: 'session-log-deepseek/delivery-accepted' }],
    })
  })

  it('contributes complete events without reading request messages', async () => {
    const { ctx, session } = await harness('direct-events')
    session.append('turn/start', { turn: 1 })
    const prepared = await ctx.deepseekLlmApiExtensions.prepare({ body: {}, signal: SIGNAL, sessionId: session.id })
    expect(prepared.fields.dsh_session_log?.events).toEqual(session.snapshotEvents())
  })

  it('translates logical brands and isSeeded into the raw v0 upload DTO', async () => {
    const firstMessage = createUserMessage({
      content: [{ type: 'text', text: 'first' }],
      source: { kind: 'user' },
    })
    const replacementMessage = createUserMessage({
      content: [{ type: 'text', text: 'replacement' }],
      source: { kind: 'user' },
    })
    const seed = [
      {
        type: 'user/message',
        seq: SessionSeq(0),
        time: 1,
        data: firstMessage,
        ignorable: true,
        surfaceOp: 'append',
      },
      {
        type: 'user/message',
        seq: SessionSeq(1),
        time: 2,
        data: replacementMessage,
        sourceEventSeqs: [SessionSeq(0)],
        surfaceOp: { op: 'replace', startSeq: SessionSeq(0), endSeq: SessionSeq(0) },
      },
    ] satisfies SessionEvent[]
    const { ctx, session } = await harness('wire-child', seed, {
      inheritedEventCount: SessionLogOffset(seed.length),
      meta: {
        cwd: '/wire-workspace',
        parentSession: SessionId('wire-parent'),
        isSeeded: true,
        origin: 'subagent',
        delegationDepth: 1,
        agentPreset: 'minimal',
      },
    })

    const prepared = await ctx.deepseekLlmApiExtensions.prepare({
      body: body(), signal: SIGNAL, sessionId: session.id,
    })
    const wire = JSON.parse(JSON.stringify(prepared.fields.dsh_session_log)) as Record<string, unknown>
    expect(wire.session).toMatchObject({
      version: 7,
      id: 'wire-child',
      parentSession: 'wire-parent',
      cwd: '/wire-workspace',
      seedLength: seed.length,
      origin: 'subagent',
      delegationDepth: 1,
      agentPreset: 'minimal',
    })
    expect(wire.session).not.toHaveProperty('isSeeded')
    expect(typeof wire.afterSeq).toBe('number')
    expect(typeof wire.throughSeq).toBe('number')
    expect(Array.isArray(wire.events)).toBe(true)
    const events = Array.isArray(wire.events) ? wire.events : []
    expect(events[0]).toMatchObject({
      seq: 0,
      ignorable: true,
      surfaceOp: 'append',
    })
    expect(events[0]).not.toHaveProperty('sourceEventSeqs')
    expect(events[1]).toMatchObject({
      seq: 1,
      sourceEventSeqs: [0],
      surfaceOp: { op: 'replace', start: 0, end: 0 },
    })
  })

  it('fails closed on a malformed persisted acceptance watermark', async () => {
    for (const [id, throughSeq] of [['current', 0], ['negative', -1]] as const) {
      const malformed = [{
        type: 'session-log-deepseek/delivery-accepted',
        seq: 0,
        time: 1,
        data: { sessionId: `malformed-${id}`, throughSeq, sessionFormatVersion: SESSION_FORMAT_VERSION },
      }] as Partial<SessionEvent>[] as SessionEvent[]
      const session = Session.create(SessionId(`malformed-${id}`), malformed)
      expect(() => SessionLogDeepSeek.acceptedThrough(session)).toThrow(/malformed acceptance watermark/)
    }
  })

  it.each([-1, -0, 0.5])('rejects a malformed acceptance format version %s', (sessionFormatVersion) => {
    const id = SessionId(`malformed-format-${sessionFormatVersion}`)
    const events = [{
      type: 'session-log-deepseek/delivery-accepted',
      seq: SessionSeq(0),
      time: 1,
      data: { sessionId: id, throughSeq: SessionSeq(0), sessionFormatVersion },
    }] as Partial<SessionEvent>[] as SessionEvent[]
    const session = {
      id,
      header: { version: SESSION_FORMAT_VERSION },
      get seq() { return SessionLogOffset(events.length) },
      eventAt: (seq: ReturnType<typeof SessionSeq>) => events[seq],
    } as Partial<Session> as Session

    expect(() => SessionLogDeepSeek.acceptedThrough(session)).toThrow(/malformed acceptance format version/)
  })

  it('withdraws its request field when the contributing plugin reloads', async () => {
    const { ctx, session, disposeUpload } = await harness('hmr')
    session.append('turn/start', { turn: 1 })
    expect((await ctx.deepseekLlmApiExtensions.prepare({ body: body(), signal: SIGNAL, sessionId: session.id })).fields)
      .toHaveProperty('dsh_session_log')
    await disposeUpload()
    expect((await ctx.deepseekLlmApiExtensions.prepare({ body: body(), signal: SIGNAL, sessionId: session.id })).fields)
      .not.toHaveProperty('dsh_session_log')
  })
})
