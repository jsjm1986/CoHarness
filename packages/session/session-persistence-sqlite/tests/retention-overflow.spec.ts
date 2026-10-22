/** Durability barriers must retain live event-admission failures. */
import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SqlitePersistence from '../src/index.ts'

it.each(['events', 'bytes'] as const)('refuses every flush after live %s retention overflows', async (bound) => {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const backend = await ctx.plugin(SqlitePersistence, {
    path: ':memory:', writeBatchMaxDelayMs: 60_000,
    ...bound === 'events' ? { maxPendingEvents: 1 } : { maxPendingBytes: 100 },
  })
  const reported = vi.spyOn(ctx.logger, 'error').mockImplementation(() => undefined)
  try {
    const session = ctx.sessions.create(SessionId(`overflow-${bound}`))
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(session.seq).toBe(2)
    await expect(ctx.sessions.flush(session)).rejects.toThrow(/pending-(event|byte) limit exceeded/)
    const reader = await ctx.sessionPersistence.open(session.id, 'read')
    try {
      expect((await reader.read()).events.map(event => event.type)).toEqual(['turn/start'])
    } finally { await reader.close() }
    await expect(ctx.sessions.flush(session)).rejects.toThrow(/pending-(event|byte) limit exceeded/)
    session.append('turn/start', { turn: 2 })
    await expect(ctx.sessions.flush(session)).rejects.toThrow(/pending-(event|byte) limit exceeded/)
    await backend.dispose()
    const aggregate = reported.mock.calls.map((call): unknown => call[0])
      .find((value): value is AggregateError => value instanceof AggregateError)
    expect(aggregate?.message).toContain('dispose failed')
    const errors: unknown[] = aggregate?.errors ?? []
    expect(errors).toHaveLength(1)
    const failure = errors[0]
    expect(failure instanceof Error ? failure.message : undefined).toMatch(/pending-(event|byte) limit exceeded/)
  } finally { await ctx.fiber.dispose(); reported.mockRestore() }
})
