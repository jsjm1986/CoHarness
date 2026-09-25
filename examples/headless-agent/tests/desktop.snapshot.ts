/** Product CLI desktop transcripts and independent evidence that denied calls never dispatch. */
import { copyFile, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { normalizeSessionSnapshot } from '@deepseek-ai/dsh-acp-snapshot'
import { runLoaderSmoke, LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'

const root = resolve(import.meta.dirname, '../../..')
const upstreamFixture = join(root, 'snapshots/session/computer-use-cua-driver-mcp')
const overlay = join(import.meta.dirname, 'fixtures/desktop.cordis.yml')
const refreshing = process.env.DSH_SNAPSHOT === 'refresh'

it.each([false, true])('runs the product desktop transcript with managed authority required=%s', async (managed) => {
  const expected = join(import.meta.dirname, 'snapshots', managed ? 'desktop-managed-denied' : 'desktop-local')
  const result = await runLoaderSmoke({
    label: `desktop ${managed ? 'managed rejection' : 'local execution'} snapshot`,
    tempDirPrefix: 'dsh-desktop-snapshot-',
    binScript: join(root, 'apps/cli/src/bin.ts'),
    configPath: overlay,
    binArgs: ['--profile', 'headless', '--patch', overlay, 'Capture display zero, then report DONE.'],
    tsconfigPath: join(root, 'tsconfig.json'),
    env: {
      DSH_SNAPSHOT_FILE: join(upstreamFixture, 'session.v3.jsonl'),
      DSH_SNAPSHOT_OVERRIDE: join(upstreamFixture, 'replay.override.json'),
      DSH_TEST_MANAGED_DESKTOP: String(managed),
      DSH_PERMISSION_MODE: 'danger-full-access',
      DSH_TELEMETRY_DISABLED: '1',
    },
    prepare: async (cwd) => {
      await copyFile(join(upstreamFixture, 'workspace/driver.mjs'), join(cwd, 'driver.mjs'))
      // Optional plugins are installed in the Profile; the CLI's shipped dependency fallback excludes them.
      const modules = join(cwd, '.dsh/profiles/headless/node_modules/@deepseek-ai')
      await mkdir(modules, { recursive: true })
      for (const name of ['dsh-llm-replay', 'dsh-computer-use', 'dsh-experimental-computer-use-cua-driver-mcp']) {
        await symlink(join(root, 'examples/node_modules/@deepseek-ai', name), join(modules, name), 'junction')
      }
    },
    inspect: async (cwd) => {
      const events = (await readFile(join(cwd, '.dsh/computer-use-fixture/driver.ndjson'), 'utf8'))
        .trim().split('\n').map(line => JSON.parse(line) as { event: string })
      expect(events.filter(event => event.event === 'call')).toHaveLength(managed ? 0 : 1)
      const directory = join(cwd, '.dsh/sessions')
      const files = (await readdir(directory, { recursive: true })).filter(file => file.endsWith('.jsonl'))
      expect(files).toHaveLength(1)
      const raw = await readFile(join(directory, files[0]!), 'utf8')
      const header = JSON.parse(raw.split('\n')[0]!) as { id: string }
      const normalized = normalizeSessionSnapshot(raw, { sessionIds: [header.id], cwd })
      expect(normalized).toContain(managed ? 'Managed desktop access requires an authorized Session' : 'Display 0')
      const path = join(expected, `session.v${String(SESSION_FORMAT_VERSION)}.jsonl`)
      if (refreshing) { await mkdir(expected, { recursive: true }); await writeFile(path, normalized) }
      expect(normalized).toBe(await readFile(path, 'utf8'))
    },
  })
  expect(result.stdout).toBe('DONE\n')
  expect(result.stderr).toBe('')
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
