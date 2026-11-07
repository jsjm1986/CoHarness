// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { DeploymentContextSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { CollaborationSnapshot } from '../src/client/collaboration-client.ts'
import { SettingsComputerLabel } from '../src/client/SettingsComputerLabel.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

it('keeps the verified configuration owner while another environment opens in a separate tab', () => {
  const deployment = createSnapshotStore<DeploymentContextSnapshot>({ phase: 'ready', showComputer: true, aggregateComputers: true })
  const collaboration = createSnapshotStore<CollaborationSnapshot>({ status: 'ready', contextVerified: true,
    scopeBusy: false, stagedVisibility: 'project', conversations: {}, context: {
      user: { id: 1, username: 'qa', displayName: 'QA', role: 'user' }, scope: { kind: 'personal' }, projects: [],
      environment: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as never,
        nodeId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as never, nodeName: 'Configuration owner' },
    } })
  const openEnvironmentPickerTab = vi.fn()
  const before = collaboration.getSnapshot()
  render(<SettingsComputerLabel useDeployment={bindSnapshotSelector(deployment)}
    useCollaboration={bindSnapshotSelector(collaboration)} t={makeTranslate(zh, {})}
    openEnvironmentPickerTab={openEnvironmentPickerTab} />)
  expect(screen.getByText('Configuration owner')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '在新标签页管理其他环境' }))
  expect(openEnvironmentPickerTab).toHaveBeenCalledOnce()
  expect(collaboration.getSnapshot()).toBe(before)
  act(() => { deployment.set({ phase: 'ready', showComputer: true, aggregateComputers: false }) })
  expect(screen.getByText('Configuration owner')).toBeTruthy()
  expect(screen.queryByRole('button')).toBeNull()
  act(() => { deployment.set({ phase: 'ready', showComputer: false, aggregateComputers: false }) })
  expect(screen.queryByText('Configuration owner')).toBeNull()
})

it('does not present retained account data as a verified configuration owner', () => {
  const collaboration = createSnapshotStore<CollaborationSnapshot>({ status: 'loading', contextVerified: false,
    scopeBusy: false, stagedVisibility: 'project', conversations: {} })
  const deployment = createSnapshotStore<DeploymentContextSnapshot>({ phase: 'ready', showComputer: true, aggregateComputers: true })
  const { container } = render(<SettingsComputerLabel useDeployment={bindSnapshotSelector(deployment)}
    useCollaboration={bindSnapshotSelector(collaboration)} t={makeTranslate(zh, {})} openEnvironmentPickerTab={vi.fn()} />)
  expect(container.textContent).toBe('')
  expect(screen.queryByRole('button')).toBeNull()
})
