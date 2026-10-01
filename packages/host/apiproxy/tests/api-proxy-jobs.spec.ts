/**
 * Background-task carrier paths of the host ApiProxy: the subscription
 * baseline is sent only for a session that has tasks, every registry change
 * pushes that owner's whole set, an unowned change fans out to every
 * subscribed session, the projection drops the three internal snapshot
 * fields, a composition without `ctx.jobs` emits nothing, and listing never
 * resumes a cold session.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { MuxFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { sessionBackedInbox, unsupportedInbox } from '../../../core/agent-loop/tests/inbox-helpers.ts'

type JobFrame = Extract<MuxFrame, { type: 'session/jobs' }>

/**
 * A producer whose settlement the test drives. `cancel` deliberately does not
 * settle, so a kill is observable as the distinct `stopping` step before the
 * test supplies the terminal outcome and its detail.
 */
function producer(label = 'sleep 60') {
  let settle!: (outcome: JobOutcome) => void
  const spec = {
    kind: 'bash' as const,
    label,
    run: () => ({
      cancel: () => {},
      done: new Promise<JobOutcome>((resolve) => { settle = resolve }),
    }),
  }
  return { spec, settle: (outcome: JobOutcome) => { settle(outcome) } }
}

/**
 * A producer that also pushes text into the ring through its handle, so
 * `jobs.output` has retained bytes to read. `write` calls are safe only after
 * `start` returned (the handle arrives during `run`).
 */
function writingProducer(label = 'cat log.txt') {
  let handle!: { append(text: string): void; updateProgress(line: string): void }
  let settle!: (outcome: JobOutcome) => void
  const spec = {
    kind: 'bash' as const,
    label,
    run: (job: { append(text: string): void; updateProgress(line: string): void }) => {
      handle = job
      return {
        cancel: () => {},
        done: new Promise<JobOutcome>((resolve) => { settle = resolve }),
      }
    },
  }
  return {
    spec,
    append: (text: string) => { handle.append(text) },
    progress: (line: string) => { handle.updateProgress(line) },
    settle: (outcome: JobOutcome) => { settle(outcome) },
  }
}

async function harness(
  withRegistry: boolean,
  registryConfig?: ConstructorParameters<typeof LocalJobRegistry>[1],
): Promise<{ ctx: Context; session: Session; agent: Agent }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  if (withRegistry) {
    // The pull-source pump polls at 150ms by default: under a longer-running
    // spec it would inject output frames mid-assertion. Stretch it past any
    // test window — producers that need bytes push them via `append` instead.
    await ctx.plugin(LocalJobRegistry, { pumpPollMs: 60_000, ...registryConfig })
    ctx.jobs.attachController('api-proxy-test')
  }
  const session = ctx.sessions.create()
  const agent = {
    id: session.id,
    session,
    inbox: unsupportedInbox(),
    status: 'idle',
    ctx,
  } as Agent
  sessionBackedInbox(agent)
  await ctx.agents.register(agent)
  return { ctx, session, agent }
}

const api = (ctx: Context) => createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })

/** Drain the mux until `count` session/jobs frames arrived, then abort. */
async function collect(
  iterable: AsyncIterable<RpcRequest<MuxFrame>>,
  count: number,
  abort: AbortController,
): Promise<JobFrame[]> {
  const frames: MuxFrame[] = []
  for await (const envelope of iterable) {
    frames.push(envelope.payload)
    if (frames.filter(frame => frame.type === 'session/jobs').length >= count) abort.abort()
  }
  return frames.filter((frame): frame is JobFrame => frame.type === 'session/jobs')
}

describe('session/jobs subscription baseline', () => {
  it('is omitted for a session with no tasks — absence is the empty set', async () => {
    const { ctx, session } = await harness(true)
    const abort = new AbortController()
    const stream = api(ctx).events.mux({ rpcId: RpcId('t-tasks-empty'), payload: {} }, abort.signal)
    const frames: MuxFrame[] = []
    const drained = (async () => {
      for await (const envelope of stream) {
        frames.push(envelope.payload)
        if (frames.some(frame => frame.type === 'session/subscribed')) abort.abort()
      }
    })()
    await drained
    expect(frames.some(frame => frame.type === 'session/jobs')).toBe(false)
    expect(frames.some(frame => frame.type === 'session/subscribed')).toBe(true)
    void session
  })

  it('carries the live set for a session that already has tasks when the stream opens', async () => {
    const { ctx, session, agent } = await harness(true)
    ctx.jobs.start({ ...producer('pnpm run build').spec, owner: agent.id })
    const abort = new AbortController()
    const stream = api(ctx).events.mux({ rpcId: RpcId('t-tasks-baseline'), payload: {} }, abort.signal)
    const [baseline] = await collect(stream, 1, abort)
    expect(baseline?.sessionId).toBe(session.id)
    expect(baseline?.jobs).toHaveLength(1)
    const [job] = baseline?.jobs ?? []
    expect(job?.startedAt).toBeTypeOf('number')
    expect({ ...job, startedAt: 0 }).toEqual({
      id: 'bash-1',
      kind: 'bash',
      label: 'pnpm run build',
      status: 'running',
      startedAt: 0,
      output: { total: 0, earliest: 0 },
    })
  })
})

