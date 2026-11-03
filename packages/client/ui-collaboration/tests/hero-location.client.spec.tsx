// @vitest-environment jsdom
/** Blank conversations retain exact computer identity without changing the existing Workspace controls. */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { HeroComputerLabel } from '../src/client/HeroComputerLabel.tsx'
import { createBrowserCollaborationTransport } from '../src/client/collaboration-client.ts'
import { zh } from '../src/client/locales.ts'
import type { DeploymentContextSnapshot } from '@deepseek-ai/dsh-client-runtime/client'

afterEach(cleanup)
const account = { status: 'ready', contextVerified: true, context: { user: { id: 7, username: 'test', displayName: 'Test', role: 'member' },
  scope: { kind: 'personal' }, projects: [], environment: { id: '10000000-0000-4000-8000-000000000001',
    nodeId: '10000000-0000-4000-8000-000000000002', nodeName: 'Computer A' } } }
const props = (showComputer: boolean, compact = false, withConversation = true) => ({
  ...(withConversation ? { conversationId: 'draft' } : {}), compact,
  useDeployment: (select: (value: DeploymentContextSnapshot) => unknown) => select({ phase: 'ready', showComputer, aggregateComputers: showComputer }),
  useCollaboration: (select: (value: unknown) => unknown) => select(account),
  useSessions: (select: (value: unknown) => unknown) => select({ byId: {} }),
  t: (key: keyof typeof zh) => zh[key],
}) as unknown as Parameters<typeof HeroComputerLabel>[0]

it('shows the blank base conversation computer and removes it completely in single mode', () => {
  const view = render(<HeroComputerLabel {...props(true)} />)
  expect(screen.getByRole('group', { name: '工作电脑' }).textContent).toBe('Computer A')
  view.rerender(<HeroComputerLabel {...props(false)} />)
  expect(view.container.textContent).toBe('')
  expect(screen.queryByRole('group')).toBeNull()
})

it('uses the conversation owner instead of the page environment and avoids duplicating the compact header', () => {
  const owned = { ...props(true), useSessions: ((select: (value: unknown) => unknown) => select({ byId: {
    draft: { runtime: { kind: 'personal', runtimeId: '10000000-0000-4000-8000-000000000003', nodeName: 'Computer B' } },
  } })) as never }
  const view = render(<HeroComputerLabel {...owned} />)
  expect(screen.getByRole('group', { name: '工作电脑' }).textContent).toBe('Computer B')
  view.rerender(<HeroComputerLabel {...owned} compact />)
  expect(screen.queryByRole('group')).toBeNull()
})

it('identifies a verified empty personal space before a Workspace creates its first conversation', () => {
  const view = render(<HeroComputerLabel {...props(true, false, false)} />)
  expect(screen.getByRole('group', { name: '工作电脑' }).textContent).toBe('Computer A')
  view.rerender(<HeroComputerLabel {...props(false, false, false)} />)
  expect(screen.queryByRole('group')).toBeNull()
  view.rerender(<HeroComputerLabel {...props(true, false, false)} useCollaboration={((select: (value: unknown) => unknown) =>
    select({ ...account, status: 'loading', contextVerified: false })) as never} />)
  expect(screen.queryByRole('group')).toBeNull()
})

it('pins account context to this tab’s exact Runtime without pinning the entry metadata endpoint', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'location')
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { search: '?dshRuntime=10000000-0000-4000-8000-000000000003' } })
  const paths: string[] = []
  try {
    const transport = createBrowserCollaborationTransport({ fetch: (async (path: string) => {
      paths.push(path); return Response.json(account.context)
    }) as typeof fetch })
    await transport.loadContext(new AbortController().signal)
    expect(paths).toEqual(['/account/api/context?dshRuntime=10000000-0000-4000-8000-000000000003'])
  } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, 'location')
    else Object.defineProperty(globalThis, 'location', previous)
  }
})
