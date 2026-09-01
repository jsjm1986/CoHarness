/** Browser plugin registration and HMR disposal for the Schedule catalog. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '../src/client/index.ts'
import { apply as applyNode } from '../src/index.ts'
import { en, NS, zh } from '../src/client/locales.ts'

async function bench(): Promise<{ ctx: Context; fiber: ReturnType<Context['plugin']> }> {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: { 'conversation.session.header.actions': { kind: 'list', scope: 'session' } },
  } as never, () => null)
  ctx.provide('connection', { api: {}, isLoopback: true } as never)
  ctx.provide('remote', {} as never)
  ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()
  ctx.locale.setLocale('zh')
  const fiber = ctx.plugin({ inject, apply })
  await fiber.await()
  return { ctx, fiber }
}

describe('ui-schedule browser half', () => {
  it('keeps the node half inert and callable', () => {
    expect(() => { applyNode() }).not.toThrow()
  })

  it('declares services and registers/removes the header action', async () => {
    expect(inject).toEqual(['slots', 'locale'])
    const { ctx, fiber } = await bench()
    expect(ctx.slots.entries('conversation.session.header.actions').map(entry => entry.options.id)).toContain('schedule-catalog')
    await fiber.dispose()
    expect(ctx.slots.entries('conversation.session.header.actions').map(entry => entry.options.id)).not.toContain('schedule-catalog')
  })

  it('registers both locale dictionaries under its namespace', async () => {
    const { ctx, fiber } = await bench()
    const t = ctx.locale.bind(NS)
    expect(t('list.aria')).toBe(zh['list.aria'])
    ctx.locale.setLocale('en')
    expect(t('list.aria')).toBe(en['list.aria'])
    await fiber.dispose()
  })
})