describe('session/jobs change pushes', () => {
  it('pushes the owner\'s whole set on registration, stopping, and settlement', async () => {
    const { ctx, session, agent } = await harness(true)
    const proxy = api(ctx)
    const abort = new AbortController()
    const stream = proxy.events.mux({ rpcId: RpcId('t-tasks-changes'), payload: {} }, abort.signal)
    const collected = collect(stream, 3, abort)

    const p = producer()
    const id = ctx.jobs.start({ ...p.spec, owner: agent.id })
    ctx.jobs.kill(id, agent.id, 'test')
    p.settle({ status: 'killed', detail: 'signal: SIGTERM' })

    const frames = await collected
    expect(frames.map(frame => frame.sessionId)).toEqual([session.id, session.id, session.id])
    expect(frames.map(frame => frame.jobs[0]?.status)).toEqual(['running', 'stopping', 'killed'])
    // Terminal detail rides the same whole-set push; no separate signal. The
    // registry appends the kill reason to the producer's terminal detail.
    expect(frames[2]?.jobs[0]?.detail).toBe('signal: SIGTERM; test')
    expect(frames[2]?.jobs[0]?.finishedAt).toBeTypeOf('number')
  })

  it('drops owner and outputLimitBytes from the wire view, but passes progress through', async () => {
    const { ctx, agent } = await harness(true)
    const proxy = api(ctx)
    const abort = new AbortController()
    const stream = proxy.events.mux({ rpcId: RpcId('t-tasks-fields'), payload: {} }, abort.signal)
    const collected = collect(stream, 1, abort)
    ctx.jobs.start({ ...producer().spec, owner: agent.id, outputLimitBytes: 1_024 })

    const [frame] = await collected
    const fields: readonly string[] = Object.keys(frame?.jobs[0] ?? {})
    expect([...fields].sort()).toEqual(['id', 'kind', 'label', 'output', 'startedAt', 'status'])
    expect(frame?.jobs[0]?.output).toEqual({ total: 0, earliest: 0 })
  })

  it('pushes a progress-line change as its own whole-set frame', async () => {
    const { ctx, agent } = await harness(true)
    const proxy = api(ctx)
    const abort = new AbortController()
    const stream = proxy.events.mux({ rpcId: RpcId('t-tasks-progress'), payload: {} }, abort.signal)
    const collected = collect(stream, 2, abort)

    const p = writingProducer()
    ctx.jobs.start({ ...p.spec, owner: agent.id })
    p.progress('3/10 chunks')

    const frames = await collected
    expect(frames[0]?.jobs[0]?.progress).toBeUndefined()
    expect(frames[1]?.jobs[0]?.progress).toBe('3/10 chunks')
  })

  it('fans an unowned change out to every subscribed session', async () => {
    const { ctx } = await harness(true)
    const second = ctx.sessions.create()
    const proxy = api(ctx)
    const abort = new AbortController()
    const stream = proxy.events.mux({ rpcId: RpcId('t-tasks-unowned'), payload: {} }, abort.signal)
    const collected = collect(stream, 2, abort)

    ctx.jobs.start(producer('open to every caller').spec)

    const frames = await collected
    expect(new Set(frames.map(frame => frame.sessionId)).size).toBe(2)
    expect(frames.some(frame => frame.sessionId === second.id)).toBe(true)
    for (const frame of frames) expect(frame.jobs[0]?.label).toBe('open to every caller')
  })

  it('serves a cold session the unowned set without resuming it', async () => {
    const { ctx } = await harness(true)
    const coldId = SessionId('session-cold-tasks')
    let loaded = false
    ctx.provide('sessionPersistence', {
      list: async () => [{ version: 0, id: coldId, createdAt: 5, cwd: '/tmp' }].map(header => ({ header })),
      listHeaders: async () => [{ version: 0, id: coldId, createdAt: 5, cwd: '/tmp' }],
      locate: () => undefined,
      load: () => { loaded = true; throw new Error('task listing must not load a cold log') },
    } as never)
    const proxy = api(ctx)
    const abort = new AbortController()
    const stream = proxy.events.mux({ rpcId: RpcId('t-tasks-cold'), payload: {} }, abort.signal)
    const collected = collect(stream, 1, abort)

    ctx.jobs.start(producer().spec)
    await collected
    expect(loaded).toBe(false)
    expect(ctx.agents.get(coldId)).toBeUndefined()
  })
})

