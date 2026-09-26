/** Shipped profile dispatches inspection and rejects retired dynamic-code tools. */
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

const binScript = fileURLToPath(new URL('../../../../../../packages/test-support/loader-smoke/tests/fixtures/headless-driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('../../../../../../examples/headless-agent/tests/fixtures/extensions/tool-cordis/cordis.patch.yml', import.meta.url))

it('executes three read-only tools and refuses every retired name through the real Loader profile', async () => {
  const { stdout, stderr } = await runLoaderSmoke({
    label: 'Cordis read-only inspection', tempDirPrefix: 'cordis-inspection-',
    binScript, libBinScript: binScript, configPath,
    binArgs: [configPath, 'Inspect the runtime and verify unavailable operations.'],
    tsconfigPath: fileURLToPath(new URL('../../../../../../tsconfig.json', import.meta.url)),
    processTimeoutMs: 60_000,
    env: { DSH_LOADER_SMOKE_REQUIRED_ENTRY_ID: 'cordis-inspection-llm', DSH_TELEMETRY_DISABLED: '1' },
  })
  const rows = stdout.trim().split('\n').map(line => JSON.parse(line) as { type: string; event?: SessionEvent; output?: string })
  const events = rows.flatMap(row => row.event === undefined ? [] : [row.event])
  const calls = events.filter(event => event.type === 'tool/call')
  const results = events.filter(event => event.type === 'tool/result')
  expect(calls.map(event => event.data.name)).toEqual([
    'cordis_inspect_list', 'cordis_inspect_query', 'cordis_inspect_self',
    'cordis_define', 'cordis_run', 'cordis_stop', 'cordis_undefine',
  ])
  expect(results).toHaveLength(7)
  expect(results.slice(0, 3).map(event => event.data.message.content[0].isError)).toEqual([false, false, false])
  for (const event of results.slice(3)) {
    expect(event.data.message.content[0].isError).toBe(true)
    expect(event.data.error).toMatchObject({ name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL' })
  }
  const inspected = JSON.stringify(results[1]?.data.message.content)
  expect(inspected).toContain('cordis_inspect_self')
  expect(inspected).not.toContain('cordis_define')
  expect(rows.at(-1)).toMatchObject({ type: 'result', output: 'CORDIS_READ_ONLY_OK' })
  expect(stderr).toBe('')
}, 75_000)
