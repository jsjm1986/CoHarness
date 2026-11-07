/** Plain Node exercises compiled browser ownership and MCP process accounting. */
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it('retries a failed Agent cleanup through the compiled MCP browser owner', async ({ signal }) => {
  const result = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('./fixtures/mcp-cleanup.mjs', import.meta.url)),
  ], { signal, env: {} })
  expect(JSON.parse(result.stdout)).toEqual({ occupied: 0, allocations: 1, registrationReleased: true })
})
