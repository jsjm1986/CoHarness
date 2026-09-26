// @vitest-environment jsdom
/** The tool detail body binds the tab's durable address to its details child. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ToolBody } from '../src/client/tabs/tool/ToolBody.tsx'

const SESSION = 's-tool' as SessionId

afterEach(cleanup)

function props(address: string, close: () => void, renderSlot: unknown): Parameters<typeof ToolBody>[0] {
  return {
    sessionId: SESSION,
    useTabInfo: () => ({ tab: { navigation: { address }, actions: { close }, visible: true } }),
    renderSlot,
  } as unknown as Parameters<typeof ToolBody>[0]
}

describe('ToolBody', () => {
  it('renders the details child with the call identity, visibility, and close', () => {
    const close = vi.fn()
    const renderSlot = vi.fn((_slot: string, options: { callId: string; readEnabled: boolean; close: () => void }) =>
      <div data-tool-details>{options.callId}</div>)
    const view = render(<ToolBody {...props(`dsh-resource://tool/session/${SESSION}/call-9`, close, renderSlot)} />)
    expect(view.container.querySelector('[data-tool-details]')?.textContent).toBe('call-9')
    const options = renderSlot.mock.calls[0]?.[1] as { callId: string; readEnabled: boolean; close: () => void }
    expect(options).toMatchObject({ callId: 'call-9', readEnabled: true })
    options.close()
    expect(close).toHaveBeenCalled()
  })

  it('refuses a tab owned by another Session or without a tool address', () => {
    const renderSlot = vi.fn(() => <div />)
    expect(() => render(<ToolBody {...props('dsh-resource://tool/session/s-other/call-9', vi.fn(), renderSlot)} />))
      .toThrow('Tool tab does not belong to this Session')
    expect(() => render(<ToolBody {...props('sidebar://guide', vi.fn(), renderSlot)} />))
      .toThrow('Tool tab does not belong to this Session')
  })
})
