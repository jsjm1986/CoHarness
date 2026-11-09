/** Real Git branch preservation and managed preparation lifetime. */
import { execFile } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { prepareStewardWorktree } from '../src/steward-worktree.ts'

const execute = promisify(execFile)
const roots: string[] = []
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'steward-worktree-'))
  roots.push(root)
  return root
}
async function repository(root: string) {
  const sourcePath = join(root, 'source'), workspacePath = join(root, 'workspace')
  await mkdir(sourcePath)
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' }
  const git = (args: string[], cwd = sourcePath) => execute('git', ['-C', cwd, ...args], { env, timeout: 15000, maxBuffer: 64 * 1024 })
  await execute('git', ['init', sourcePath], { env, timeout: 15000 })
  await git(['config', 'user.name', 'Synthetic fixture'])
  await git(['config', 'user.email', 'fixture@example.test'])
  await writeFile(join(sourcePath, 'README.md'), 'initial source\n')
  await git(['add', 'README.md']); await git(['commit', '-m', 'Initial source'])
  return { sourcePath, workspacePath, prepareTimeoutMs: 15000, prepareKillGraceMs: 1000, runtimeUser: '', git }
}

it('prepares a plain directory without a source repository', async () => {
  const root = await directory(), workspacePath = join(root, 'plain')
  await prepareStewardWorktree({ workspacePath, sourcePath: '', prepareTimeoutMs: 15000, prepareKillGraceMs: 1000, runtimeUser: '' }, new AbortController().signal)
  await writeFile(join(workspacePath, 'retained.txt'), 'retained')
  expect(await readFile(join(workspacePath, 'retained.txt'), 'utf8')).toBe('retained')
})

it('refuses cancellation before directory preparation', async () => {
  const root = await directory(), signal = AbortSignal.abort(new Error('preparation cancelled'))
  await expect(prepareStewardWorktree({ workspacePath: join(root, 'absent'), sourcePath: '', prepareTimeoutMs: 15000, prepareKillGraceMs: 1000, runtimeUser: '' }, signal))
    .rejects.toThrow('preparation cancelled')
  await expect(readFile(join(root, 'absent'))).rejects.toHaveProperty('code', 'ENOENT')
})

it('creates the provisioning branch once and preserves existing worktree edits', async () => {
  const config = await repository(await directory()), signal = new AbortController().signal
  await prepareStewardWorktree(config, signal)
  expect((await config.git(['symbolic-ref', '--short', 'HEAD'], config.workspacePath)).stdout.trim()).toBe('steward-workspace')
  await writeFile(join(config.workspacePath, 'README.md'), 'uncommitted workspace edits\n')
  await prepareStewardWorktree(config, signal)
  expect(await readFile(join(config.workspacePath, 'README.md'), 'utf8')).toBe('uncommitted workspace edits\n')
})

it('uses a detached checkout when the retained provisioning branch contains later commits', async () => {
  const config = await repository(await directory()), signal = new AbortController().signal
  await prepareStewardWorktree(config, signal)
  await writeFile(join(config.workspacePath, 'README.md'), 'retained commit\n')
  await config.git(['add', 'README.md'], config.workspacePath)
  await config.git(['commit', '-m', 'Retained work'], config.workspacePath)
  const retained = (await config.git(['rev-parse', 'refs/heads/steward-workspace'])).stdout.trim()
  await config.git(['worktree', 'remove', config.workspacePath])
  await prepareStewardWorktree(config, signal)
  expect((await config.git(['rev-parse', 'refs/heads/steward-workspace'])).stdout.trim()).toBe(retained)
  expect(await readFile(join(config.workspacePath, 'README.md'), 'utf8')).toBe('initial source\n')
  await expect(config.git(['symbolic-ref', '-q', 'HEAD'], config.workspacePath)).rejects.toMatchObject({ code: 1, killed: false })
})

