/** Keyless terminal teardown transcript through the actual Loader and native PTY. */
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, resolveExampleMode, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

it.skipIf(process.platform === 'win32')('joins terminal sessions through frozen clocks and recovered cleanup failures', async () => {
  const mode = resolveExampleMode()
  const driver = fileURLToPath(new URL('./fixtures/terminal-clock-driver.mjs', import.meta.url))
  const result = await runLoaderSmoke({
    label: 'local terminal monotonic termination', tempDirPrefix: 'subprocess-terminal-clock-loader-',
    binScript: driver, libBinScript: driver, sourceImport: 'tsx/esm',
    configPath: fileURLToPath(new URL('../../../../examples/headless-agent/tests/fixtures/subprocess/subprocess-local/cordis.yml', import.meta.url)),
    tsconfigPath: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)),
    env: {
      DSH_TERMINAL_CLOCK_BOOT_ENTRY: new URL(`../../../boot/app-boot/${mode === 'src' ? 'src/index.ts' : 'lib/index.js'}`, import.meta.url).href,
      DSH_TERMINAL_CLOCK_WINDOWS_INSPECTOR_ENTRY: new URL(`../${mode === 'src' ? 'src/windows-inspector.ts' : 'lib/types/windows-inspector.js'}`, import.meta.url).href,
      DSH_TERMINAL_CLOCK_POSIX_INSPECTOR_ENTRY: new URL(`../${mode === 'src' ? 'src/process-inspector.ts' : 'lib/types/process-inspector.js'}`, import.meta.url).href,
    },
  })
  expect(result.stderr).toBe('')
  await expect(result.stdout).toMatchFileSnapshot(fileURLToPath(new URL('./expected/terminal-clock.expected.md', import.meta.url)))
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
