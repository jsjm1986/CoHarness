/**
 * The ONLY module that imports dsh-internal types. Concentrating the coupling
 * here means an upstream rename of the tool pipeline touches one file (see the
 * design doc's upstream-sync strategy). Everything else in this plugin is pure
 * Node logic.
 */
import { FsError } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-host-apiproxy'
import type {} from '@deepseek-ai/dsh-working-directory'
import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { classify } from './grants.ts'
import { decideDeny, type ResolveTarget } from './guard.ts'
import type { Grant } from './grants.ts'

/**
 * Register the directory guard on `tools/pre-execute`. Denies fs tool calls that
 * resolve outside the caller's grants; delegates every tool without a known path
 * argument (bash and other opaque tools stay bounded by the sandbox/kernel layer).
 * Relative paths use the Session working directory that the fs tools resolve
 * against, and every path is classified as `ctx.fs.processPath(await
 * ctx.fs.resolve(path, { cwd }))`, the canonical target the filesystem backend
 * itself opens.
 * @returns the listener disposer (also unwound automatically on plugin unload).
 */
export function registerGuard(ctx: Context, getGrants: () => readonly Grant[]): () => void {
  const stopTools = ctx.on(
    'tools/pre-execute',
    async (exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
      const cwd = exec.agent === undefined
        ? process.cwd()
        : await ctx.workingDirectory.ensure(exec.agent, exec.signal)
      const resolveTarget: ResolveTarget = async (path, base) =>
        ctx.fs.processPath(await ctx.fs.resolve(path, { cwd: base, signal: exec.signal }))
      const reason = await decideDeny({ name: exec.name, arguments: exec.arguments }, getGrants(), cwd, resolveTarget)
      return reason === null ? next() : { kind: 'deny', reason }
    },
  )
  const stopFiles = ctx.on('workspace-files/authorize', (_sessionId, path) => {
    if (classify(getGrants(), path) === 'none') throw new FsError('Workspace path is outside authorized directories', 'FS_PERMISSION_DENIED')
  })
  return () => { stopTools(); stopFiles() }
}
