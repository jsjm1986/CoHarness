/** Local process providers do not require the optional standing-realm implementation. */
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { expect, it, onTestFinished, vi } from 'vitest'
import { resolveChildExecution } from '../src/out-of-process.ts'

vi.mock('@deepseek-ai/dsh-agent-presets', () => { throw new Error('optional preset package is not installed') })

it('resolves a local workspace without presets and rejects missing providers or working directories', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const agent = { ctx, session: { header: { cwd: tmpdir() } } } as Agent
  const signal = new AbortController().signal
  await expect(resolveChildExecution(ctx, agent, undefined, signal)).rejects.toThrow('no subprocess provider')
  ctx.provide('subprocess', { marker: 'local-provider' } as never)
  expect(await resolveChildExecution(ctx, agent, undefined, signal)).toMatchObject({
    cwd: realpathSync(tmpdir()), target: 'local', remote: false, subprocess: { marker: 'local-provider' },
  })
  const noDirectory = { ctx, session: { header: {} } } as Agent
  await expect(resolveChildExecution(ctx, noDirectory, undefined, signal)).rejects.toThrow('requires a Session working directory')
  expect(await resolveChildExecution(ctx, noDirectory, tmpdir(), signal)).toMatchObject({ cwd: realpathSync(tmpdir()), target: 'local' })
})

it('refuses an SSH execution when its realm resolver is unavailable instead of borrowing local providers', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const local = { resolveExecutable: vi.fn() }
  ctx.provide('subprocess', local as never)
  const agent = { ctx, session: { header: { cwd: '/remote-only', sshTarget: 17 } } } as Agent
  await expect(resolveChildExecution(ctx, agent, undefined, new AbortController().signal))
    .rejects.toMatchObject({ cause: { message: 'optional preset package is not installed' } })
  expect(local.resolveExecutable).not.toHaveBeenCalled()
})
