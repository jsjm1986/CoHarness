/** Deployment polling retains one request owner through slow reads, aggregated mount seeding, and unmount. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as api from '../api.ts'
import { DeploymentPage } from './DeploymentPage.tsx'
import { useDeploymentContext } from '../deployment-context.tsx'
import { useDeploymentOverview } from '../deployment-overview.tsx'
import { deploymentContextSchema } from '../../../src/deployment-protocol.ts'

let observedOverview: ReturnType<typeof useDeploymentOverview> = null

vi.mock('../api.ts', async original => ({
  ...await original<typeof api>(),
  getDeploymentOverview: vi.fn(),
  getDeployment: vi.fn(),
  listBackups: vi.fn(),
}))
vi.mock('./DeploymentTopologySection.tsx', () => ({ DeploymentTopologySection: () => null, NodeConnectionSection: () => null }))
vi.mock('./NodeAccessSection.tsx', () => ({ NodeAccessSection: () => null }))
vi.mock('./NodeConfigurationSection.tsx', () => ({
  NodeConfigurationSection: () => {
    observedOverview = useDeploymentOverview()
    return null
  },
}))
vi.mock('./PerformanceDiagnosticsSection.tsx', () => ({ PerformanceDiagnosticsSection: () => null }))
vi.mock('./TunnelAccessSection.tsx', () => ({ TunnelAccessSection: () => null }))
vi.mock('./NodeContentSection.tsx', () => ({ NodeContentSection: () => null }))
vi.mock('./NodeContentMigrationSection.tsx', () => ({ NodeContentMigrationSection: () => null }))
vi.mock('./LocalRecoveryExecutionSection.tsx', () => ({ LocalRecoveryExecutionSection: () => <p>local recovery entry</p> }))
vi.mock('../components/RuntimeAllocationPolicyEditor.tsx', () => ({ RuntimeAllocationPolicyEditor: () => null }))
vi.mock('../deployment-context.tsx', () => ({ useDeploymentContext: vi.fn() }))

const reads: Array<ReturnType<typeof Promise.withResolvers<api.DeploymentOverviewResponse>>> = []
const policy = deploymentContextSchema.parse({ mode: 'single', revision: '0',
  entry: { nodeId: '10000000-0000-4000-8000-000000000001', name: 'A' }, primary: null,
  scope: 'local', role: 'standalone', refreshAfterMs: 30000, legacyMigrationRequired: false })

function overviewOf(state: api.DeploymentState, backups: api.DeploymentBackup[] = []): api.DeploymentOverviewResponse {
  return {
    sections: {
      deployment: { ok: true, value: state },
      backups: { ok: true, value: { backups } },
    },
  }
}

beforeEach(() => {
  observedOverview = null
  vi.useFakeTimers()
  vi.resetAllMocks()
  vi.stubGlobal('localStorage', { getItem: () => 'zh' })
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  vi.mocked(useDeploymentContext).mockReturnValue({ value: policy, error: false, refresh: async () => {} })
  vi.mocked(api.listBackups).mockResolvedValue({ backups: [] })
  vi.mocked(api.getDeployment).mockResolvedValue({
    mode: 'serving', maintenanceEpoch: '1', writeEpoch: '1', reason: null,
    enteredAt: null, updatedAt: '2026-11-16T00:00:00Z', nodes: [], writersQuiesced: true, migrations: null, operations: [],
  })
  vi.mocked(api.getDeploymentOverview).mockImplementation(() => {
    const read = Promise.withResolvers<api.DeploymentOverviewResponse>()
    reads.push(read)
    return read.promise
  })
})

afterEach(async () => {
  cleanup()
  for (const read of reads) read.reject(new Error('Owned test read released'))
  await Promise.allSettled(reads.splice(0).map(read => read.promise))
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('loads entry policy before adding cluster and backup polling', async () => {
  vi.mocked(useDeploymentContext).mockReturnValue({ value: null, error: false, refresh: async () => {} })
  const view = render(<DeploymentPage />)
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
  expect(api.getDeploymentOverview).not.toHaveBeenCalled()
  expect(api.getDeployment).not.toHaveBeenCalled()
  expect(api.listBackups).not.toHaveBeenCalled()
  vi.mocked(useDeploymentContext).mockReturnValue({ value: policy, error: false, refresh: async () => {} })
  view.rerender(<DeploymentPage />)
  expect(api.getDeploymentOverview).toHaveBeenCalledTimes(1)
  expect(vi.mocked(api.getDeploymentOverview).mock.calls[0]![0]).toEqual(
    expect.arrayContaining(['deployment', 'backups', 'tunnel', 'nodeConfiguration', 'runtimeAllocationPolicy']),
  )
})

it('does not overlap slow periodic reads and aborts their transport on unmount', async () => {
  const view = render(<DeploymentPage />)
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
  expect(api.getDeploymentOverview).toHaveBeenCalledTimes(1)
  expect(api.getDeployment).not.toHaveBeenCalled()
  expect(api.listBackups).not.toHaveBeenCalled()
  const signal = vi.mocked(api.getDeploymentOverview).mock.calls[0]![1]!
  expect(signal.aborted).toBe(false)
  view.unmount()
  expect(signal.aborted).toBe(true)
})

it('coalesces explicit refreshes into one read after the current read settles', async () => {
  render(<DeploymentPage />)
  fireEvent.click(screen.getByRole('button', { name: '刷新' }))
  fireEvent.click(screen.getByRole('button', { name: '刷新' }))
  expect(api.getDeploymentOverview).toHaveBeenCalledTimes(1)
  await act(async () => { reads[0]!.reject(new Error('First snapshot failed')) })
  expect(api.getDeploymentOverview).toHaveBeenCalledTimes(2)
  expect(vi.mocked(api.getDeploymentOverview).mock.calls[1]![0]).toEqual(['deployment', 'backups'])
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
  expect(api.getDeploymentOverview).toHaveBeenCalledTimes(2)
})

it('publishes initial overview slices to child sections and falls back to legacy routes on 404', async () => {
  const view = render(<DeploymentPage />)
  expect(observedOverview?.status).toBe('loading')
  await act(async () => {
    reads[0]!.reject(new api.AdminRequestError(404, 'not found', 'not found'))
  })
  expect(api.getDeployment).toHaveBeenCalledTimes(1)
  expect(api.listBackups).toHaveBeenCalledTimes(1)
  expect(observedOverview?.status).toBe('fallback')
  view.unmount()
})

it('releases sections to independent reads when the aggregated snapshot is slow', async () => {
  render(<DeploymentPage />)
  expect(observedOverview?.status).toBe('loading')
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
  expect(observedOverview?.status).toBe('fallback')
  await act(async () => {
    reads[0]!.resolve(overviewOf({ mode: 'serving', maintenanceEpoch: '1', writeEpoch: '1', reason: null,
      enteredAt: null, updatedAt: '2026-11-16T00:00:00Z', nodes: [], writersQuiesced: true, migrations: null, operations: [] }))
  })
  // The late aggregate still updates the page's own state but never reseeds sections that already read independently.
  expect(observedOverview?.status).toBe('fallback')
  expect(api.getDeploymentOverview).toHaveBeenCalledTimes(1)
})

it.each(['single', 'multi'] as const)('shows the local recovery entry only in single-computer mode: %s', async mode => {
  vi.mocked(useDeploymentContext).mockReturnValue({ value: deploymentContextSchema.parse({ ...policy, mode,
    ...(mode === 'multi' ? { role: 'computer', primary: { ...policy.entry, origin: 'https://primary.test' } } : {}) }),
  error: false, refresh: async () => {} })
  render(<DeploymentPage />)
  await act(async () => {
    reads[0]!.resolve(overviewOf({ mode: 'serving', maintenanceEpoch: '1', writeEpoch: '1', reason: null,
      enteredAt: null, updatedAt: '2026-11-16T00:00:00Z', nodes: [], writersQuiesced: true, migrations: null, operations: [] }))
  })
  expect(observedOverview?.status).toBe('ready')
  expect(screen.queryByText('local recovery entry') !== null).toBe(mode === 'single')
})
