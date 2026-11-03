/** Native Codex requests use the Agent's SSH realm and original parent admission. */
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { resolveExampleMode, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

it.skipIf(process.platform === 'win32').each(['one-shot', 'member', 'revoked', 'quota', 'durability', 'nested', 'nested-revoked', 'retired'] as const)(
  'governs remote native Codex through its Loader composition: %s', async (mode) => {
    const driver = fileURLToPath(new URL('./fixtures/managed-ssh-driver.mjs', import.meta.url))
    const configName = mode.startsWith('nested') ? 'subagent-codex-managed-nested' : 'subagent-codex-managed-ssh'
    const configPath = fileURLToPath(new URL(`../../../../examples/headless-agent/tests/fixtures/subagent/${configName}/cordis.yml`, import.meta.url))
    const artifact = resolveExampleMode() === 'src' ? 'src/index.ts' : 'lib/index.js'
    const result = await runLoaderSmoke({ label: `managed SSH Codex ${mode}`, tempDirPrefix: 'managed-ssh-codex-',
      binScript: driver, libBinScript: driver, configPath, binArgs: [configPath, mode], sourceImport: 'tsx/esm',
      tsconfigPath: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)), processTimeoutMs: 60_000,
      env: { DSH_SSH_CODEX_BOOT_ENTRY: new URL(`../../../boot/app-boot/${artifact}`, import.meta.url).href },
    })
    await expect(result.stdout).toMatchFileSnapshot(fileURLToPath(new URL(`./expected/managed-ssh-${mode}.jsonl`, import.meta.url)))
  }, 75_000,
)
