/** Steward checkout preparation owns bounded native Git clients without blocking Gateway requests. */
import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import type { StewardSpaceConfig } from './config.ts'
import { scrubbedGatewayChildEnv } from './child-environment.ts'
import { documentRuntimeAccess } from './document-storage.ts'

class StewardGitCommandError extends Error {
  readonly killed: boolean
  constructor(readonly code: number | null, readonly signal: NodeJS.Signals | null, detail: string) {
    super(`Steward Git preparation failed (exit ${String(code)}, signal ${String(signal)})${detail === '' ? '' : `: ${detail}`}`)
    this.name = 'StewardGitCommandError'
    this.killed = signal !== null
  }
}

/**
 * Prepare a plain directory or a repository worktree while retaining existing provisioning branches.
 * Git hooks inherit the scrubbed tooling environment. Failed checkout contents remain for inspection;
 * this operation does not reset an existing worktree or claim rollback of Git's partial writes.
 * @param config - validated workspace, optional source and total preparation deadline.
 * @param lifetime - Gateway preparation lifetime; cancellation joins the provider's managed process range.
 * @returns after directory preparation or successful Git checkout, before Runtime allocation.
 */
export async function prepareStewardWorktree(
  config: Pick<StewardSpaceConfig, 'workspacePath' | 'sourcePath' | 'prepareTimeoutMs' | 'prepareKillGraceMs' | 'runtimeUser'>,
  lifetime: AbortSignal,
): Promise<void> {
  const signal = AbortSignal.any([lifetime, AbortSignal.timeout(config.prepareTimeoutMs)])
  signal.throwIfAborted()
  await mkdir(config.workspacePath, { recursive: true })
  // Managed Linux nodes run the steward Runtime under a dedicated account
  // while the Gateway provisions as root: grant the shared-runtime group
  // write access, mirroring shared-project document directories. Hosts
  // without managed accounts resolve no access adjustment.
  if (config.runtimeUser !== '') {
    const access = await documentRuntimeAccess(config.runtimeUser, true, config.prepareTimeoutMs, signal)
    await access.prepareDirectory?.(config.workspacePath)
  }
  signal.throwIfAborted()
  if (config.sourcePath === '') return
  try {
    await stat(join(config.workspacePath, '.git'))
    signal.throwIfAborted()
    return
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
  }
  const context = new Context()
  await using owner = { [Symbol.asyncDispose]: () => context.fiber.dispose() }
  await context.plugin(LocalSubprocessRuntime)
  const allowed = scrubbedGatewayChildEnv()
  const environment: NodeJS.ProcessEnv = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]))
  Object.assign(environment, allowed, { LC_ALL: 'C' })
  const executable = await context.subprocess.resolveExecutable('git', allowed, signal)
  const git = async (args: string[]): Promise<void> => {
    const collected = { maxBytes: 1024 * 1024 }
    const handle = await context.subprocess.spawn({
      argv: [executable, '-C', config.sourcePath, ...args], cwd: process.cwd(),
      stdio: { stdin: 'ignore', stdout: collected, stderr: collected },
      graceMs: config.prepareKillGraceMs, signal, env: environment,
    })
    const outcome = await handle.done
    if (!await handle.waitForExit()) throw new Error('Steward Git process termination remains unconfirmed')
    signal.throwIfAborted()
    if (outcome.exitCode !== 0) {
      throw new StewardGitCommandError(outcome.exitCode, outcome.signal, handle.collected.stderr!.readFrom(0).text.trim())
    }
  }
  let branchExists = true
  try {
    await git(['show-ref', '--verify', '--quiet', 'refs/heads/steward-workspace'])
  } catch (error) {
    signal.throwIfAborted()
    if (!(error instanceof StewardGitCommandError) || error.code !== 1 || error.signal !== null) throw error
    branchExists = false
  }
  signal.throwIfAborted()
  await git(['worktree', 'add', ...(branchExists ? ['--detach'] : ['-b', 'steward-workspace']), config.workspacePath, 'HEAD'])
  signal.throwIfAborted()
}
