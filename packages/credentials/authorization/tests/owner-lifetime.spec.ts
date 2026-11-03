/** Authorization interactions and commits retain their original live service and store. @module */
import { Context } from '@deepseek-ai/cordis'
import { setImmediate } from 'node:timers/promises'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import AuthorizationService, { type AuthorizationSession } from '../src/index.ts'
import { expect, it, onTestFinished, vi } from 'vitest'
import { MemoryCredentials } from './memory.ts'

const key = credentialKey('test-provider', 'account')
const grant = { kind: 'grant' as const, payload: { account: 'original' } }

async function fixture() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const credentialsFiber = await ctx.plugin(MemoryCredentials), credentials = ctx.credentials
  const fiber = await ctx.plugin(AuthorizationService)
  return { ctx, fiber, service: ctx.authorization, credentialsFiber, credentials }
}

it('refuses a retained authorization service after its provider stops', async () => {
  const f = await fixture(), run = vi.fn(async (session: AuthorizationSession) => { await session.commit(async () => grant) })
  f.service.registerFlow({ key, label: 'Account', methods: [{ id: 'login', label: 'Login' }], run })
  await f.fiber.dispose()
  await expect(f.service.begin({ key, interaction: { notify: vi.fn(), prompt: vi.fn() } }))
    .rejects.toMatchObject({ code: 'WITHDRAWN' })
  expect(run).not.toHaveBeenCalled()
  expect(await f.ctx.credentials.readRecord(key)).toBeUndefined()
  expect(() => f.service.registerFlow({ key, label: 'Stopped', methods: [{ id: 'login', label: 'Login' }], run }))
    .toThrow(expect.objectContaining({ code: 'WITHDRAWN' }))
})

it('keeps cancelled flow callbacks from reaching the interaction surface', async () => {
  const f = await fixture(), entered = Promise.withResolvers<AuthorizationSession>(), release = Promise.withResolvers<undefined>()
  let latePrompt: Promise<string> | undefined
  f.service.registerFlow({ key, label: 'Account', methods: [{ id: 'login', label: 'Login' }], async run(session) {
    entered.resolve(session)
    await release.promise
    session.notify({ message: 'late notice' })
    latePrompt = session.prompt({ kind: 'secret', message: 'late secret' })
    await latePrompt.catch(() => {})
  } })
  const interaction = { notify: vi.fn(), prompt: vi.fn(async () => 'late answer') }
  const pending = f.service.begin({ key, interaction })
  const session = await entered.promise
  try {
    f.service.cancel(key)
    await expect(pending).resolves.toEqual({ status: 'cancelled' })
    release.resolve(undefined)
    await vi.waitFor(() => { expect(latePrompt).toBeDefined() })
    await expect(latePrompt).rejects.toMatchObject({ code: 'WITHDRAWN' })
    expect(session.signal.aborted).toBe(true)
    expect(interaction.notify).not.toHaveBeenCalled()
    expect(interaction.prompt).not.toHaveBeenCalled()
  } finally { release.resolve(undefined); await pending; await latePrompt?.catch(() => {}) }
})

it('cancels and joins an unfinished flow when its authorization provider stops', async () => {
  const f = await fixture(), entered = Promise.withResolvers<AuthorizationSession>(), release = Promise.withResolvers<undefined>()
  f.service.registerFlow({ key, label: 'Account', methods: [{ id: 'login', label: 'Login' }], async run(session) {
    entered.resolve(session)
    await release.promise
  } })
  const pending = f.service.begin({ key, interaction: { notify: vi.fn(), prompt: vi.fn() } })
  const session = await entered.promise
  let stopped = false
  const stopping = f.fiber.dispose().then(() => { stopped = true })
  try {
    await setImmediate()
    expect(session.signal.aborted).toBe(true)
    expect(stopped).toBe(false)
    await expect(pending).resolves.toEqual({ status: 'cancelled' })
  } finally { release.resolve(undefined); await pending; await stopping }
})

it('completes an admitted write against its original store during provider replacement', async () => {
  const f = await fixture(), entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const original = f.credentials as MemoryCredentials
  original.gateWrite = async () => { entered.resolve(undefined); await release.promise }
  f.service.registerFlow({ key, label: 'Account', methods: [{ id: 'login', label: 'Login' }], async run(session) {
    await session.commit(async () => grant)
  } })
  const pending = f.service.begin({ key, interaction: { notify: vi.fn(), prompt: vi.fn() } }), outcome = Promise.allSettled([pending])
  await entered.promise
  const retiring = f.credentialsFiber.dispose()
  try {
    await setImmediate()
    const replacement = await f.ctx.plugin(MemoryCredentials)
    release.resolve(undefined)
    await expect(pending).resolves.toEqual({ status: 'authorized' })
    expect(await original.readRecord(key)).toEqual(grant)
    expect(await f.ctx.credentials.readRecord(key)).toBeUndefined()
    await replacement.dispose()
  } finally { release.resolve(undefined); await outcome; await retiring }
})

