/** Real Loader and SSH acceptance for workspace registration on an execution target. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Config as SshConfig } from '@deepseek-ai/dsh-ssh'
import type {} from '../src/index.ts'
import type {} from '@deepseek-ai/dsh-subprocess-ssh'

const configPath = process.env.DSH_SSH_TEST_CONFIG
const require = createRequire(import.meta.url)

describe.skipIf(configPath === undefined || process.platform === 'win32')('SSH workspace registration', () => {
  it('creates, attaches, resolves and checks directories through a loaded SSH filesystem', async () => {
    const owned = await mkdtemp(join(tmpdir(), 'dsh-workspace-ssh-'))
    const ssh = JSON.parse(await readFile(configPath!, 'utf8')) as SshConfig
    const config = join(owned, 'cordis.yml')
    const template = JSON.parse(await readFile(new URL('./ssh.cordis.yml', import.meta.url), 'utf8')) as Array<{ id: string; name: string }>
    const configuration: Record<string, unknown> = {
      persistence: { root: join(owned, 'sessions') },
      'storage-json': { root: join(owned, 'storage') },
      domain: { backend: 'json' },
      policy: { mode: 'workspace-write', workspaceRoot: ssh.workspace },
      ssh,
    }
    const entries = template.map(entry => ({ ...entry,
      name: pathToFileURL(join(dirname(require.resolve(`${entry.name}/package.json`)), 'lib/index.js')).href,
      ...(configuration[entry.id] === undefined ? {} : { config: configuration[entry.id] }),
    }))
    await writeFile(config, JSON.stringify(entries))
    let ctx: Awaited<ReturnType<typeof boot>> | undefined
    let root: string | undefined
    try {
      ctx = await boot('workspace-ssh-acceptance', config)
      const hello = await ctx.ssh.ready
      root = `${hello.workspace}/registry-${randomUUID()}`
      const run = async (script: string) => {
        const handle = ctx!.subprocess.spawn({
          argv: [hello.node, '-e', script, root!], cwd: hello.workspace,
          stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } }, graceMs: 2000,
        })
        const result = await handle.done
        expect(await handle.waitForExit()).toBe(true)
        expect(result.exitCode, handle.collected.stderr?.readFrom(0).text).toBe(0)
      }
      await run("const fs=require('node:fs'),p=process.argv[1];fs.mkdirSync(p+'/directory',{recursive:true});fs.symlinkSync(p+'/directory',p+'/alias');fs.writeFileSync(p+'/file','text')")
      const registry = ctx.workspaceRegistry
      const workspace = await registry.create(`${root}/alias`)
      expect(workspace.path).toBe(`${root}/directory`)
      expect(await registry.create(`${root}/directory`)).toBe(workspace)
      expect(await registry.resolveByPath(`${root}/alias`)).toBe(workspace)
      const session = ctx.sessions.create(SessionId('remote-workspace-session'), { meta: { cwd: `${root}/alias` } })
      await workspace.attachSession(session.id)
      expect(workspace.sessionIds).toEqual([session.id])
      await expect(registry.create(`${root}/file`)).rejects.toThrow('not a directory')
      await expect(registry.create(`${root}/missing`)).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
      expect(await workspace.status()).toBe('ok')
      await run("require('node:fs').rmSync(process.argv[1]+'/directory',{recursive:true})")
      expect(await workspace.status()).toBe('missing-dir')
      expect(registry.list()).toHaveLength(1)
      await run("require('node:fs').rmSync(process.argv[1],{recursive:true})")
      root = undefined
    } finally {
      try {
        if (ctx !== undefined && root !== undefined) {
          const hello = await ctx.ssh.ready
          const handle = ctx.subprocess.spawn({
            argv: [hello.node, '-e', "require('node:fs').rmSync(process.argv[1],{recursive:true,force:true})", root], cwd: hello.workspace,
            stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } }, graceMs: 2000,
          })
          await handle.done
          await handle.waitForExit()
        }
      } finally {
        await ctx?.fiber.dispose()
        await rm(owned, { recursive: true, force: true })
      }
    }
  }, 120_000)
})
