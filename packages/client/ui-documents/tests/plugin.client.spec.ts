// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { describe, expect, it, vi } from 'vitest'
import { DocumentsButton } from '../src/client/DocumentsButton.tsx'
import { apply, inject } from '../src/client/index.ts'

describe('ui-documents apply', () => {
  it('declares only the services it reads', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('registers the documents entry in the sidebar footer action slot', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('locale', { register: vi.fn(() => () => {}) })
    ctx.slots.register({
      name: 'root',
      children: {
        'sidebar.footer.action': { kind: 'list', scope: 'root' },
      },
    } as never, () => null)

    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    const entries = ctx.slots.entries('sidebar.footer.action')
    const docEntry = entries.find(entry => entry.component === DocumentsButton)!
    expect(docEntry).toBeDefined()
    expect(docEntry.options).toMatchObject({ id: 'documents', order: -10 })
    fiber.dispose()
  })
})