it('passes attempt cancellation to a pending prompt and refuses its late answer', async () => {
  const f = await fixture(), entered = Promise.withResolvers<AbortSignal>(), answer = Promise.withResolvers<string>()
  let question: Promise<string> | undefined
  f.service.registerFlow({ key, label: 'Account', methods: [{ id: 'login', label: 'Login' }], async run(session) {
    question = session.prompt({ kind: 'text', message: 'Code' })
    await question
  } })
  const pending = f.service.begin({ key, interaction: { notify: vi.fn(), prompt: async (prompt) => {
    if (prompt.signal === undefined) throw new Error('Prompt has no attempt cancellation')
    entered.resolve(prompt.signal)
    return answer.promise
  } } })
  const signal = await entered.promise
  try {
    f.service.cancel(key)
    expect(signal.aborted).toBe(true)
    await expect(pending).resolves.toEqual({ status: 'cancelled' })
    answer.resolve('late code')
    await expect(question).rejects.toMatchObject({ code: 'WITHDRAWN' })
  } finally { answer.resolve('late code'); await pending; await question?.catch(() => {}) }
})

it('combines a prompt withdrawal with its attempt without cancelling that attempt', async () => {
  const f = await fixture(), question = new AbortController(), reason = new Error('question withdrawn')
  const prompt = vi.fn(async (input: { signal?: AbortSignal }) => {
    expect(input.signal?.aborted).toBe(false)
    question.abort(reason)
    expect(input.signal?.aborted).toBe(true)
    throw reason
  })
  f.service.registerFlow({ key, label: 'Account', methods: [{ id: 'login', label: 'Login' }], async run(session) {
    await expect(session.prompt({ kind: 'text', message: 'Code', signal: question.signal })).rejects.toBe(reason)
    await expect(session.prompt({ kind: 'text', message: 'Retired', signal: question.signal })).rejects.toBe(reason)
    expect(session.signal.aborted).toBe(false)
    await session.commit(async () => grant)
  } })
  await expect(f.service.begin({ key, interaction: { notify: vi.fn(), prompt } })).resolves.toEqual({ status: 'authorized' })
  expect(prompt).toHaveBeenCalledOnce()
})

it('settles a synchronously cancelled flow as cancelled and releases its reservation', async () => {
  const f = await fixture()
  f.service.registerFlow({ key, label: 'Account', methods: [{ id: 'login', label: 'Login' }], run() {
    f.service.cancel(key)
    throw new Error('synchronous flow withdrawal')
  } })
  await expect(f.service.begin({ key, interaction: { notify: vi.fn(), prompt: vi.fn() } })).resolves.toEqual({ status: 'cancelled' })
})

it('retires captured callbacks after successful authorization without aborting the completed signal', async () => {
  const f = await fixture(), captured = Promise.withResolvers<AuthorizationSession>()
  f.service.registerFlow({ key, label: 'Account', methods: [{ id: 'login', label: 'Login' }], async run(session) {
    captured.resolve(session)
    await session.commit(async () => grant)
  } })
  const interaction = { notify: vi.fn(), prompt: vi.fn(async () => 'another account') }
  await expect(f.service.begin({ key, interaction })).resolves.toEqual({ status: 'authorized' })
  const session = await captured.promise
  expect(session.signal.aborted).toBe(false)
  session.notify({ message: 'retired notice' })
  await expect(session.prompt({ kind: 'secret', message: 'Retired' })).rejects.toMatchObject({ code: 'WITHDRAWN' })
  await expect(session.commit(async () => grant)).rejects.toMatchObject({ code: 'WITHDRAWN' })
  expect(interaction.notify).not.toHaveBeenCalled()
  expect(interaction.prompt).not.toHaveBeenCalled()
})

it('reports a settlement dispatch observer failure after draining a cancelled flow', async () => {
  const f = await fixture(), entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  f.service.registerFlow({ key, label: 'Account', methods: [{ id: 'login', label: 'Login' }], async run() {
    entered.resolve(undefined)
    await release.promise
  } })
  const failure = new Error('settlement observer unavailable')
  f.ctx.on('internal/dispatch', (_mode, event) => { if (event === 'authorization/settled') throw failure })
  const warn = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
  const pending = f.service.begin({ key, interaction: { notify: vi.fn(), prompt: vi.fn() } })
  try {
    await entered.promise
    f.service.cancel(key)
    await expect(pending).resolves.toEqual({ status: 'cancelled' })
    release.resolve(undefined)
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith(failure) })
    expect(f.service.describe(key)?.inFlight).toBe(false)
  } finally { release.resolve(undefined); await pending; warn.mockRestore() }
})
