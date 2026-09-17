/** Standing preset installation failure and retry through the real Loader. */
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

it('rolls back a failed preset and includes its tools in the retried first request', async () => {
  const binScript = fileURLToPath(new URL('./fixtures/headless-driver.ts', import.meta.url))
  const configPath = fileURLToPath(new URL('./fixtures/serial-preset.cordis.yml', import.meta.url))
  const result = await runLoaderSmoke({
    label: 'serial preset creation',
    tempDirPrefix: 'dsh-serial-preset-',
    binScript,
    libBinScript: binScript,
    configPath,
    binArgs: [configPath, 'Inspect the preset.'],
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  })
  expect(result.stderr).toBe('')
  const lines = result.stdout.trimEnd().split('\n')
  expect(lines[0]).toBe('Conflicting preset rejected; Agent and Session rolled back.')
  expect(JSON.parse(lines.at(-1)!)).toEqual({
    type: 'result', sessionId: 'serial-preset', output: 'First request includes subagent and projected input.',
  })
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
