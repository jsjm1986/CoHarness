import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { SshRpcPeer } from '../src/protocol.ts'
import { SshConnection } from '../src/index.ts'

const transport = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }))
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: transport.spawn,
  execFile: transport.execFile,
}))

const files = vi.hoisted(() => ({
  written: new Map<string, { content: string; mode: number | undefined }>(),
  removed: [] as string[],
}))
vi.mock('node:fs/promises', () => ({
  mkdtemp: async () => '/virtual/dsh-ssh-test',
  writeFile: async (path: string, content: string, options?: { mode?: number }) => {
    files.written.set(path, { content, mode: options?.mode })
  },
  chmod: async () => {},
  rm: async (path: string) => { files.removed.push(path) },
}))

class HelperChild extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  private stopped = false

  kill(): boolean {
    if (!this.stopped) {
      this.stopped = true
      queueMicrotask(() => { this.emit('close', 0, null) })
    }
    return true
  }
}

const base = {
  host: 'hermetic-test', node: '/usr/bin/node', helper: '/opt/dsh/helper.js',
  helperHash: 'a'.repeat(64), workspace: '/workspace',
}

function harness(config: Record<string, unknown>) {
  const child = new HelperChild()
  const helper = new SshRpcPeer(child.stdin, child.stdout, 4096, 8, async (method) => {
    if (method !== 'hello') throw new Error(`unexpected helper operation: ${method}`)
    return {
      protocol: 1, hash: 'a'.repeat(64), platform: 'linux', nodeVersion: 'v24.19.0',
      node: '/usr/bin/node', root: '/tmp/remote-helper', workspace: '/workspace',
    }
  })
  transport.spawn.mockReturnValue(child)
  const ctx = new Context()
  const fiber = ctx.plugin(SshConnection, { ...base, ...config })
  onTestFinished(async () => {
    helper.close()
    child.stderr.destroy()
    child.kill()
    await fiber.dispose().catch(() => {})
    vi.clearAllMocks()
    files.written.clear()
    files.removed.length = 0
  })
  return { ctx, fiber, child }
}

describe.skipIf(process.platform === 'win32')('SSH password channel', () => {
  it('keeps BatchMode and adds no askpass environment without passwordRef', async () => {
    const { fiber } = harness({})
    await fiber
    const [, args, options] = transport.spawn.mock.calls[0] as [string, string[], Record<string, unknown>]
    expect(args).toContain('BatchMode=yes')
    expect(args.join(' ')).not.toContain('NumberOfPasswordPrompts')
    expect(options.env).toBeUndefined()
  })

  it('feeds a resolved credential through SSH_ASKPASS and removes it after authentication', async () => {
    const { ctx, fiber } = harness({ passwordRef: 'SSH_LOGIN_PASSWORD' })
    const resolved: string[] = []
    ctx.provide('credentials', {
      resolve: async (ref: string) => { resolved.push(ref); return { value: 'sup3r-secret', source: 'env' } },
    } as never)
    await fiber
    expect(resolved).toEqual(['SSH_LOGIN_PASSWORD'])
    const [, args, options] = transport.spawn.mock.calls[0] as [string, string[],
      { env: Record<string, string> }]
    expect(args).toContain('BatchMode=no')
    expect(args).toContain('NumberOfPasswordPrompts=1')
    expect(options.env.SSH_ASKPASS).toBe('/virtual/dsh-ssh-test/askpass')
    expect(options.env.SSH_ASKPASS_REQUIRE).toBe('force')
    expect(options.env.DISPLAY).toBe('dsh-ssh:0')
    for (const value of Object.values(options.env)) expect(value).not.toBe('sup3r-secret')
    const password = files.written.get('/virtual/dsh-ssh-test/password')
    expect(password).toEqual({ content: 'sup3r-secret', mode: 0o600 })
    const script = files.written.get('/virtual/dsh-ssh-test/askpass')
    expect(script?.mode).toBe(0o700)
    expect(script?.content).not.toContain('sup3r-secret')
    expect(files.removed).toEqual(expect.arrayContaining([
      '/virtual/dsh-ssh-test/password', '/virtual/dsh-ssh-test/askpass',
    ]))
  })

  it('fails before spawning when the credentials service is absent', async () => {
    const { fiber } = harness({ passwordRef: 'SSH_LOGIN_PASSWORD' })
    await expect(fiber.await()).rejects.toThrow('credentials service')
    expect(transport.spawn).not.toHaveBeenCalled()
  })

  it('fails before spawning when the reference resolves to nothing', async () => {
    const { ctx, fiber } = harness({ passwordRef: 'SSH_LOGIN_PASSWORD' })
    ctx.provide('credentials', { resolve: async () => undefined } as never)
    await expect(fiber.await()).rejects.toThrow('SSH_LOGIN_PASSWORD')
    expect(transport.spawn).not.toHaveBeenCalled()
  })

  it('rejects a passwordRef that is not a credential reference', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(SshConnection, { ...base, passwordRef: 'not-a-ref!' })
    onTestFinished(async () => { await fiber.dispose().catch(() => {}) })
    await expect(fiber.await()).rejects.toThrow('passwordRef')
  })
})
