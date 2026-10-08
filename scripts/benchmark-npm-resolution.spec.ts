/** npm resolution preserves registry isolation and caller-owned process cleanup. */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  benchmarkNpmResolution,
  buildRegistryIndex,
  parseBenchmarkOptions,
  publishWorkspaceRange,
  resolveNpmPackageLock,
  runCommandWithTimeout,
  type RegistryIndex,
} from './benchmark-npm-resolution.ts'

const roots: string[] = []
const NPM_TIMEOUT_MS = 60_000
const NPM_TEST_TIMEOUT_MS = 90_000

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
}, NPM_TEST_TIMEOUT_MS)

function writeJson(root: string, path: string, value: unknown): void {
  const absolute = join(root, path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`)
}

function processCanExecute(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
  if (process.platform === 'darwin') {
    try {
      const state = execFileSync('ps', ['-o', 'state=', '-p', String(pid)], { encoding: 'utf8' }).trim()
      return state !== '' && !/^[ZXx]/.test(state)
    } catch (error) {
      if ((error as { status?: number }).status === 1) return false
      throw error
    }
  }
  if (process.platform !== 'linux') return true
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const state = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/, 1)[0]
    return !/^[ZXx]$/.test(state ?? '')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

describe('npm resolution benchmark', () => {
  it('parses repeat, timeout, threshold, and ref options', () => {
    expect(parseBenchmarkOptions([])).toEqual({ runs: 1, timeoutMs: 300_000 })
    expect(parseBenchmarkOptions([
      '--runs', '3', '--timeout-ms', '45000', '--max-ms', '20000', '--ref', 'master',
    ])).toEqual({ runs: 3, timeoutMs: 45_000, maxMs: 20_000, ref: 'master' })
    expect(parseBenchmarkOptions(['--', '--runs', '2'])).toEqual({ runs: 2, timeoutMs: 300_000 })
    expect(() => parseBenchmarkOptions(['--runs', '0'])).toThrow('--runs must be a positive integer')
  })

  it('projects workspace protocols to published ranges', () => {
    expect(publishWorkspaceRange('workspace:^', '1.2.3')).toBe('^1.2.3')
    expect(publishWorkspaceRange('workspace:~', '1.2.3')).toBe('~1.2.3')
    expect(publishWorkspaceRange('workspace:*', '1.2.3')).toBe('1.2.3')
    expect(publishWorkspaceRange('^4.0.0', '1.2.3')).toBe('^4.0.0')
  })

  it('combines installed metadata with current publishable workspace fields', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-npm-registry-index-'))
    roots.push(root)
    writeJson(root, 'node_modules/.pnpm/external@2.0.0/node_modules/external/package.json', {
      name: 'external',
      version: '2.0.0',
      dependencies: { child: '^1.0.0' },
      devDependencies: { ignored: '^1.0.0' },
    })
    writeJson(root, 'apps/cli/package.json', {
      name: '@deepseek-ai/dsh',
      version: '0.1.0',
      dependencies: { '@deepseek-ai/dsh-child': 'workspace:^', external: '^2.0.0' },
      devDependencies: { ignored: 'workspace:^' },
    })
    writeJson(root, 'packages/core/child/package.json', {
      name: '@deepseek-ai/dsh-child',
      version: '0.1.0',
    })

    const index = buildRegistryIndex(root)

    expect(index.get('external')?.get('2.0.0')).toMatchObject({ dependencies: { child: '^1.0.0' } })
    expect(index.get('@deepseek-ai/dsh')?.get('0.1.0')).toEqual({
      name: '@deepseek-ai/dsh',
      version: '0.1.0',
      dependencies: { '@deepseek-ai/dsh-child': '^0.1.0', external: '^2.0.0' },
    })
  })

  it('runs npm against the local registry without requesting an archive', async ({ signal }) => {
    const index: RegistryIndex = new Map([[
      '@deepseek-ai/dsh',
      new Map([['0.1.0', { name: '@deepseek-ai/dsh', version: '0.1.0' }]]),
    ]])
    const result = await benchmarkNpmResolution(index, '0.1.0', NPM_TIMEOUT_MS, signal)

    expect(result.durationMs).toBeGreaterThan(0)
    expect(result.registryRequests).toBeGreaterThan(0)
    expect(result.archiveRequests).toBe(0)
    expect(result.unknownPackages).toEqual([])
  }, NPM_TEST_TIMEOUT_MS)

  it('returns npm placement for two aliased package versions without requesting archives', async ({ signal }) => {
    const index: RegistryIndex = new Map([[
      '@deepseek-ai/dsh',
      new Map([
        ['0.1.0', { name: '@deepseek-ai/dsh', version: '0.1.0' }],
        ['0.2.0', { name: '@deepseek-ai/dsh', version: '0.2.0' }],
      ]),
    ]])

    const result = await resolveNpmPackageLock(index, {
      '@deepseek-ai/dsh': '0.2.0',
      'dsh-previous': 'npm:@deepseek-ai/dsh@0.1.0',
    }, NPM_TIMEOUT_MS, undefined, signal)

    expect(result.archiveRequests).toBe(0)
    expect(result.packageLock.packages['node_modules/@deepseek-ai/dsh']?.version).toBe('0.2.0')
    expect(result.packageLock.packages['node_modules/dsh-previous']).toMatchObject({
      name: '@deepseek-ai/dsh',
      version: '0.1.0',
    })
  }, NPM_TEST_TIMEOUT_MS)

  it('isolates peer resolution from inherited npm configuration', async ({ signal }) => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-hostile-npm-config-'))
    roots.push(root)
    const userConfig = join(root, 'user.npmrc')
    writeFileSync(userConfig, '@deepseek-ai:registry=http://127.0.0.1:1/\nlegacy-peer-deps=true\nomit=peer\n')
    const previous = {
      userConfig: process.env.npm_config_userconfig,
      legacyPeerDeps: process.env.npm_config_legacy_peer_deps,
      omit: process.env.npm_config_omit,
    }
    process.env.npm_config_userconfig = userConfig
    process.env.npm_config_legacy_peer_deps = 'true'
    process.env.npm_config_omit = 'peer'
    try {
      const index: RegistryIndex = new Map([
        ['@deepseek-ai/dsh', new Map([['0.1.0', {
          name: '@deepseek-ai/dsh',
          version: '0.1.0',
          peerDependencies: { '@deepseek-ai/dsh-peer': '1.0.0' },
        }]])],
        ['@deepseek-ai/dsh-peer', new Map([['1.0.0', {
          name: '@deepseek-ai/dsh-peer',
          version: '1.0.0',
        }]])],
      ])

      const result = await resolveNpmPackageLock(index, { '@deepseek-ai/dsh': '0.1.0' }, NPM_TIMEOUT_MS, undefined, signal)

      expect(result.archiveRequests).toBe(0)
      expect(result.packageLock.packages['node_modules/@deepseek-ai/dsh-peer']?.version).toBe('1.0.0')
    } finally {
      if (previous.userConfig === undefined) delete process.env.npm_config_userconfig
      else process.env.npm_config_userconfig = previous.userConfig
      if (previous.legacyPeerDeps === undefined) delete process.env.npm_config_legacy_peer_deps
      else process.env.npm_config_legacy_peer_deps = previous.legacyPeerDeps
      if (previous.omit === undefined) delete process.env.npm_config_omit
      else process.env.npm_config_omit = previous.omit
    }
  }, NPM_TEST_TIMEOUT_MS)

  it('starts no process after its caller has already cancelled', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-command-pre-abort-'))
    roots.push(root)
    const script = join(root, 'fixture.cjs')
    const marker = join(root, 'unexpected')
    writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')\n`)
    const controller = new AbortController()
    const reason = new Error('cancelled before spawn')
    controller.abort(reason)

    await expect(runCommandWithTimeout(process.execPath, [script], {
      cwd: root, env: process.env, timeoutMs: 60_000, signal: controller.signal,
    })).rejects.toBe(reason)
    expect(existsSync(marker)).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('stops signalling a closed POSIX process group after cancellation', async ({ signal }) => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-command-graceful-'))
    roots.push(root)
    const script = join(root, 'fixture.cjs')
    const marker = join(root, 'ready')
    writeFileSync(script, [
      "process.on('SIGTERM', () => { process.exit(0) })",
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid))`,
      'setInterval(() => {}, 1000)',
    ].join(';\n'))
    const controller = new AbortController()
    const reason = new Error('cancel graceful fixture')
    const kills = vi.spyOn(process, 'kill')
    let pid: number | undefined
    const capture = (error: unknown) => ({ error, alive: pid === undefined || processCanExecute(pid) })
    const operation = runCommandWithTimeout(process.execPath, [script], {
      cwd: root, env: process.env, timeoutMs: NPM_TIMEOUT_MS,
      signal: AbortSignal.any([signal, controller.signal]),
    })
    const settled = operation.then(() => capture(undefined), capture)
    try {
      await expect.poll(() => existsSync(marker), { timeout: NPM_TIMEOUT_MS }).toBe(true)
      pid = Number(readFileSync(marker, 'utf8'))
      controller.abort(reason)
      const outcome = await settled
      expect(outcome.error).toBe(reason)
      expect(outcome.alive).toBe(false)
      expect(kills.mock.calls.some(([, kind]) => kind === 'SIGKILL')).toBe(false)
    } finally {
      controller.abort(reason)
      try { await settled } finally { kills.mockRestore() }
    }
  }, NPM_TEST_TIMEOUT_MS)

  it('settles the parent and descendant before reporting caller cancellation', async ({ signal }) => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-command-cancel tree-'))
    roots.push(root)
    const script = join(root, 'fixture.cjs')
    const marker = join(root, 'ready.json')
    const descendantSource = [
      "const fs = require('node:fs')",
      "process.on('SIGTERM', () => {})",
      `fs.writeFileSync(${JSON.stringify(`${marker}.tmp`)}, JSON.stringify([process.ppid, process.pid]))`,
      `fs.renameSync(${JSON.stringify(`${marker}.tmp`)}, ${JSON.stringify(marker)})`,
      'setInterval(() => {}, 1000)',
    ].join(';\n')
    writeFileSync(script, [
      "const { spawn } = require('node:child_process')",
      "process.on('SIGTERM', () => {})",
      `spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], { stdio: ['ignore', 'inherit', 'ignore'] })`,
      'setInterval(() => {}, 1000)',
    ].join(';\n'))
    const controller = new AbortController()
    const reason = new Error('fixture caller cancelled')
    const operation = runCommandWithTimeout(process.execPath, [script], {
      cwd: root, env: process.env, timeoutMs: 60_000, terminationGraceMs: 100,
      signal: AbortSignal.any([signal, controller.signal]),
    })
    try {
      await Promise.race([
        expect.poll(() => existsSync(marker), { timeout: 20_000 }).toBe(true),
        operation.then(() => { throw new Error('fixture exited before readiness') }),
      ])
      const [parentPid, descendantPid] = JSON.parse(readFileSync(marker, 'utf8')) as [number, number]
      const settlement = operation.then(
        () => { throw new Error('fixture returned before caller cancellation') },
        (error: unknown) => ({
          error,
          parentCanExecute: processCanExecute(parentPid),
          descendantCanExecute: processCanExecute(descendantPid),
        }),
      )
      controller.abort(reason)
      const outcome = await settlement
      expect(outcome.error).toBe(reason)
      expect(outcome.parentCanExecute).toBe(false)
      expect(outcome.descendantCanExecute).toBe(false)
    } finally {
      controller.abort(reason)
      await operation.catch((error: unknown) => {
        if (error !== reason && error !== signal.reason) throw error
      })
    }
  }, NPM_TEST_TIMEOUT_MS)

  it.skipIf(process.platform === 'win32')('waits for a redirected descendant after its parent closes', async ({ signal }) => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-command-parent-close-'))
    roots.push(root)
    const script = join(root, 'fixture.cjs')
    const marker = join(root, 'ready.json')
    const descendantSource = [
      "const fs = require('node:fs')",
      "process.on('SIGTERM', () => {})",
      `fs.writeFileSync(${JSON.stringify(`${marker}.tmp`)}, JSON.stringify([process.ppid, process.pid]))`,
      `fs.renameSync(${JSON.stringify(`${marker}.tmp`)}, ${JSON.stringify(marker)})`,
      'setInterval(() => {}, 1000)',
    ].join(';\n')
    writeFileSync(script, [
      "const { spawn } = require('node:child_process')",
      "process.on('SIGTERM', () => process.exit(0))",
      `spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], { stdio: 'ignore' })`,
      'setInterval(() => {}, 1000)',
    ].join(';\n'))
    const controller = new AbortController()
    const reason = new Error('fixture redirected descendant cancelled')
    const operation = runCommandWithTimeout(process.execPath, [script], {
      cwd: root, env: process.env, timeoutMs: 60_000, terminationGraceMs: 100,
      signal: AbortSignal.any([signal, controller.signal]),
    })
    let members: [number, number] | undefined
    try {
      await Promise.race([
        expect.poll(() => existsSync(marker), { timeout: 20_000 }).toBe(true),
        operation.then(() => { throw new Error('fixture exited before readiness') }),
      ])
      members = JSON.parse(readFileSync(marker, 'utf8')) as [number, number]
      const [parentPid, descendantPid] = members
      const settlement = operation.then(
        () => { throw new Error('fixture returned before caller cancellation') },
        (error: unknown) => ({
          error,
          parentCanExecute: processCanExecute(parentPid),
          descendantCanExecute: processCanExecute(descendantPid),
        }),
      )
      controller.abort(reason)
      const outcome = await settlement
      expect(outcome.error).toBe(reason)
      expect(outcome.parentCanExecute).toBe(false)
      expect(outcome.descendantCanExecute).toBe(false)
    } finally {
      controller.abort(reason)
      try {
        await operation.catch((error: unknown) => {
          if (error !== reason && error !== signal.reason) throw error
        })
      } finally {
        for (const pid of members ?? []) {
          if (processCanExecute(pid)) process.kill(pid, 'SIGKILL')
        }
      }
    }
  }, NPM_TEST_TIMEOUT_MS)

  it.skipIf(process.platform === 'win32')('force-kills a timed-out process tree', async () => {
    const source = [
      "const { spawn } = require('node:child_process')",
      "process.on('SIGTERM', () => {})",
      'const child = spawn(process.execPath, [\'-e\', "process.on(\'SIGTERM\', () => {}); setInterval(() => {}, 1000)"], { stdio: \'ignore\' })',
      'console.log(child.pid)',
      'setInterval(() => {}, 1000)',
    ].join(';')
    let descendantPid: number | undefined
    try {
      const result = await runCommandWithTimeout(process.execPath, ['-e', source], {
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 1_000,
        terminationGraceMs: 100,
      })
      const reportedPid = Number.parseInt(result.output.trim(), 10)
      if (!Number.isSafeInteger(reportedPid)) throw new Error(`child reported invalid pid ${result.output.trim()}`)
      descendantPid = reportedPid

      expect(result.timedOut).toBe(true)
      expect(result.signal).toBe('SIGKILL')
      await expect.poll(() => processCanExecute(reportedPid), { timeout: 5_000 }).toBe(false)
    } finally {
      if (descendantPid !== undefined && Number.isSafeInteger(descendantPid)) {
        try {
          process.kill(descendantPid, 'SIGKILL')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
      }
    }
  })
})