describe('session/jobs without the registry', () => {
  it('emits no frames at all, so the client renders no entry point', async () => {
    const { ctx, session } = await harness(false)
    const proxy = api(ctx)
    const abort = new AbortController()
    const stream = proxy.events.mux({ rpcId: RpcId('t-tasks-absent'), payload: {} }, abort.signal)
    const frames: MuxFrame[] = []
    const drained = (async () => {
      for await (const envelope of stream) {
        frames.push(envelope.payload)
        if (frames.filter(frame => frame.type === 'session/event').length >= 1) abort.abort()
      }
    })()
    session.append('turn/start', { turn: 1 })
    await drained
    expect(frames.some(frame => frame.type === 'session/jobs')).toBe(false)
  })
})

describe('session/jobs never consumes model output', () => {
  it('drives the whole lifecycle without calling the single consuming cursor', async () => {
    // `ctx.jobs.read()` consumes the one output cursor, so a carrier read
    // silently takes bytes the model's `job_output` will never see. The
    // failure is invisible at the call site, which is why this spies on the
    // method rather than trusting review.
    const { ctx, agent } = await harness(true)
    const read = vi.spyOn(ctx.jobs, 'read')
    const proxy = api(ctx)
    const abort = new AbortController()
    const stream = proxy.events.mux({ rpcId: RpcId('t-tasks-no-read'), payload: {} }, abort.signal)
    const collected = collect(stream, 3, abort)

    const p = producer()
    const id = ctx.jobs.start({ ...p.spec, owner: agent.id })
    ctx.jobs.kill(id, agent.id, 'test')
    p.settle({ status: 'killed', detail: 'signal: SIGTERM' })
    await collected

    expect(read).not.toHaveBeenCalled()
  })

  it('reads nothing while minting the subscription baseline either', async () => {
    const { ctx, agent } = await harness(true)
    const read = vi.spyOn(ctx.jobs, 'read')
    const p = producer()
    ctx.jobs.start({ ...p.spec, owner: agent.id })

    const abort = new AbortController()
    const stream = api(ctx).events.mux({ rpcId: RpcId('t-tasks-no-read-baseline'), payload: {} }, abort.signal)
    const [baseline] = await collect(stream, 1, abort)

    expect(baseline?.jobs).toHaveLength(1)
    expect(read).not.toHaveBeenCalled()
  })
})

describe('session/jobs baseline for a session born after the stream opened', () => {
  it('carries the already-visible unowned set to the new session', async () => {
    const { ctx } = await harness(true)
    const proxy = api(ctx)
    const abort = new AbortController()
    const stream = proxy.events.mux({ rpcId: RpcId('t-tasks-late-session'), payload: {} }, abort.signal)

    // One unowned task exists before the new session is created; the subscribe
    // frame clears the client mirror, so the baseline has to follow it.
    ctx.jobs.start(producer('visible to every caller').spec)
    const created = ctx.sessions.create()

    const frames = await collect(stream, 2, abort)
    const forNew = frames.filter(frame => frame.sessionId === created.id)
    expect(forNew.at(-1)?.jobs[0]?.label).toBe('visible to every caller')
  })
})

