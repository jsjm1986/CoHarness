/** User document names and private paths through the real runnable Loader composition. */
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, resolveExampleMode, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

it('lists completed .part uploads and refuses private filesystem aliases through the Loader', async () => {
  const driver = fileURLToPath(new URL('./fixtures/parts-driver.mjs', import.meta.url))
  const artifact = resolveExampleMode() === 'src' ? 'src/index.ts' : 'lib/index.js'
  const configPath = fileURLToPath(new URL('../../../../examples/headless-agent/tests/fixtures/attachment/userdoc-parts/cordis.yml', import.meta.url))
  const result = await runLoaderSmoke({
    label: 'document parts and private paths', tempDirPrefix: 'document-parts-loader-',
    binScript: driver, libBinScript: driver, sourceImport: 'tsx/esm', configPath,
    tsconfigPath: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)),
    env: { DSH_PARTS_BOOT_ENTRY: new URL(`../../../boot/app-boot/${artifact}`, import.meta.url).href,
      DSH_PARTS_VOCABULARY_ENTRY: new URL(`../../userdoc/${artifact}`, import.meta.url).href },
  })
  await expect(result.stdout).toMatchFileSnapshot(fileURLToPath(new URL('./expected/parts-private-paths.jsonl', import.meta.url)))
}, LOADER_SMOKE_TEST_TIMEOUT_MS)

it.skipIf(process.platform !== 'linux')('refuses replaced parents during saves, trash, restore and purge through the Loader', async () => {
  const driver = fileURLToPath(new URL('./fixtures/parent-races-driver.mjs', import.meta.url))
  const artifact = resolveExampleMode() === 'src' ? 'src/index.ts' : 'lib/index.js'
  const configPath = fileURLToPath(new URL('../../../../examples/headless-agent/tests/fixtures/attachment/userdoc-parts/cordis.yml', import.meta.url))
  const result = await runLoaderSmoke({
    label: 'document parent replacement', tempDirPrefix: 'document-parents-loader-',
    binScript: driver, libBinScript: driver, sourceImport: 'tsx/esm', configPath,
    tsconfigPath: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)),
    env: { DSH_PARTS_BOOT_ENTRY: new URL(`../../../boot/app-boot/${artifact}`, import.meta.url).href,
      DSH_PARTS_VOCABULARY_ENTRY: new URL(`../../userdoc/${artifact}`, import.meta.url).href },
  })
  await expect(result.stdout).toMatchFileSnapshot(fileURLToPath(new URL('./expected/parent-races.jsonl', import.meta.url)))
}, LOADER_SMOKE_TEST_TIMEOUT_MS)

it.skipIf(process.platform === 'win32')('refuses existing and replaced POSIX named pipes through the Loader', async () => {
  const driver = fileURLToPath(new URL('./fixtures/fifo-driver.mjs', import.meta.url))
  const artifact = resolveExampleMode() === 'src' ? 'src/index.ts' : 'lib/index.js'
  const configPath = fileURLToPath(new URL('../../../../examples/headless-agent/tests/fixtures/attachment/userdoc-parts/cordis.yml', import.meta.url))
  const result = await runLoaderSmoke({
    label: 'document POSIX named pipes', tempDirPrefix: 'document-fifo-loader-',
    binScript: driver, libBinScript: driver, sourceImport: 'tsx/esm', configPath,
    tsconfigPath: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)),
    env: { DSH_PARTS_BOOT_ENTRY: new URL(`../../../boot/app-boot/${artifact}`, import.meta.url).href,
      DSH_PARTS_VOCABULARY_ENTRY: new URL(`../../userdoc/${artifact}`, import.meta.url).href },
  })
  await expect(result.stdout).toMatchFileSnapshot(fileURLToPath(new URL('./expected/fifo-refusals.jsonl', import.meta.url)))
}, LOADER_SMOKE_TEST_TIMEOUT_MS)

it.skipIf(process.platform !== 'linux')('retains moved bytes when a replaced Linux parent prevents rollback through the Loader', async () => {
  const driver = fileURLToPath(new URL('./fixtures/move-rollback-driver.mjs', import.meta.url))
  const artifact = resolveExampleMode() === 'src' ? 'src/index.ts' : 'lib/index.js'
  const configPath = fileURLToPath(new URL('../../../../examples/headless-agent/tests/fixtures/attachment/userdoc-parts/cordis.yml', import.meta.url))
  const result = await runLoaderSmoke({
    label: 'document move rollback', tempDirPrefix: 'document-move-loader-',
    binScript: driver, libBinScript: driver, sourceImport: 'tsx/esm', configPath,
    tsconfigPath: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)),
    env: { DSH_PARTS_BOOT_ENTRY: new URL(`../../../boot/app-boot/${artifact}`, import.meta.url).href,
      DSH_PARTS_VOCABULARY_ENTRY: new URL(`../../userdoc/${artifact}`, import.meta.url).href },
  })
  await expect(result.stdout).toMatchFileSnapshot(fileURLToPath(new URL('./expected/move-rollback.jsonl', import.meta.url)))
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
