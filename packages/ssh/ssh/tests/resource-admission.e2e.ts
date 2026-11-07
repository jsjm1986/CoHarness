/** Keyless local carrier and shipped helper exercise managed SSH transport allocation. */

import { createHash } from 'node:crypto'
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import ResourceBudget from '@deepseek-ai/dsh-resource-budget'
import type { ResourceLease, ResourceRequest } from '@deepseek-ai/dsh-resource-budget'
import { expect, it, vi } from 'vitest'
import { SshConnection } from '../src/index.ts'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { z } from 'zod'

it.skipIf(process.platform === 'win32')('admits its compiled local carrier and helper through plain Node', async (test) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-ssh-built-admission-')))
  const ctx = new Context()
  test.onTestFinished(async () => {
    try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
  })
  await ctx.plugin(LocalSubprocessRuntime)
  const fixture = fileURLToPath(new URL('./fixtures/built-resource-admission.mjs', import.meta.url))
  const child = await ctx.subprocess.spawn({
    argv: [process.execPath, fixture, root], cwd: root, signal: test.signal, graceMs: 5_000,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 64 * 1024 }, stderr: { maxBytes: 64 * 1024 } },
  })
  const outcome = await child.done
  expect(outcome, child.collected.stderr?.readFrom(0).text).toEqual({ exitCode: 0, signal: null })
  expect(await child.waitForExit()).toBe(true)
  const result = z.object({
    waited: z.literal(true), requests: z.number().int().min(4), completed: z.literal(true),
    uncertainties: z.literal(0), remoteJobStopped: z.literal(true),
  }).parse(JSON.parse(child.collected.stdout?.readFrom(0).text.trim() ?? ''))
  expect(result.remoteJobStopped).toBe(true)
})

it.skipIf(process.platform === 'win32')('admits the actual local carrier before starting its shipped helper and awaits process completion', async (test) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-ssh-admission-')))
  const ctx = new Context()
  const permit = new AbortController()
  const grant = Promise.withResolvers<ResourceLease>(), requested = Promise.withResolvers<ResourceRequest>()
  const owned: { connection?: SshConnection } = {}
  const release = vi.fn(async () => {}), uncertain = vi.fn(async () => {})
  test.onTestFinished(async () => {
    grant.resolve({ signal: permit.signal, release, uncertain })
    try { await owned.connection?.dispose() } finally {
      await ctx.fiber.dispose()
      permit.abort()
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })
  const bin = join(root, 'bin'), started = join(root, 'started')
  await mkdir(bin)
  const helper = fileURLToPath(new URL('../src/helper-entry.ts', import.meta.url))
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
  const carrier = join(bin, 'ssh')
  // The stand-in replaces only OpenSSH's external network/authentication and preserves its administrative byte carrier.
  await writeFile(carrier, `#!/bin/sh\nprintf started > ${quote(started)}\nexec ${quote(process.execPath)} --disable-sigusr1 --import ${quote(import.meta.resolve('tsx/esm'))} ${quote(helper)}\n`, { mode: 0o700 })
  await chmod(carrier, 0o700)
  vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH ?? ''}`)
  const acquire = vi.fn((request: ResourceRequest) => { requested.resolve(request); return grant.promise })
  ctx.provide('resourceBudgetRequired', true)
  new class extends ResourceBudget { acquire = acquire }(ctx)
  const connection = owned.connection = new SshConnection(ctx, {
    host: 'local-fixture', launch: { kind: 'node-script', node: process.execPath }, helper,
    helperHash: createHash('sha256').update(await readFile(helper)).digest('hex'), workspace: root,
    requestTimeoutMs: 5_000, leaseMs: 30_000,
  })
  const opening = connection.ready
  expect(await Promise.race([requested.promise, opening.then(() => { throw new Error('local carrier bypassed process admission') })]))
    .toMatchObject({ kind: 'process', origin: 'infrastructure' })
  await expect(access(started)).rejects.toThrow()
  grant.resolve({ signal: permit.signal, release, uncertain })
  expect(await opening).toMatchObject({ protocol: 2, kind: 'node-script', workspace: root })
  await expect(access(started)).resolves.toBeUndefined()
  expect(release).not.toHaveBeenCalled()
  await connection.dispose()
  expect(acquire).toHaveBeenCalledOnce()
  expect(release).toHaveBeenCalled()
  expect(uncertain).not.toHaveBeenCalled()
})