describe('jobs.output', () => {
  const call = (ctx: Context, payload: { sessionId?: SessionId; jobId: string; from?: number }) =>
    api(ctx).jobs.output({ rpcId: RpcId('t-output'), payload } as never)

  it('reads an owned job\'s ring without touching the consuming cursor', async () => {
    const { ctx, agent } = await harness(true)
    const p = writingProducer()
    const id = ctx.jobs.start({ ...p.spec, owner: agent.id })
    p.append('line one\nline two\n')

    const { result } = await call(ctx, { sessionId: agent.id, jobId: id })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.chunks.map(chunk => chunk.text).join('')).toBe('line one\nline two\n')
    expect(result.value.next).toBe(result.value.output.total)
    expect(result.value.next).toBeGreaterThan(0)
    expect(result.value.lossy).toBeUndefined()
    expect(result.value.job.status).toBe('running')

    // The non-consuming read must leave the model's cursor alone: a later
    // `read()` still returns every byte.
    const modelRead = ctx.jobs.read(id, agent.id)
    expect(modelRead.chunks.map(chunk => chunk.text).join('')).toBe('line one\nline two\n')
  })

  it('resumes from the returned offset and marks a sub-window read lossy', async () => {
    const { ctx, agent } = await harness(true)
    const p = writingProducer()
    const id = ctx.jobs.start({ ...p.spec, owner: agent.id })
    p.append('first\n')

    const first = await call(ctx, { sessionId: agent.id, jobId: id })
    if (!first.result.ok) throw new Error('first read failed')
    p.append('second\n')
    const second = await call(ctx, { sessionId: agent.id, jobId: id, from: first.result.value.next })
    if (!second.result.ok) throw new Error('second read failed')
    expect(second.result.value.chunks.map(chunk => chunk.text).join('')).toBe('second\n')
    expect(second.result.value.lossy).toBeUndefined()

    // An offset landing inside a retained chunk returns the whole chunk:
    // chunk boundaries are the only resume positions.
    const inside = await call(ctx, { sessionId: agent.id, jobId: id, from: 1 })
    if (!inside.result.ok) throw new Error('inside-chunk read failed')
    expect(inside.result.value.chunks[0]?.at).toBe(0)
    expect(inside.result.value.chunks.map(chunk => chunk.text).join('')).toBe('first\nsecond\n')
  })

  it('marks a read below the retained window lossy', async () => {
    const { ctx, agent } = await harness(true, { retainBytes: 16 })
    const p = writingProducer()
    const id = ctx.jobs.start({ ...p.spec, owner: agent.id })
    p.append('0123456789abcdef')
    p.append('tail\n')

    const { result } = await call(ctx, { sessionId: agent.id, jobId: id, from: 0 })
    if (!result.ok) throw new Error('lossy read failed')
    expect(result.value.lossy).toBe(true)
    expect(result.value.output.earliest).toBeGreaterThan(0)
    expect(result.value.chunks.map(chunk => chunk.text).join('')).toContain('tail')
  })

  it('fails unknown and foreign ids with job-not-found', async () => {
    const { ctx, agent } = await harness(true)
    const id = ctx.jobs.start({ ...writingProducer().spec, owner: agent.id })
    const stranger = ctx.sessions.create()

    const foreign = await call(ctx, { sessionId: stranger.id, jobId: id })
    expect(foreign.result.ok).toBe(false)
    if (!foreign.result.ok) expect(foreign.result.error.code).toBe('job-not-found')

    const unknown = await call(ctx, { sessionId: agent.id, jobId: 'bash-999' })
    expect(unknown.result.ok).toBe(false)
    if (!unknown.result.ok) expect(unknown.result.error.code).toBe('job-not-found')
  })

  it('reads an unowned job with or without a session fence', async () => {
    const { ctx, session } = await harness(true)
    const p = writingProducer('unowned work')
    const id = ctx.jobs.start(p.spec)
    p.append('open bytes\n')

    const unfenced = await call(ctx, { jobId: id })
    expect(unfenced.result.ok).toBe(true)
    if (unfenced.result.ok) {
      expect(unfenced.result.value.chunks.map(chunk => chunk.text).join('')).toBe('open bytes\n')
    }
    const fenced = await call(ctx, { sessionId: session.id, jobId: id })
    expect(fenced.result.ok).toBe(true)
  })
})

describe('jobs.kill', () => {
  const call = (ctx: Context, payload: { sessionId: SessionId; jobId: string }) =>
    api(ctx).jobs.kill({ rpcId: RpcId('t-kill'), payload } as never)

  it('requests the kill and leaves settlement to the producer', async () => {
    const { ctx, agent } = await harness(true)
    const p = producer()
    const id = ctx.jobs.start({ ...p.spec, owner: agent.id })

    const { result } = await call(ctx, { sessionId: agent.id, jobId: id })
    expect(result).toEqual({ ok: true, value: { outcome: 'requested' } })
    expect(ctx.jobs.get(id, agent.id).status).toBe('stopping')

    p.settle({ status: 'killed', detail: 'signal: SIGTERM' })
    await vi.waitFor(() => { expect(ctx.jobs.get(id, agent.id).status).toBe('killed') })
    const second = await call(ctx, { sessionId: agent.id, jobId: id })
    expect(second.result).toEqual({ ok: true, value: { outcome: 'already-finished' } })
  })

  it('fails unknown and foreign ids with job-not-found', async () => {
    const { ctx, agent } = await harness(true)
    const id = ctx.jobs.start({ ...producer().spec, owner: agent.id })
    const stranger = ctx.sessions.create()

    const foreign = await call(ctx, { sessionId: stranger.id, jobId: id })
    expect(foreign.result.ok).toBe(false)
    if (!foreign.result.ok) expect(foreign.result.error.code).toBe('job-not-found')
    // The foreign denial must not have touched the real job.
    expect(ctx.jobs.get(id, agent.id).status).toBe('running')

    const unknown = await call(ctx, { sessionId: agent.id, jobId: 'bash-999' })
    expect(unknown.result.ok).toBe(false)
    if (!unknown.result.ok) expect(unknown.result.error.code).toBe('job-not-found')
  })
})
