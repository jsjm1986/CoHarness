/** ClientRoster dependency cones: a dsh.client.inject edge pulls a package's real client graph into the assembly. */
import { describe, expect, it } from 'vitest'
import { webApp } from '../src/assembly/bundle-roster.ts'
import { MODULES_PACKAGE } from '../src/assembly/modules.ts'
import { TestClient } from '../src/assembly/test-client.ts'

const HMR_PACKAGE = '@deepseek-ai/dsh-client-hmr'
const REMOTES_PACKAGE = '@deepseek-ai/dsh-api-remotes'

/** Modules plus client-hmr: the only rows hmr's manifest edge makes the closure take. */
const hmrRoster = webApp.closure([HMR_PACKAGE])
/** Remotes plus its dsh.client.inject cone: gateway, the Typert registry, and connection (no runtime row). */
const apiRoster = webApp.closure([REMOTES_PACKAGE])

describe('package-level dsh.client.inject dependencies', () => {
  it('lets an entry-point row provide a service the first row injects without Loader entries', async () => {
    // hmr declares the dsh.client.inject edge its `modules` service need
    // maps to, so the cone mounts both rows, kept in roster order.
    expect(hmrRoster.rows.map(row => row.name)).toEqual([HMR_PACKAGE, MODULES_PACKAGE])
    // The cone has no Connection row, so there is no readiness handshake to await.
    const client = await TestClient.start(hmrRoster, undefined, { awaitConnected: false })
    try {
      // The connection is not in hmr's cone at all: it is absent, not a stub.
      expect(client.ctx.get('connection')).toBeUndefined()
      // And hmr ran: it sees the live module table modules put on loader.internal.
      expect(client.modules.import(MODULES_PACKAGE, '', {})).toBeDefined()
      expect(client.ctx.get('modules')).toBeDefined()
    } finally { await client.dispose() }
  })

  it('pulls a whole dependency cone transitively and composes the Remote face', async () => {
    // The cone carries Connection without the runtime row, so the harness owns
    // the stream loop and the mock answers its handshake.
    const client = await TestClient.start(apiRoster)
    try {
      expect(client.ctx.get('typert')).toBeDefined()
      expect(client.ctx.get('remote')).toBeDefined()
    } finally { await client.dispose() }
  })
})
