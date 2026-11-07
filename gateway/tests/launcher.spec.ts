import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.ts'
import * as childCommand from '../src/child-command.ts'
import { LocalLauncher, RuntimeLaunchCleanupError, SystemdLauncher, selectLauncher, type SystemdLauncherOptions } from '../src/launcher.ts'

const CREDENTIAL_HASH = 'a'.repeat(64)

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
    commandTimeoutMs: 120000,
    run: async (args) => { calls.push(args) },
    verifySystemUser: async () => {},
  }
}

describe('SystemdLauncher', () => {
  it.each([
    { code: 1, reason: 'missing', status: 409, diagnostic: 'RUNTIME_ACCOUNT_NOT_PROVISIONED' },
    { code: 'ENOENT', reason: 'unavailable', status: 503, diagnostic: 'RUNTIME_ACCOUNT_VERIFICATION_UNAVAILABLE' },
    { code: 'EACCES', reason: 'unavailable', status: 503, diagnostic: 'RUNTIME_ACCOUNT_VERIFICATION_UNAVAILABLE' },
    { code: undefined, reason: 'unavailable', status: 503, diagnostic: 'RUNTIME_ACCOUNT_VERIFICATION_UNAVAILABLE' },
  ])('classifies account lookup $code as $reason before allocating anything', async ({ code, status, diagnostic }) => {
    const unitDir = temporary('account-lookup-'), calls: string[][] = []
    const options = systemdOptions(unitDir, calls), beforeAllocation = vi.fn(async () => {})
    delete options.verifySystemUser
    const cause = Object.assign(new Error('private command diagnostic'), { code })
    vi.spyOn(childCommand, 'runGatewayChildCommand').mockRejectedValueOnce(cause)
    const launcher = new SystemdLauncher(options)
    await expect(launcher.start({
      kind: 'user', ownerId: 1, username: 'alice', runtimeKey: 'alice', systemUser: 'harness-alice',
      port: 42001, homePath: '/srv/harness/users/alice/home', dshHome: '/srv/harness/users/alice/dsh',
      generation: 2, credentialHash: CREDENTIAL_HASH, gatewayCredential: '{}', beforeAllocation,
    })).rejects.toMatchObject({ name: 'RuntimeAccountError', status, code: diagnostic, cause })
    expect(beforeAllocation).not.toHaveBeenCalled()
    expect(calls).toEqual([])
    expect(existsSync(join(unitDir, 'credentials'))).toBe(false)
    expect(existsSync(join(unitDir, `harness-alice@2-${CREDENTIAL_HASH}.service`))).toBe(false)
  })

  it('refuses an unprovisioned account before credentials, units or process admission', async () => {
    const unitDir = temporary('account-preflight-'), calls: string[][] = []
    const options = systemdOptions(unitDir, calls), beforeAllocation = vi.fn(async () => {})
    options.verifySystemUser = async () => { throw new Error('Runtime account is not provisioned') }
    const launcher = new SystemdLauncher(options)
    await expect(launcher.start({
      kind: 'user', ownerId: 1, username: 'alice', runtimeKey: 'alice', systemUser: 'harness-alice',
      port: 42001, homePath: '/srv/harness/users/alice/home', dshHome: '/srv/harness/users/alice/dsh',
      generation: 2, credentialHash: CREDENTIAL_HASH, gatewayCredential: '{}', beforeAllocation,
    })).rejects.toThrow('Runtime account is not provisioned')
    expect(beforeAllocation).not.toHaveBeenCalled()
    expect(calls).toEqual([])
    expect(existsSync(join(unitDir, 'credentials'))).toBe(false)
    expect(existsSync(join(unitDir, `harness-alice@2-${CREDENTIAL_HASH}.service`))).toBe(false)
  })
  it.each([1, 'ENOENT', 'EACCES', undefined])('retains an unknown supervisor query failure (%s)', async code => {
    const unitDir = temporary('units-')
    const failure = Object.assign(new Error('supervisor unavailable'), { code })
    const options = systemdOptions(unitDir, [])
    options.run = async () => { throw failure }
    const launcher = new SystemdLauncher(options)
    await expect(launcher.attach({
      kind: 'user', ownerId: 1, username: 'alice', runtimeKey: 'alice', systemUser: 'harness-alice', port: 42001,
      homePath: '/srv/harness/users/alice/home', dshHome: '/srv/harness/users/alice/dsh', generation: 2, credentialHash: CREDENTIAL_HASH,
    }).isAlive?.()).rejects.toBe(failure)
  })

  it.each([3, 4])('accepts systemctl inactive or missing-unit evidence (%s)', async code => {
    const options = systemdOptions(temporary('units-'), [])
    options.run = async () => { throw Object.assign(new Error('unit inactive'), { code }) }
    const launcher = new SystemdLauncher(options)
    await expect(launcher.attach({
      kind: 'user', ownerId: 1, username: 'alice', runtimeKey: 'alice', systemUser: 'harness-alice', port: 42001,
      homePath: '/srv/harness/users/alice/home', dshHome: '/srv/harness/users/alice/dsh', generation: 2, credentialHash: CREDENTIAL_HASH,
    }).isAlive?.()).resolves.toBe(false)
  })

  it('preserves query errors from an existing legacy unit', async () => {
    const unitDir = temporary('units-')
    writeFileSync(join(unitDir, 'harness-alice.service'), 'legacy unit')
    const options = systemdOptions(unitDir, [])
    const failure = Object.assign(new Error('supervisor bus unavailable'), { code: 1 })
    options.run = async args => {
      if (args.at(-1) === 'harness-alice.service') throw failure
      throw Object.assign(new Error('unit inactive'), { code: 3 })
    }
    const launcher = new SystemdLauncher(options)
    await expect(launcher.attach({
      kind: 'user', ownerId: 1, username: 'alice', runtimeKey: 'alice', systemUser: 'harness-alice', port: 42001,
      homePath: '/srv/harness/users/alice/home', dshHome: '/srv/harness/users/alice/dsh', generation: 2, credentialHash: CREDENTIAL_HASH,
    }).isAlive?.()).rejects.toBe(failure)
  })

  it('does not restart a prepared unit after its allocation signal is cancelled', async () => {
    const calls: string[][] = [], controller = new AbortController()
    const launcher = new SystemdLauncher(systemdOptions(temporary('unit-cancel-'), calls))
    await expect(launcher.start({
      kind: 'user', ownerId: 1, username: 'alice', runtimeKey: 'alice', systemUser: 'harness-alice',
      port: 42001, homePath: '/srv/harness/users/alice/home', dshHome: '/srv/harness/users/alice/dsh',
      generation: 2, credentialHash: CREDENTIAL_HASH, gatewayCredential: '{}', signal: controller.signal,
      beforeAllocation: async () => { controller.abort() },
    })).rejects.toMatchObject({ reason: 'cancelled' })
    expect(calls).toEqual([['daemon-reload']])
  })
  it('waits for resource admission after preparing the unit and before systemctl restart', async () => {
    const unitDir = temporary('units-')
    const calls: string[][] = []
    const entered = deferred(), grant = deferred()
    const launcher = new SystemdLauncher(systemdOptions(unitDir, calls))
    const pending = launcher.start({
      kind: 'user', ownerId: 1, username: 'alice', runtimeKey: 'alice', systemUser: 'harness-alice',
      port: 42001, homePath: '/srv/harness/users/alice/home', dshHome: '/srv/harness/users/alice/dsh',
      generation: 2, credentialHash: CREDENTIAL_HASH, gatewayCredential: '{}',
      beforeAllocation: async () => { entered.resolve(); await grant.promise },
    })
    try {
      expect(await Promise.race([entered.promise.then(() => 'waiting'), pending.then(() => 'allocated')])).toBe('waiting')
      expect(calls.map(call => call[0])).toEqual(['daemon-reload'])
    } finally { grant.resolve(); await pending }
    expect(calls.map(call => call[0])).toEqual(['daemon-reload', 'restart'])
  })

  it('can start a fresh credential after a backup restores a previously stopped generation number', async () => {
    const unitDir = temporary('units-')
    const calls: string[][] = []
    const launcher = new SystemdLauncher(systemdOptions(unitDir, calls))
    const runtime = {
      kind: 'user' as const, ownerId: 1, username: 'alice', runtimeKey: 'alice', systemUser: 'harness-alice', port: 42001,
      homePath: '/srv/harness/users/alice/home', dshHome: '/srv/harness/users/alice/dsh', generation: 2, credentialHash: CREDENTIAL_HASH, gatewayCredential: '{}',
    }
    const first = await launcher.start({ ...runtime, credentialHash: 'a'.repeat(64) })
    await first.terminate(0)
    await expect(launcher.start({ ...runtime, credentialHash: 'b'.repeat(64) })).resolves.toHaveProperty('terminate')
  })

  it('keeps a replacement unit running when an older process handle is terminated', async () => {
    const unitDir = temporary('units-')
    const active = new Set<string>()
    const options = systemdOptions(unitDir, [])
    options.run = async ([operation, ...units]) => {
      if (operation === 'restart') for (const unit of units) active.add(unit)
      if (operation === 'stop') for (const unit of units) active.delete(unit)
    }
    const launcher = new SystemdLauncher(options)
    const runtime = {
      kind: 'user' as const, ownerId: 1, username: 'alice', runtimeKey: 'alice', systemUser: 'harness-alice', port: 42001,
      homePath: '/srv/harness/users/alice/home', dshHome: '/srv/harness/users/alice/dsh', credentialHash: CREDENTIAL_HASH, gatewayCredential: '{}',
    }
    const old = await launcher.start({ ...runtime, generation: 2 })
    await launcher.start({ ...runtime, generation: 3 })
    const oldCredential = /^LoadCredential=dsh-gateway:(.+)$/m.exec(readFileSync(join(unitDir, `harness-alice@2-${CREDENTIAL_HASH}.service`), 'utf8'))![1]!
    const newCredential = /^LoadCredential=dsh-gateway:(.+)$/m.exec(readFileSync(join(unitDir, `harness-alice@3-${CREDENTIAL_HASH}.service`), 'utf8'))![1]!
    await old.terminate(0)
    expect([...active]).toEqual([`harness-alice@3-${CREDENTIAL_HASH}.service`])
    expect(existsSync(oldCredential)).toBe(false)
    expect(existsSync(newCredential)).toBe(true)
  })

  it('retains generation credentials until an independently attached stop is confirmed', async () => {
    const unitDir = temporary('unit-credential-lifetime-'), calls: string[][] = []
    const options = systemdOptions(unitDir, calls)
    const runtime = {
      kind: 'user' as const, ownerId: 1, username: 'alice', runtimeKey: 'alice', systemUser: 'harness-alice', port: 42001,
      homePath: '/srv/harness/users/alice/home', dshHome: '/srv/harness/users/alice/dsh',
      generation: 2, credentialHash: CREDENTIAL_HASH, gatewayCredential: '{"token":"fixture"}',
    }
    await new SystemdLauncher(options).start(runtime)
    const source = /^LoadCredential=dsh-gateway:(.+)$/m.exec(readFileSync(join(unitDir, `harness-alice@2-${CREDENTIAL_HASH}.service`), 'utf8'))![1]!
    options.run = async args => { if (args[0] === 'stop') throw new Error('stop unconfirmed') }
    await expect(new SystemdLauncher(options).attach(runtime).terminate(0)).rejects.toThrow('stop unconfirmed')
    expect(readFileSync(source, 'utf8')).toBe(runtime.gatewayCredential)
    const stopping = deferred(), stopped = deferred()
    options.run = async args => { if (args[0] === 'stop') { stopping.resolve(); await stopped.promise } }
    const pending = new SystemdLauncher(options).attach(runtime).terminate(0)
    try {
      await stopping.promise
      expect(existsSync(source)).toBe(true)
    } finally { stopped.resolve(); await pending }
    expect(existsSync(source)).toBe(false)
  })

  it('fences an allocation still waiting for grants before confirming that generation stopped', async () => {
    const unitDir = temporary('units-')
    const waitingForGrants = deferred()
    const finishGrants = deferred()
    const active = new Set<string>()
    const options = systemdOptions(unitDir, [])
    options.grantsProvider = async () => { waitingForGrants.resolve(); await finishGrants.promise; return [] }
    options.run = async ([operation, ...units]) => {
      if (operation === 'restart') for (const unit of units) {
        if (statSync(join(unitDir, unit)).size === 0) throw new Error('unit is masked')
        active.add(unit)
      }
      if (operation === 'stop') for (const unit of units) active.delete(unit)
    }
    const launcher = new SystemdLauncher(options)
    const runtime = {
      kind: 'user' as const, ownerId: 1, username: 'alice', runtimeKey: 'alice', systemUser: 'harness-alice', port: 42001,
      homePath: '/srv/harness/users/alice/home', dshHome: '/srv/harness/users/alice/dsh', generation: 2, credentialHash: CREDENTIAL_HASH,
    }
    const pending = launcher.start({ ...runtime, credentialHash: CREDENTIAL_HASH, gatewayCredential: '{}' }).then(() => 'started', () => 'refused')
    try {
      await waitingForGrants.promise
      await launcher.attach(runtime).terminate(0)
    } finally { finishGrants.resolve() }
    expect(await pending).toBe('refused')
    expect([...active]).toEqual([])
  })

  it('returns a cleanup handle when restart fails after the supervisor may have started a process', async () => {
    const unitDir = temporary('units-')
    const calls: string[][] = []
    const options = systemdOptions(unitDir, calls)
    options.run = async args => {
      calls.push(args)
      if (args[0] === 'restart') throw new Error('supervisor response lost')
    }
    const launcher = new SystemdLauncher(options)
    const failure = await launcher.start({
      kind: 'user', ownerId: 1, username: 'alice', runtimeKey: 'alice', systemUser: 'harness-alice', port: 42001,
      homePath: '/srv/harness/users/alice/home', dshHome: '/srv/harness/users/alice/dsh',
      generation: 2, credentialHash: CREDENTIAL_HASH, gatewayCredential: '{"token":"test"}',
    }).catch(error => {
      if (error instanceof RuntimeLaunchCleanupError) return error
      throw error
    })
    expect(failure).toBeInstanceOf(RuntimeLaunchCleanupError)
    await (failure as RuntimeLaunchCleanupError).process.terminate(0)
    expect(calls.at(-1)).toEqual(['stop', `harness-alice@2-${CREDENTIAL_HASH}.service`, 'harness-alice.service'])
  })

  it('writes the generation confinement unit with its private credential', async () => {
    const unitDir = temporary('units-')
    const calls: string[][] = []
    const launcher = new SystemdLauncher(systemdOptions(unitDir, calls))

    const proc = await launcher.start({
      kind: 'user', ownerId: 1, username: 'alice', runtimeKey: 'alice', systemUser: 'harness-alice', port: 42001,
      homePath: '/srv/harness/users/alice/home', dshHome: '/srv/harness/users/alice/dsh',
      generation: 2, credentialHash: CREDENTIAL_HASH, gatewayCredential: '{"token":"test"}',
    })

    const unit = readFileSync(join(unitDir, `harness-alice@2-${CREDENTIAL_HASH}.service`), 'utf8')
    expect(unit).toContain('TemporaryFileSystem=/srv/harness/users:ro')
    expect(unit).toContain('Type=exec')
    expect(unit).toContain('BindPaths=/srv/harness/users/alice/home')
    expect(unit).toContain('BindReadOnlyPaths=/data/docs')
    expect(unit).toContain('ExecStart="/usr/local/bin/node" "/opt/dsh/lib/bin.js" "web" "--no-open" "--port" "42001"')
    expect(calls).toEqual([['daemon-reload'], ['restart', `harness-alice@2-${CREDENTIAL_HASH}.service`]])
    const credential = /^LoadCredential=dsh-gateway:(.+)$/m.exec(unit)![1]!
    expect(readFileSync(credential, 'utf8')).toBe('{"token":"test"}')
    expect(statSync(credential).mode & 0o077).toBe(0)

    await proc.terminate(1000)
    expect(existsSync(credential)).toBe(false)
    expect(calls).toContainEqual(['stop', `harness-alice@2-${CREDENTIAL_HASH}.service`, 'harness-alice.service'])
    expect(statSync(join(unitDir, `harness-alice@2-${CREDENTIAL_HASH}.service`)).size).toBe(0)
    expect(proc.hasExited()).toBe(false)
  })

  it('rejects a restart arriving after the generation unit was written and then fenced', async () => {
    const unitDir = temporary('units-')
    const reloadEntered = deferred()
    const finishReload = deferred()
    let firstReload = true
    const active = new Set<string>()
    const options = systemdOptions(unitDir, [])
    options.run = async ([operation, ...units]) => {
      if (operation === 'daemon-reload' && firstReload) {
        firstReload = false
        reloadEntered.resolve()
        await finishReload.promise
      }
      if (operation === 'restart') for (const unit of units) {
        if (statSync(join(unitDir, unit)).size === 0) throw new Error('unit is masked')
        active.add(unit)
      }
      if (operation === 'stop') for (const unit of units) active.delete(unit)
    }
    const launcher = new SystemdLauncher(options)
    const runtime = {
      kind: 'user' as const, ownerId: 1, username: 'alice', runtimeKey: 'alice', systemUser: 'harness-alice', port: 42001,
      homePath: '/srv/harness/users/alice/home', dshHome: '/srv/harness/users/alice/dsh', generation: 2, credentialHash: CREDENTIAL_HASH,
    }
    const pending = launcher.start({ ...runtime, credentialHash: CREDENTIAL_HASH, gatewayCredential: '{}' }).then(() => undefined, error => error)
    try {
      await reloadEntered.promise
      await launcher.attach(runtime).terminate(0)
    } finally { finishReload.resolve() }
    const failure: unknown = await pending
    expect(failure).toBeInstanceOf(RuntimeLaunchCleanupError)
    await (failure as RuntimeLaunchCleanupError).process.terminate(0)
    expect([...active]).toEqual([])
  })
})

describe('LocalLauncher', () => {
  it('does not allocate an owner before runtime admission completes', async () => {
    spawnMock.mockReset()
    const entered = deferred(), grant = deferred()
    const cfg = loadConfig({ HGW_STATE_ROOT: temporary('local-admission-') })
    const root = temporary('local-runtime-')
    const failure = new Error('admission cancelled')
    const pending = new LocalLauncher(cfg).start({
      kind: 'user', ownerId: 1, username: 'alice', runtimeKey: 'alice', systemUser: 'harness-alice',
      port: 42001, homePath: root, dshHome: root, generation: 2, credentialHash: CREDENTIAL_HASH,
      gatewayCredential: '{}', beforeAllocation: async () => { entered.resolve(); await grant.promise; throw failure },
    }).catch(error => error)
    await entered.promise
    expect(spawnMock).not.toHaveBeenCalled()
    grant.resolve()
    expect(await pending).toBe(failure)
    expect(spawnMock).not.toHaveBeenCalled()
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
