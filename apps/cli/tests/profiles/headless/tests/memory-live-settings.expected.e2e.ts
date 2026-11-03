/** Shipped headless model requests respect memory withdrawal during pending storage and recall. */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { execa } from 'execa'
import { expect, it } from 'vitest'

const repository = fileURLToPath(new URL('../../../../../../', import.meta.url))
const built = process.env.DSH_EXAMPLE_MODE === 'lib'
const bin = join(repository, built ? 'apps/cli/lib/bin.js' : 'apps/cli/src/bin.ts')
const sourceImport = createRequire(import.meta.url).resolve('tsx/esm')
const fixtures = join(repository, 'examples/headless-agent/tests/fixtures/memory-live-settings')
if (!existsSync(bin)) throw new Error('Live memory settings regression requires its selected CLI entry')
const cases = [
  { phase: 'catalog', kind: 'personal' },
  ...['personal', 'workspace', 'project'].flatMap(kind => ['read', 'search'].map(phase => ({ phase, kind }))),
  { phase: 'recall-response', kind: 'personal' },
  { phase: 'recall-read', kind: 'personal' },
]

it.each(cases)('withdraws $phase data during completion in $kind scope', async ({ phase, kind }) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-live-settings-'))
  try {
    const result = await execa(process.execPath, [...(built ? [] : ['--import', sourceImport]), '--import', join(fixtures, 'register.mjs'), bin,
      '--profile', 'headless', '--patch', join(fixtures, 'cordis.patch.yml'), '--json', 'Review our saved release guidance.'],
    { cwd: root, input: '', timeout: 60_000, killSignal: 'SIGKILL', reject: false,
      env: { ...process.env, NODE_OPTIONS: undefined, NODE_PATH: undefined, DSH_MANAGED_DATA_MANIFEST: undefined,
        TSX_TSCONFIG_PATH: built ? undefined : join(repository, 'tsconfig.json'),
        DSH_MEMORY_FIXTURE_PHASE: phase, DSH_MEMORY_FIXTURE_SCOPE: kind,
        DEEPSEEK_API_KEY: 'keyless-memory-live-settings-no-call', DSH_HOME: join(root, '.dsh'),
        DSH_AGENTS_HOME: join(root, '.agents'), DSH_TELEMETRY_DISABLED: '1', HOME: root, USERPROFILE: root, NODE_NO_WARNINGS: '1' } })
    const row = result.stdout.split('\n').find(line => line.startsWith('memory-live-settings: '))
    if (row === undefined) throw new Error(`Memory completion observation missing: ${result.stderr}\n${result.stdout}`)
    expect({ exitCode: result.exitCode, ...JSON.parse(row.slice('memory-live-settings: '.length)) as Record<string, unknown> }).toEqual({
      exitCode: 0, phase, kind, primaryCalls: phase === 'catalog' ? 1 : 2,
      catalogSeen: phase !== 'catalog', recallSeen: false, toolBodySeen: phase === 'recall-response',
      toolError: phase === 'catalog' || phase === 'recall-response' ? null : 'memory_invalid',
      selectorCancelled: phase.startsWith('recall-') ? true : null,
      ownerContent: 'PRIVATE_RELEASE_BODY', changed: true,
    })
    const results = result.stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line) as unknown)
    expect(results.at(-1)).toEqual({ type: 'final', text: 'Done.' })
  } finally { rmSync(root, { recursive: true, force: true }) }
}, 70_000)
