/** Capacity refusal and prefix recovery through the shipped headless profile. */

import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { latestPersistedSessionPaths, sessionFixtureNames, snapshotChildEnvironment } from '@deepseek-ai/dsh-session-snapshot'

const repository = fileURLToPath(new URL('../../', import.meta.url))
const recording = fileURLToPath(new URL('./text-turn/', import.meta.url))

function rows(text: string): Array<Record<string, unknown>> {
  return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
}

it('refuses a full JSONL provider without accepting the new event and resumes its unchanged committed prefix', async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'dsh-jsonl-capacity-snapshot-')))
  const fixture = join(recording, sessionFixtureNames(await readdir(recording))[0]!)
  const patches = ['cordis.yml', 'cordis.snapshot.yml', 'model.cordis.yml'].map(file => join(recording, file))
  const capacity = join(cwd, 'capacity.patch.yml')
  const sessionsRoot = join(cwd, '.dsh', 'sessions')
  const launch = {
    cwd, binScript: join(repository, 'apps/cli/src/bin.ts'), sourceImport: 'tsx/esm' as const,
    configPath: patches[0]!, tsconfigPath: join(repository, 'tsconfig.json'), extendEnv: false,
    env: snapshotChildEnvironment('replay', {
      DSH_HOME: join(cwd, '.dsh'), DSH_SNAPSHOT: 'replay', DSH_SNAPSHOT_FILE: fixture,
      DSH_SNAPSHOT_PROVIDER: 'deepseek-official', DSH_SNAPSHOT_MODEL: 'deepseek-v4-flash',
      DSH_TELEMETRY_DISABLED: '1', DSH_PERMISSION_MODE: 'danger-full-access',
    }),
  }
  const args = ['--profile', 'headless', ...[...patches, capacity].flatMap(file => ['--patch', file]), '--json']
  try {
    // The replay provider is test-only and not carried by the shipped headless
    // profile; stage it as a profile-local package so plain-Node launches can
    // resolve the patch-declared name from the materialized profile directory.
    const profileModules = join(cwd, '.dsh', 'profiles', 'headless', 'node_modules', '@deepseek-ai')
    await mkdir(profileModules, { recursive: true })
    await symlink(join(repository, 'packages/test-support/llm-replay'), join(profileModules, 'dsh-llm-replay'), 'dir')
    const patch = (events: number) => [
      '- id: session-persistence-jsonl', "  name: '@deepseek-ai/dsh-session-persistence-jsonl'",
      '  config:', "    root: !!js dshHomePath('sessions')", '    compression: none',
      `    maxPendingEvents: ${events}`, '',
    ].join('\n')
    await writeFile(capacity, patch(1))
    const refused = await runLoaderSmoke({ ...launch, label: 'JSONL capacity refusal', expectedExitCode: 1, binArgs: [...args, 'Reply with exactly PONG.'] })
    const files = latestPersistedSessionPaths(await readdir(sessionsRoot, { recursive: true }))
    expect(files).toHaveLength(1)
    const path = join(sessionsRoot, files[0]!)
    const prefix = await readFile(path, 'utf8')
    const prefixRows = rows(prefix)
    const sessionId = String(prefixRows[0]?.id)
    expect(prefixRows.slice(1).map(row => row.seq)).toEqual(Array.from({ length: prefixRows.length - 1 }, (_, index) => index))
    expect(refused.stderr).toContain('new event refused')
    expect(rows(refused.stdout).filter(row => row.type === 'error').map(row => row.message)).toMatchInlineSnapshot(`
      [
        "JSONL pending-event limit exceeded (1); new event refused. Drain accepted events, then close and resume this session to continue.",
      ]
    `)
    expect(prefixRows.slice(1).map(row => row.type)).toMatchInlineSnapshot(`
      [
        "permission/preset",
      ]
    `)

    await writeFile(capacity, patch(100_000))
    const resumed = await runLoaderSmoke({ ...launch, label: 'JSONL capacity resume', binArgs: [...args, '--session-id', sessionId, 'Reply with exactly PONG.'] })
    expect(rows(resumed.stdout).at(-1)).toEqual({ type: 'final', text: 'PONG' })
    const final = await readFile(path, 'utf8')
    expect(final.startsWith(prefix)).toBe(true)
    const finalRows = rows(final)
    expect(finalRows.slice(1).map(row => row.seq)).toEqual(Array.from({ length: finalRows.length - 1 }, (_, index) => index))
    const additions = finalRows.slice(prefixRows.length)
    expect(additions.map(row => row.type)).toMatchInlineSnapshot(`
      [
        "session/end-seed",
        "sandbox/mode",
        "approval/policy",
        "agent/inbox/spliced",
        "turn/start",
        "agent/inbox/spliced",
        "step/start",
        "system/message",
        "user/message",
        "session/title",
        "user/message",
        "request/header",
        "request/context",
        "assistant/message",
        "step/end",
        "turn/end",
      ]
    `)
    expect(additions.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
