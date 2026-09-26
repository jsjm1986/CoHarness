import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'

/**
 * Regression coverage for `pnpm dsh --profile headless` under the source
 * launcher: profile resolution installs the runtime router, whose routed
 * anchors sit inside `node_modules` where the tsx paths mapping does not
 * apply, so plugin entries used to load from `lib/` while their own imports
 * reached `src/` — splitting `Symbol`-keyed facets such as the tool-runtime
 * scheduler. A real tool round trip exercises that seam end to end.
 */

const repoRoot = fileURLToPath(new URL('../../../../../../', import.meta.url))
const dshSourceBin = 'apps/cli/src/bin.ts'
const keylessPatch = fileURLToPath(new URL(
  '../../../../../../examples/headless-agent/tests/fixtures/headless-profile.cordis.yml',
  import.meta.url,
))

const SOURCE_LAUNCH_TIMEOUT_MS = 60_000

describe('headless profile under the tsx source launcher', () => {
  // The headless example wires only the bash executor; Windows hosts compose
  // no shell tool for it, so the round trip has no POSIX-tool carrier there.
  it.skipIf(process.platform === 'win32')('runs a tool round trip without splitting the module plane', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-source-launch-headless-'))
    try {
      const result = await execa(
        process.execPath,
        ['--import', 'tsx/esm', dshSourceBin, '--profile', 'headless', '--patch', keylessPatch, 'run one tool call'],
        {
          cwd: repoRoot,
          env: {
            DSH_HOME: join(home, '.dsh'),
            DSH_AGENTS_HOME: join(home, '.agents'),
            DSH_PERMISSION_MODE: 'danger-full-access',
            DSH_TELEMETRY_DISABLED: '1',
          },
          timeout: SOURCE_LAUNCH_TIMEOUT_MS,
          killSignal: 'SIGKILL',
          reject: false,
        },
      )
      if (result.timedOut) {
        throw new Error(`dsh source launch did not exit within ${SOURCE_LAUNCH_TIMEOUT_MS}ms. stderr:\n${result.stderr}`)
      }
      expect(result.stdout).toContain('CLI_TOOL_ROUND_TRIP')
      expect(result.stderr).not.toContain('dsh: UNKNOWN:')
      expect(result.exitCode).toBe(0)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, SOURCE_LAUNCH_TIMEOUT_MS + 15_000)
})
