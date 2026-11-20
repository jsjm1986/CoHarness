// @vitest-environment jsdom
/** Target identity follows the tab occurrence and title registration lifetime. */
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ComponentProps } from 'react'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import { RemoteDesktopTitle } from '../src/client/RemoteDesktopTitle.tsx'
import { apply, inject } from '../src/client/index.ts'

afterEach(cleanup)

it('shows the current node and desktop, including when an occurrence is retargeted', () => {
  type TabInfo = ReturnType<ComponentProps<typeof RemoteDesktopTitle>['useTabInfo']>
  let info: TabInfo = {
    sidebar: { expanded: true, fullscreen: false },
    panel: { id: 'pane-1' as TabInfo['panel']['id'] },
    tab: {
      id: 'tab-1' as TabInfo['tab']['id'], kind: 'remoteDesktop', contentId: 'sidebar://remoteDesktop',
      title: 'Remote desktop', visible: true, signal: new AbortController().signal,
      navigation: { address: 'sidebar://remoteDesktop', revision: 1, params: { nodeId: 'node-1', desktop: 'display-0' } },
      actions: { bindCommands: () => () => {}, openResource: () => {}, openTab: () => {}, setPanelMode: () => {}, close: () => {} },
    },
  }
  const useTabInfo = () => info
  const props: ComponentProps<typeof RemoteDesktopTitle> = {
    useTabInfo,
    sessionId: SessionId('remote-desktop-title'),
    useSession: () => { throw new Error('The title does not read session state') },
    useSessions: () => { throw new Error('The title does not read the session catalog') },
    useWorkspaces: () => { throw new Error('The title does not read the workspace catalog') },
    useRemoteAccess: () => true,
    usePanelInfo: () => { throw new Error('The title does not read the active panel') },
    useProjection: () => undefined,
    useInput: () => { throw new Error('The title does not read composer state') },
    inputActions: {
      setDraft: () => {}, addImages: () => true, removeImage: () => {},
      pruneImages: () => {}, addDocuments: () => true, removeDocument: () => {},
      pruneDocuments: () => {}, captureInsertion: () => ({ start: 0, end: 0, draftRev: 0 }),
      insertText: () => false, submit: () => {},
    },
  }
  const view = render(<RemoteDesktopTitle {...props} />)
  expect(view.container.textContent).toBe('node-1 · display-0')
  expect(view.container.firstElementChild?.tagName).toBe('SPAN')
  info = { ...info, tab: { ...info.tab, navigation: { ...info.tab.navigation, params: { nodeId: 'node-2' } } } }
  view.rerender(<RemoteDesktopTitle {...props} />)
  expect(view.container.textContent).toBe('node-2')
  info = { ...info, tab: { ...info.tab, navigation: { ...info.tab.navigation, params: undefined } } }
  view.rerender(<RemoteDesktopTitle {...props} />)
  expect(view.container.textContent).toBe('Remote desktop')
})

it('removes the target title with its plugin and registers one occurrence on remount', async () => {
  const ctx = new Context()
  const tabs = new SidebarRightTabRegistry(ctx)
  const entries = new Map<string, unknown>()
  ctx.provide('sidebarRightTabs', tabs)
  ctx.provide('locale', { bind: () => (key: string) => key, register: () => () => {} } as never)
  ctx.provide('remoteDesktops', {} as never)
  ctx.provide('slots', {
    inject: (_name: string, register: () => () => void) => register(),
    register: (options: { name: string; key: string }, component: unknown) => {
      const key = `${options.name}:${options.key}`
      entries.set(key, component)
      return () => { entries.delete(key) }
    },
  } as never)
  const titleKey = 'sidebar.right.pane.tab.title:@deepseek-ai/dsh-client-ui-remote-desktop'
  const mount = () => ctx.plugin({ inject: [...inject], apply })
  const first = mount()
  await first.await()
  expect(entries.get(titleKey)).toBe(RemoteDesktopTitle)
  expect(tabs.get('remoteDesktop')?.keepMounted).toBe(true)
  await first.dispose()
  expect(entries.size).toBe(0)
  expect(tabs.get('remoteDesktop')).toBeUndefined()
  const second = mount()
  await second.await()
  expect(entries.get(titleKey)).toBe(RemoteDesktopTitle)
  await second.dispose()
  expect(entries.size).toBe(0)
})
