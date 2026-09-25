/** Opt-in real SSH proof that historical Review uses the execution target's files and Git index. */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { SshConnection, type Config as SshConfig } from '@deepseek-ai/dsh-ssh'
import { SshFileSystem } from '@deepseek-ai/dsh-fs-ssh'
import { SshSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-ssh'
import * as WorkspaceChanges from '../src/index.ts'
import { changes, endTurn, mutate, settle, startTurn, toolCall } from './support.ts'

const configPath = process.env.DSH_SSH_TEST_CONFIG

describe.skipIf(configPath === undefined || process.platform === 'win32')('SSH workspace history', () => {
  it('records shell and ignored file-tool changes, retains old contents, and releases its remote storage', async () => {
    const ctx = new Context()
    const config = JSON.parse(readFileSync(configPath!, 'utf8')) as SshConfig
    const fibers = [ctx.plugin(SessionStore), ctx.plugin(SessionProjectionRegistry),
      ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: config.workspace }), ctx.plugin(SshConnection, config), ctx.plugin(SshFileSystem), ctx.plugin(SshSubprocessRuntime)]
    let recorder: ReturnType<typeof ctx.plugin> | undefined
    let root: string | undefined
    const remoteStorage = new Set<string>()
    try {
      await Promise.all(fibers)
      const hello = await ctx.ssh.ready
      root = `${hello.workspace}/review-${randomUUID()}`
      const write = async (path: string, text: string) => ctx.fs.writeText(await ctx.fs.resolve(`${root}/${path}`), text)
      await write('tracked.txt', 'before\n')
      await write('.gitignore', '.ignored\n')
      const git = await ctx.subprocess.resolveExecutable('git')
      const run = async (argv: string[], cwd = root!) => {
        const handle = ctx.subprocess.spawn({
          argv, cwd, stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } }, graceMs: 2000,
        })
        const result = await handle.done
        expect(result.exitCode, handle.collected.stderr?.readFrom(0).text).toBe(0)
        expect(await handle.waitForExit()).toBe(true)
        return handle.collected.stdout!.readFrom(0).text
      }
      await run([git, 'init', '-q'])
      await run([git, 'add', '-A'])
      await run([git, '-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'baseline'])
      const index = await ctx.fs.readBytes(await ctx.fs.resolve(`${root}/.git/index`), undefined, 65536)
      const objects = await run([git, 'count-objects'])
      await write('user-prior.txt', 'user change\n')
      const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
      vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
        if (spec.env?.GIT_OBJECT_DIRECTORY !== undefined) remoteStorage.add(spec.env.GIT_OBJECT_DIRECTORY)
        return spawn(spec)
      })
      recorder = ctx.plugin(WorkspaceChanges, {
        timeoutMs: 30_000, outputMaxBytes: 65536, maxFiles: 10, maxFileBytes: 65536, diffTimeoutMs: 100,
      })
      await recorder
      const session = ctx.sessions.create(SessionId(`remote-review-${randomUUID()}`), { meta: { cwd: root } })
      startTurn(session, 1)
      await settle(ctx, session)
      await write('tracked.txt', 'after\n')
      await write('shell.txt', 'shell output\n')
      toolCall(session, 1, 'bash', { command: 'write files' })
      await mutate(ctx, session, 1, 'write', { file_path: '.ignored', content: 'private draft\n' }, async () => { await write('.ignored', 'private draft\n') })
      endTurn(session, 1)
      await settle(ctx, session)
      const [summary] = changes(ctx, session)
      expect(summary?.files.map(file => file.path)).toEqual(['.ignored', 'shell.txt', 'tracked.txt'])
      const event = session.snapshotEvents().find(value => value.type === 'workspace/changes')!
      await write('tracked.txt', 'later mutation\n')
      await write('.ignored', 'later draft\n')
      const signal = new AbortController().signal
      expect(await ctx.workspaceChanges.diff(session.id, event.seq, 2, signal)).toMatchObject({ kind: 'text', hunks: [{ lines: ['-before', '+after'] }] })
      expect(await ctx.workspaceChanges.diff(session.id, event.seq, 0, signal)).toMatchObject({ kind: 'text', hunks: [{ lines: ['+private draft'] }] })
      expect(await ctx.fs.readBytes(await ctx.fs.resolve(`${root}/.git/index`), undefined, 65536)).toEqual(index)
      expect(await run([git, 'count-objects'])).toBe(objects)
      expect(remoteStorage.size).toBe(1)
      await recorder.dispose()
      recorder = undefined
      for (const path of remoteStorage) expect(await ctx.fs.stat(await ctx.fs.resolve(path))).toBeUndefined()
      await run([hello.node, '-e', 'require("node:fs").rmSync(process.argv[1],{recursive:true,force:true})', root], hello.workspace)
      root = undefined
    } finally {
      await recorder?.dispose()
      if (root !== undefined) {
        const hello = await ctx.ssh.ready
        const child = ctx.subprocess.spawn({
          argv: [hello.node, '-e', 'require("node:fs").rmSync(process.argv[1],{recursive:true,force:true})', root], cwd: hello.workspace,
          stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } }, graceMs: 2000,
        })
        await child.done
      }
      vi.restoreAllMocks()
      await ctx.fiber.dispose()
    }
  }, 120_000)
})
