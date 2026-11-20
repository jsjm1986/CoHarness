/** A cold file preset reaches its first durable model reply without a retry. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { expect, it } from 'vitest'

it('waits for the Host dependency and persists the first reply once', async () => {
  const driver = fileURLToPath(new URL('./fixtures/cold-preset-driver.ts', import.meta.url))
  const result = await runLoaderSmoke({
    label: 'cold file preset', tempDirPrefix: 'dsh-cold-preset-snapshot-', binScript: driver, libBinScript: driver,
    configPath: fileURLToPath(new URL('./fixtures/cold-preset.cordis.yml', import.meta.url)),
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)), sourceImport: 'tsx/esm',
    prepare: async (cwd) => {
      const preset = join(cwd, 'presets', 'cold')
      await mkdir(preset, { recursive: true })
      await writeFile(join(preset, 'agent.cordis.yml'), JSON.stringify([
        { id: 'cold-tool', name: new URL('./fixtures/cold-preset-tool.ts', import.meta.url).href },
      ]))
    },
  })
  expect(result.stderr).toBe('')
  expect(result.stdout).toBe('First create waited for its Host dependency.\n'
    + '{"type":"result","sessionId":"cold-preset","output":"First request includes the ready Host tool."}\n'
    + 'One assistant reply persisted.\n')
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
