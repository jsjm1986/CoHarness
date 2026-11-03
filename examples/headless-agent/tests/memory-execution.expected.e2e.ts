import { readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { expect, it } from 'vitest'

const config = fileURLToPath(new URL('../memory-execution.cordis.snapshot.yml', import.meta.url))
const driver = fileURLToPath(new URL('./fixtures/memory-execution-driver.ts', import.meta.url))
const expected = fileURLToPath(new URL('./fixtures/memory-execution/expected/queued-participants.expected.jsonl', import.meta.url))

it('attributes queued extraction requests and writes to their own triggering participant', async () => {
  const result = await runLoaderSmoke({
    label: 'queued memory execution snapshot', tempDirPrefix: 'headless-memory-execution-',
    binScript: driver, libBinScript: driver, configPath: config,
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)), sourceImport: 'tsx/esm',
  })
  expect(result.stderr).toBe('')
  expect(result.stdout).toBe(await readFile(expected, 'utf8'))
}, LOADER_SMOKE_TEST_TIMEOUT_MS)

it.each([
  ['user', 'save'], ['user', 'delete'], ['project', 'save'], ['project', 'delete'],
  ['disconnect', 'save'], ['disconnect', 'delete'], ['unrelated-user', 'save'], ['unrelated-user', 'delete'],
] as const)('rechecks idle project memory after %s invalidation during %s', async (revocation, operation) => {
  const result = await runConfiguredScenario(`revocation: ${revocation}\n    operation: ${operation}`)
  expect(result.stderr).toBe('')
  expect(result.stdout).toBe(await readFile(new URL(`./fixtures/memory-execution/expected/${revocation}-${operation}.expected.jsonl`, import.meta.url), 'utf8'))
}, LOADER_SMOKE_TEST_TIMEOUT_MS)

it('cancels a delivery into a real cold fork before Gateway registration', async () => {
  const result = await runConfiguredScenario('cancelledRegistration: true')
  expect(result.stderr).toBe('')
  expect(result.stdout).toBe(await readFile(new URL('./fixtures/memory-execution/expected/cancelled-registration.expected.jsonl', import.meta.url), 'utf8'))
}, LOADER_SMOKE_TEST_TIMEOUT_MS)

it('binds read-only recall to the admitted Gateway participant', async () => {
  const result = await runConfiguredScenario('recall: true')
  expect(result.stderr).toBe('')
  expect(JSON.parse(result.stdout) as unknown).toEqual({ inputActors: [2], requestActor: 2, scopeActor: 2,
    enteredActor: 2, injectedActor: 2, primaryRequests: 2, requestCount: 1, memoryWritingDenied: true, outcomeRefused: false,
    primaryModel: 'memory-execution-current', selectorModel: 'memory-execution-current' })
}, LOADER_SMOKE_TEST_TIMEOUT_MS)

it.each(['error', 'aborted'] as const)('does not inject valid selector JSON after a Gateway recall %s outcome', async (kind) => {
  const result = await runConfiguredScenario(`recall: true\n    recallTerminal: ${kind}`)
  expect(result.stderr).toBe('')
  expect(JSON.parse(result.stdout) as unknown).toEqual({ inputActors: [2], requestActor: 2, scopeActor: 2,
    enteredActor: 2, injectedActor: null, primaryRequests: 1, requestCount: 1, memoryWritingDenied: true, outcomeRefused: true,
    primaryModel: 'memory-execution-current', selectorModel: 'memory-execution-current' })
}, LOADER_SMOKE_TEST_TIMEOUT_MS)

async function runConfiguredScenario(settings: string) {
  const [base, scenario] = await Promise.all([
    readFile(new URL('../cordis.yml', import.meta.url), 'utf8'), readFile(config, 'utf8'),
  ])
  const fixture = new URL('./fixtures/memory-execution-model.ts', import.meta.url).href
  const composition = settings.startsWith('recall: true')
    ? scenario.replace('extraction: true', 'extraction: false\n              recall: true') : scenario
  return runLoaderSmoke({
    label: 'memory execution lifecycle', tempDirPrefix: 'headless-memory-execution-lifecycle-',
    binScript: driver, libBinScript: driver, configPath: config,
    binArgs: ['./memory-execution.cordis.yml'],
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)), sourceImport: 'tsx/esm',
    prepare: async (cwd) => {
      await writeFile(join(cwd, 'cordis.yml'), base)
      await writeFile(join(cwd, 'memory-execution.cordis.yml'), composition.replace(
        "name: './tests/fixtures/memory-execution-model.ts'", `name: '${fixture}'\n  config:\n    ${settings}`,
      ))
      await symlink(fileURLToPath(new URL('../../node_modules', import.meta.url)), join(cwd, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    },
  })
}
