/** Public Inspector option resolution refuses invalid endpoint and buffering limits before allocation. */
import { expect, it } from 'vitest'
import { resolveInspectorOptions, type InspectorOptions } from '../src/host/bridge/controller.ts'

it.each([
  [{ port: 65_536 }, /port must not exceed 65535/u],
  [{ port: -1 }, /port must be a non-negative safe integer/u],
  [{ startupTimeoutMs: 0 }, /startupTimeoutMs must be a positive safe integer/u],
  [{ maxBodyChunkBytes: 1_000_000, maxSourceFrameBytes: 4096 }, /cannot carry one base64 body chunk/u],
  [{ clientReconnectBaseMs: 100, clientReconnectMaxMs: 50 }, /must be at least clientReconnectBaseMs/u],
  [{ clientOrigins: ['http://localhost/path'] }, /client origin must be canonical/u],
] satisfies Array<[InspectorOptions, RegExp]>)('refuses options %j with %s', (options, message) => {
  expect(() => resolveInspectorOptions(options)).toThrow(message)
})

it('accepts canonical Client origins and OS-assigned endpoint ports', () => {
  expect(resolveInspectorOptions({ port: 0, clientOrigins: ['http://localhost:4000'] }))
    .toMatchObject({ port: 0, clientOrigins: ['http://localhost:4000'] })
})