it('preserves a source lookup failure instead of attempting a detached checkout', async () => {
  const root = await directory(), trace = join(root, 'git-trace.jsonl')
  vi.stubEnv('GIT_TRACE2_EVENT', trace)
  await expect(prepareStewardWorktree({ sourcePath: join(root, 'missing'), workspacePath: join(root, 'workspace'), prepareTimeoutMs: 15000, prepareKillGraceMs: 1000, runtimeUser: '' }, new AbortController().signal))
    .rejects.toMatchObject({ code: 128, killed: false })
  const events = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { event: string; argv?: string[] })
  const commands = events.filter(row => row.event === 'start').map(row => row.argv)
  expect(commands).toHaveLength(1)
  expect(commands[0]).toContain('show-ref')
})

// This case relies on POSIX search permissions and an unprivileged filesystem caller.
it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('preserves an unreadable existing workspace instead of treating it as absent', async () => {
  const root = await directory(), workspacePath = join(root, 'workspace')
  await mkdir(workspacePath)
  await chmod(workspacePath, 0)
  try {
    await expect(prepareStewardWorktree({ sourcePath: root, workspacePath, prepareTimeoutMs: 15000, prepareKillGraceMs: 1000, runtimeUser: '' }, new AbortController().signal))
      .rejects.toHaveProperty('code', 'EACCES')
  } finally { await chmod(workspacePath, 0o700) }
})

// Executable PATH fixtures use POSIX shebangs; native Windows execution has its own acceptance scope.
it.skipIf(process.platform === 'win32').each(['cancel', 'deadline'] as const)(
  'joins a directly owned native client after %s before returning', async mode => {
    const root = await directory(), bin = join(root, 'bin'), pidFile = join(root, 'pid')
    await mkdir(bin)
    await writeFile(join(bin, 'git'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)\n`, { mode: 0o700 })
    vi.stubEnv('PATH', bin + delimiter + (process.env.PATH ?? ''))
    const controller = new AbortController()
    const reading = prepareStewardWorktree({ sourcePath: root, workspacePath: join(root, 'workspace'), prepareTimeoutMs: mode === 'deadline' ? 5000 : 15000, prepareKillGraceMs: 1000, runtimeUser: '' }, controller.signal)
    const outcome = reading.then(() => undefined, (error: unknown) => error)
    try {
      let pid = 0
      await vi.waitFor(async () => { pid = Number(await readFile(pidFile, 'utf8')); expect(pid).toBeGreaterThan(0) }, { timeout: 15000 })
      if (mode === 'cancel') controller.abort(new Error('preparation cancelled'))
      expect(await outcome).toMatchObject(mode === 'cancel' ? { message: 'preparation cancelled' } : { name: 'TimeoutError' })
      expect(() => process.kill(pid, 0)).toThrow()
    } finally {
      controller.abort()
      await outcome
    }
  }, 30000)

// POSIX Git hooks inherit their checkout's process group and can defer TERM until escalation.
it.skipIf(process.platform === 'win32').each(['cancel', 'deadline'] as const)(
  'joins an ordinary TERM-trapping checkout hook after %s', async mode => {
    const root = await directory(), config = await repository(root)
    const pidFile = join(root, 'hook-pid'), release = join(root, 'release')
    await writeFile(join(config.sourcePath, '.git/hooks/post-checkout'), `#!${process.execPath}\nconst fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))process.exit(1)},10)\n`, { mode: 0o700 })
    const controller = new AbortController()
    const work = prepareStewardWorktree({ ...config, prepareTimeoutMs: mode === 'deadline' ? 10000 : 30000 }, controller.signal)
    const settled = work.then(() => undefined, (error: unknown) => error)
    let pid = 0
    try {
      await vi.waitFor(async () => { pid = Number(await readFile(pidFile, 'utf8')); expect(pid).toBeGreaterThan(0) }, { timeout: 15000 })
      if (mode === 'cancel') controller.abort(new Error('Gateway closing preparation'))
      expect(await settled).toMatchObject(mode === 'cancel' ? { message: 'Gateway closing preparation' } : { name: 'TimeoutError' })
      expect(() => process.kill(pid, 0)).toThrow()
    } finally {
      await writeFile(release, 'release')
      controller.abort()
      await settled
      if (pid > 0) await vi.waitFor(() => { expect(() => process.kill(pid, 0)).toThrow() }, { timeout: 15000 })
    }
  }, 60000)
