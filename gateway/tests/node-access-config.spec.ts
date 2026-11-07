/** Enrollment and lease configuration is validated before the center starts serving. */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { testConfig } from './test-config.ts'

const root = join(tmpdir(), 'parser-only-node-access')

it('resolves configurable enrollment, lease, heartbeat and control admission limits', () => {
  expect(testConfig(root).nodeAccess).toEqual({ enrollmentTtlMs: 600_000, leaseMs: 30_000, heartbeatMs: 5_000, maxInFlight: 16 })
  expect(testConfig(root, { HGW_NODE_AGENT_LEASE_MS: '900', HGW_NODE_AGENT_HEARTBEAT_MS: '300', HGW_NODE_CONTROL_MAX_INFLIGHT: '2' }).nodeAccess)
    .toMatchObject({ leaseMs: 900, heartbeatMs: 300, maxInFlight: 2 })
})

it.each([
  { HGW_NODE_ENROLLMENT_TTL_MS: '0' },
  { HGW_NODE_AGENT_LEASE_MS: '1000', HGW_NODE_AGENT_HEARTBEAT_MS: '500' },
  { HGW_NODE_AGENT_HEARTBEAT_MS: '0' },
  { HGW_NODE_CONTROL_MAX_INFLIGHT: '0' },
])('refuses invalid control limits %j', environment => { expect(() => testConfig(root, environment)).toThrow() })
