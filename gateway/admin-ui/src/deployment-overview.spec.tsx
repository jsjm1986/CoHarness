/** Descendant deployment sections hydrate from DeploymentOverviewProvider without redundant mount GETs. */
import { StrictMode } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as api from './api.ts'
import { DeploymentOverviewProvider, type DeploymentOverviewState } from './deployment-overview.tsx'
import { useDeploymentContext } from './deployment-context.tsx'
import { NodeConfigurationSection } from './pages/NodeConfigurationSection.tsx'
import { TunnelAccessSection } from './pages/TunnelAccessSection.tsx'
import { RuntimeAllocationPolicyEditor } from './components/RuntimeAllocationPolicyEditor.tsx'
import { deploymentContextSchema } from '../../src/deployment-protocol.ts'
import { NODE_CONFIG_FIELDS, type NodeSettingValues } from '../../src/node-config-fields.ts'

vi.mock('./api.ts', async original => ({
  ...await original<typeof api>(),
  getNodeConfiguration: vi.fn(),
  getTunnelAccess: vi.fn(),
  getRuntimeAllocationPolicy: vi.fn(),
  getDesktopEnvironment: vi.fn(),
}))
vi.mock('./deployment-context.tsx', () => ({ useDeploymentContext: vi.fn() }))
vi.mock('./pending-edits.tsx', () => ({ usePendingEdits: () => {} }))

const policy = deploymentContextSchema.parse({
  mode: 'single',
  revision: '1',
  entry: { nodeId: '10000000-0000-4000-8000-000000000001', name: 'A' },
  primary: null,
  scope: 'local',
  role: 'standalone',
  refreshAfterMs: 30000,
  legacyMigrationRequired: false,
})

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('localStorage', { getItem: () => 'en' })
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  vi.mocked(useDeploymentContext).mockReturnValue({ value: policy, error: false, refresh: async () => {} })
  vi.mocked(api.getDesktopEnvironment).mockRejectedValue(new Error('unavailable'))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('hydrates child deployment sections from one overview snapshot with zero extra mount GET requests', async () => {
  const requested = new Set<api.DeploymentOverviewSectionKey>(['tunnel', 'nodeConfiguration', 'runtimeAllocationPolicy'])
  const loading: DeploymentOverviewState = { status: 'loading', requested, sections: null }
  const configuration: NodeSettingValues = {
    ...Object.fromEntries(NODE_CONFIG_FIELDS.map(({ key }) => [key, ''])) as NodeSettingValues,
    HGW_PUBLIC_ORIGINS: 'https://example.test',
  }
  const ready: DeploymentOverviewState = {
    status: 'ready',
    requested,
    sections: {
      tunnel: {
        ok: true,
        value: {
          supported: true, binary: null, mode: 'off', desired: 'stopped', state: 'stopped',
          publicUrl: null, hostname: null, domain: null, apiTokenConfigured: false,
          lastError: null, revision: 1, startedAt: null, updatedAt: '2026-11-23T00:00:00Z',
        },
      },
      nodeConfiguration: {
        ok: true,
        value: {
          organizationId: '00000000-0000-4000-8000-000000000001',
          nodeId: '10000000-0000-4000-8000-000000000001',
          revision: 3,
          runningRevision: 3,
          appliedRevision: 3,
          desired: configuration,
          effective: configuration,
          configFile: '/var/lib/dsh/gateway.env',
          operation: null,
        },
      },
      runtimeAllocationPolicy: {
        ok: true,
        value: { revision: '5', maxTotal: 8, maxPerNode: 4, source: 'organization' },
      },
    },
  }

  const tree = (value: DeploymentOverviewState) => (
    <StrictMode>
      <DeploymentOverviewProvider value={value}>
        <RuntimeAllocationPolicyEditor />
        <TunnelAccessSection />
        <NodeConfigurationSection />
      </DeploymentOverviewProvider>
    </StrictMode>
  )

  const view = render(tree(loading))
  expect(api.getTunnelAccess).not.toHaveBeenCalled()
  expect(api.getNodeConfiguration).not.toHaveBeenCalled()
  expect(api.getRuntimeAllocationPolicy).not.toHaveBeenCalled()

  view.rerender(tree(ready))
  await waitFor(() => {
    expect(screen.getByDisplayValue('8')).toBeTruthy()
    expect(screen.getByDisplayValue('4')).toBeTruthy()
  })
  expect(api.getTunnelAccess).not.toHaveBeenCalled()
  expect(api.getNodeConfiguration).not.toHaveBeenCalled()
  expect(api.getRuntimeAllocationPolicy).not.toHaveBeenCalled()
})
