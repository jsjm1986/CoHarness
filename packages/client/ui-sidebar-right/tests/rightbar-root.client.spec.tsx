// @vitest-environment jsdom
/** The right Sidebar root hands an explicit Session target to the provider. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RightbarRoot } from '../src/client/shell/RightbarRoot.tsx'

const SESSION = 's-root' as SessionId

afterEach(cleanup)

describe('RightbarRoot', () => {
  it('scopes the session slot through the explicit target when one is given', () => {
    const seen: Array<{ sessionId: string | undefined }> = []
    const SessionProvider = (props: { sessionId?: string; children: () => ReactNode }): ReactNode => {
      seen.push({ sessionId: props.sessionId })
      return props.children()
    }
    const renderSlot = vi.fn((_slot: string, _owner: unknown) => <div data-rightbar />)
    const view = render(<RightbarRoot
      SessionProvider={SessionProvider as never}
      renderSlot={renderSlot as never}
      useSessions={vi.fn() as never} useWorkspaces={vi.fn() as never}
      width={320} viewportWidth={1280} canShow targetSessionId={SESSION} />)
    expect(seen[0]?.sessionId).toBe(SESSION)
    expect(renderSlot).toHaveBeenCalledWith('rightbar.session', { width: 320, viewportWidth: 1280, canShow: true })
    expect(view.container.querySelector('[data-rightbar]')).not.toBeNull()
  })
})
