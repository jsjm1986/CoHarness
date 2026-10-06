import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { finished } from 'node:stream/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeLog } from '../src/runtime-log.ts'
import { loadConfig } from '../src/config.ts'
import { LocalLauncher, SystemdLauncher, selectLauncher, type SystemdLauncherOptions } from '../src/launcher.ts'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: spawnMock,
}))

const temporaryRoots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const path of temporaryRoots.splice(0)) rmSync(path, { recursive: true, force: true })
})
function temporary(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  temporaryRoots.push(path)
  return path
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function systemdOptions(unitDir: string, calls: string[][]): SystemdLauncherOptions {
  return {
    systemd: {
      usersRoot: '/srv/harness/users',
      projectRuntimesRoot: '/srv/harness/project-runtimes',
      projectPathRoots: ['/data'],
      execStart: '/usr/local/bin/node /opt/dsh/lib/bin.js web --no-open --port {port}',
      gatewayDir: '/srv/harness/gateway',
      memoryMax: '1G',
      cpuQuota: '100%',
    },
    grantsProvider: () => [
      { path: '/srv/harness/users/alice/home', mode: 'rw' },
      { path: '/data/docs', mode: 'ro' },
    ],
    credentialDir: join(unitDir, 'credentials'),
    unitDir,
    run: async (args) => { calls.push(args) },
  }
}

describe('SystemdLauncher', () => {
  it('writes a per-user confinement unit and restarts any process holding the prior credential', async () => {
    const unitDir = temporary('units-')
    const calls: string[][] = []
    const launcher = new SystemdLauncher(systemdOptions(unitDir, calls))

    const proc = await launcher.start({
      kind: 'user', ownerId: 1, username: 'alice', runtimeKey: 'alice', systemUser: 'harness-alice', port: 42001,
      homePath: '/srv/harness/users/alice/home', dshHome: '/srv/harness/users/alice/dsh',
      generation: 2, gatewayCredential: '{"token":"test"}',
    })

    const unit = readFileSync(join(unitDir, 'harness-alice.service'), 'utf8')
    expect(unit).toContain('TemporaryFileSystem=/srv/harness/users:ro')
    expect(unit).toContain('BindPaths=/srv/harness/users/alice/home')
    expect(unit).toContain('BindReadOnlyPaths=/data/docs')
    expect(unit).toContain('ExecStart="/usr/local/bin/node" "/opt/dsh/lib/bin.js" "web" "--no-open" "--port" "42001"')
    expect(calls).toEqual([['daemon-reload'], ['restart', 'harness-alice.service']])

    await proc.terminate(1000)
    expect(calls).toContainEqual(['stop', 'harness-alice.service'])
    expect(proc.hasExited()).toBe(false)
  })
})

describe('LocalLauncher', () => {
  it('inherits runtime stderr while reserving fd 3 for the private credential', async () => {
    spawnMock.mockReset()
    const credentialPipe = new PassThrough()
    let credential = ''
    credentialPipe.on('data', chunk => { credential += String(chunk) })
    const child = Object.assign(new EventEmitter(), {
      stdio: [null, null, null, credentialPipe],
      exitCode: null as number | null,
      signalCode: null,
      kill: vi.fn(),
    })
    spawnMock.mockReturnValue(child)
    const cfg = loadConfig({})
    cfg.dshCommand = ['node', 'runtime.js', '--port', '{port}']
    cfg.dshRepoRoot = '/srv/harness/repo'
    const launcher = new LocalLauncher(cfg)

    const proc = await launcher.start({
      kind: 'user', ownerId: 1, username: 'alice', runtimeKey: 'alice', systemUser: 'harness-alice',
      port: 42001, homePath: '/srv/harness/users/alice/home', dshHome: '/srv/harness/users/alice/dsh',
      generation: 2, gatewayCredential: '{"token":"test"}',
    })

    expect(spawnMock).toHaveBeenCalledWith('node', ['runtime.js', '--port', '42001'], expect.objectContaining({
      cwd: '/srv/harness/users/alice/home',
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      env: expect.objectContaining({
        HOME: '/srv/harness/users/alice/home',
        DSH_GATEWAY_CREDENTIAL_FD: '3',
      }),
    }))
    expect(credential).toBe('{"token":"test"}')
    child.exitCode = 0
    child.emit('exit', 0)
    child.emit('close', 0)
    await proc.terminate(0)
  })

  it('drains both runtime streams into bounded generations while preserving each stream order', async () => {
    spawnMock.mockReset()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const credentialPipe = new PassThrough()
    credentialPipe.on('data', () => {})
    const child = Object.assign(new EventEmitter(), {
      stdio: [null, stdout, stderr, credentialPipe],
      exitCode: null as number | null,
      signalCode: null,
      kill: vi.fn(),
    })
    spawnMock.mockReturnValue(child)
    const dshHome = temporary('dsh-home-')
    const cfg = loadConfig({})
    cfg.dshCommand = ['node', 'runtime.js', '--port', '{port}']
    cfg.dshRepoRoot = '/srv/harness/repo'
    cfg.runtimeLogCapBytes = 16
    mkdirSync(join(dshHome, 'logs'), { recursive: true })
    writeFileSync(join(dshHome, 'logs', 'runtime.log'), 'already-oversized', 'utf8')
    const central = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const launcher = new LocalLauncher(cfg)

    const proc = await launcher.start({
      kind: 'user', ownerId: 1, username: 'alice', runtimeKey: 'alice', systemUser: 'harness-alice',
      port: 42001, homePath: '/srv/harness/users/alice/home', dshHome,
      generation: 2, gatewayCredential: '{"token":"test"}',
    })

    // The writer opens lazily: nothing touches the log dir before first output.
    expect(existsSync(join(dshHome, 'logs', 'runtime.log.1'))).toBe(false)
    stdout.end('out1\nout2\n')
    stderr.end('err1\nerr2\n')
    await Promise.all([finished(stdout), finished(stderr)])
    child.exitCode = 0
    child.emit('exit', 0)
    child.emit('close', 0)
    await proc.terminate(1000)
    const previous = join(dshHome, 'logs', 'runtime.log.1'), current = join(dshHome, 'logs', 'runtime.log')
    expect(statSync(previous).size).toBeLessThanOrEqual(cfg.runtimeLogCapBytes)
    expect(statSync(current).size).toBeLessThanOrEqual(cfg.runtimeLogCapBytes)
    const retained = readFileSync(previous, 'utf8') + readFileSync(current, 'utf8')
    expect(retained).toHaveLength(20)
    for (const prefix of ['out', 'err']) {
      expect(retained.indexOf(`${prefix}1\n`)).toBeGreaterThanOrEqual(0)
      expect(retained.indexOf(`${prefix}2\n`)).toBeGreaterThan(retained.indexOf(`${prefix}1\n`))
    }
    expect(central).toHaveBeenCalled()
  })

  it('waits for diagnostic file closure before reporting a real child terminated', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    spawnMock.mockImplementation(actual.spawn)
    const dshHome = temporary('dsh-log-close-')
    const cfg = loadConfig({})
    cfg.dshCommand = [process.execPath, '-e', 'require("node:fs").readFileSync(3);process.stdout.write("ready\\n");setInterval(()=>{},1000)']
    const original = RuntimeLog.prototype.close
    const entered = deferred(), release = deferred()
    vi.spyOn(RuntimeLog.prototype, 'close').mockImplementation(function (this: RuntimeLog) {
      entered.resolve()
      return release.promise.then(() => original.call(this))
    })
    const proc = await new LocalLauncher(cfg).start({
      kind: 'user', ownerId: 1, username: 'alice', runtimeKey: 'alice', systemUser: 'harness-alice',
      port: 42001, homePath: dshHome, dshHome, generation: 2, gatewayCredential: '{"token":"test"}',
    })
    let termination: Promise<void> | undefined
    try {
      await vi.waitFor(() => expect(readFileSync(join(dshHome, 'logs', 'runtime.log'), 'utf8')).toBe('ready\n'))
      let completed = false
      termination = proc.terminate(1000).then(() => { completed = true })
      await entered.promise
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(completed).toBe(false)
      release.resolve()
      await termination
      expect(completed).toBe(true)
    } finally {
      release.resolve()
      await (termination ?? proc.terminate(0))
    }
  })

  // LocalLauncher uses detached POSIX groups; taskkill cannot rediscover an
  // exited parent by PID, so this inherited-pipe case is POSIX-specific.
  it.skipIf(process.platform === 'win32')('restarts after an exited parent leaves a descendant holding its log pipes', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    spawnMock.mockImplementation(actual.spawn)
    const dshHome = temporary('dsh-log-orphan-')
    const pidPath = join(dshHome, 'orphan.pid')
    const cfg = loadConfig({})
    cfg.dshCommand = [process.execPath, '-e', `
      const fs = require('node:fs'), { spawn } = require('node:child_process');
      const credential = JSON.parse(fs.readFileSync(3, 'utf8'));
      if (credential.first) {
        const child = spawn(process.execPath, ['-e', 'process.send("ready"); setInterval(()=>{},1000)'],
          { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
        fs.writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
        child.once('message', () => process.exit(0));
      } else {
        process.stdout.write('replacement-ready');
        setInterval(()=>{},1000);
      }
    `]
    const launcher = new LocalLauncher(cfg)
    const runtime = { kind: 'user' as const, ownerId: 1, username: 'alice', runtimeKey: 'alice', systemUser: 'harness-alice',
      port: 42001, homePath: dshHome, dshHome, generation: 2 }
    const first = await launcher.start({ ...runtime, gatewayCredential: '{"first":true}' })
    let second: Awaited<ReturnType<LocalLauncher['start']>> | undefined
    let pending: Promise<Awaited<ReturnType<LocalLauncher['start']>>> | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await vi.waitFor(() => expect(first.hasExited()).toBe(true))
      const orphanPid = Number(readFileSync(pidPath, 'utf8'))
      expect(() => process.kill(orphanPid, 0)).not.toThrow()
      pending = launcher.start({ ...runtime, generation: 3, gatewayCredential: '{"first":false}' })
      second = await Promise.race([pending, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('replacement launch stayed blocked by an exited parent')), 5000)
      })])
      clearTimeout(timeout)
      await vi.waitFor(() => expect(readFileSync(join(dshHome, 'logs', 'runtime.log'), 'utf8')).toContain('replacement-ready'))
      expect(() => process.kill(orphanPid, 0)).toThrow()
    } finally {
      clearTimeout(timeout)
      if (existsSync(pidPath)) {
        const pid = Number(readFileSync(pidPath, 'utf8'))
        try { process.kill(pid, 'SIGKILL') } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
      }
      await first.terminate(0)
      const replacement = second ?? await pending
      await replacement?.terminate(0)
    }
  })

})

describe('selectLauncher', () => {
  it('returns LocalLauncher by default and never builds systemd options', () => {
    const launcher = selectLauncher(loadConfig({}), () => { throw new Error('systemd options must not be built for local') })
    expect(launcher).toBeInstanceOf(LocalLauncher)
  })

  it('returns SystemdLauncher when HGW_LAUNCHER=systemd', () => {
    const calls: string[][] = []
    const unitDir = temporary('units-')
    const launcher = selectLauncher(loadConfig({
      HGW_LAUNCHER: 'systemd',
      HGW_PROJECT_PATH_ROOTS: '/data',
    }), () => systemdOptions(unitDir, calls))
    expect(launcher).toBeInstanceOf(SystemdLauncher)
  })
})
