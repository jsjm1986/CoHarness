/** Deployment polling retains one request owner through slow reads and unmount. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as api from '../api.ts'
import { DeploymentPage } from './DeploymentPage.tsx'
import { useDeploymentContext } from '../deployment-context.tsx'
import { deploymentContextSchema } from '../../../src/deployment-protocol.ts'

vi.mock('../api.ts', async original => ({ ...await original<typeof api>(), getDeployment: vi.fn(), listBackups: vi.fn() }))
vi.mock('./DeploymentTopologySection.tsx', () => ({ DeploymentTopologySection: () => null, NodeConnectionSection: () => null }))
vi.mock('./NodeAccessSection.tsx', () => ({ NodeAccessSection: () => null }))
vi.mock('./NodeConfigurationSection.tsx', () => ({ NodeConfigurationSection: () => null }))
vi.mock('./TunnelAccessSection.tsx', () => ({ TunnelAccessSection: () => null }))
vi.mock('../components/RuntimeAllocationPolicyEditor.tsx', () => ({ RuntimeAllocationPolicyEditor: () => null }))
vi.mock('../deployment-context.tsx', () => ({ useDeploymentContext: vi.fn() }))

const reads: Array<ReturnType<typeof Promise.withResolvers<api.DeploymentState>>> = []
const policy = deploymentContextSchema.parse({ mode: 'single', revision: '0',
  entry: { nodeId: '10000000-0000-4000-8000-000000000001', name: 'A' }, primary: null,
  scope: 'local', role: 'standalone', refreshAfterMs: 30000, legacyMigrationRequired: false })
beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  vi.stubGlobal('localStorage', { getItem: () => 'zh' })
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  vi.mocked(useDeploymentContext).mockReturnValue({ value: policy, error: false, refresh: async () => {} })
  vi.mocked(api.listBackups).mockResolvedValue({ backups: [] })
  vi.mocked(api.getDeployment).mockImplementation(() => {
    const read = Promise.withResolvers<api.DeploymentState>()
    reads.push(read)
    return read.promise
  })
})

it('loads entry policy before adding cluster and backup polling', async () => {
  vi.mocked(useDeploymentContext).mockReturnValue({ value: null, error: false, refresh: async () => {} })
  const view = render(<DeploymentPage />)
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
  expect(api.getDeployment).not.toHaveBeenCalled()
  expect(api.listBackups).not.toHaveBeenCalled()
  vi.mocked(useDeploymentContext).mockReturnValue({ value: policy, error: false, refresh: async () => {} })
  view.rerender(<DeploymentPage />)
  expect(api.getDeployment).toHaveBeenCalledTimes(1)
})
afterEach(async () => {
  cleanup()
  for (const read of reads) read.reject(new Error('Owned test read released'))
  await Promise.allSettled(reads.splice(0).map(read => read.promise))
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('does not overlap slow periodic reads and aborts their transport on unmount', async () => {
  const view = render(<DeploymentPage />)
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
  expect(api.getDeployment).toHaveBeenCalledTimes(1)
  expect(api.listBackups).toHaveBeenCalledTimes(1)
  const signal = vi.mocked(api.getDeployment).mock.calls[0]![0]!
  expect(signal.aborted).toBe(false)
  view.unmount()
  expect(signal.aborted).toBe(true)
})

it('coalesces explicit refreshes into one read after the current read settles', async () => {
  render(<DeploymentPage />)
  fireEvent.click(screen.getByRole('button', { name: '刷新' }))
  fireEvent.click(screen.getByRole('button', { name: '刷新' }))
  expect(api.getDeployment).toHaveBeenCalledTimes(1)
  await act(async () => { reads[0]!.reject(new Error('First snapshot failed')) })
  expect(api.getDeployment).toHaveBeenCalledTimes(2)
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
  expect(api.getDeployment).toHaveBeenCalledTimes(2)
})
