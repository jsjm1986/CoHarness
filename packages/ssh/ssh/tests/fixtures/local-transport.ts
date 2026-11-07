/** In-memory OpenSSH allocation boundary under the real subprocess admission service. */

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import { SubprocessRuntime, scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessOutcome, SubprocessOutputReader, SubprocessSpawnSpec, SubprocessTerminalEnvironment, SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'

/** Adapter for the controlled Node process peers in SSH transport tests. */
export class LocalSubprocessRuntime extends SubprocessRuntime {
  private readonly handles = new Set<SubprocessHandle>()

  constructor(ctx: Context) {
    super(ctx)
    ctx.effect(() => async () => {
      for (const handle of this.handles) handle.terminate()
      await Promise.all([...this.handles].map(handle => handle.waitForExit()))
    })
  }

  async resolveExecutable(command: string): Promise<string> { return command }
  terminalEnvironment(): Promise<SubprocessTerminalEnvironment> { throw new Error('SSH transport fixture has no terminals') }
  protected spawnTerminalProcess(): Promise<SubprocessTerminalHandle> { throw new Error('SSH transport fixture has no terminals') }

  protected spawnProcess(spec: SubprocessSpawnSpec): SubprocessHandle {
    const result = Promise.withResolvers<SubprocessOutcome>(), closed = Promise.withResolvers<undefined>()
    const executable = spec.argv[0] as string
    const args = spec.argv.slice(1)
    const env = { ...scrubbedParentEnv(), ...spec.env }
    let child: ChildProcess
    if (spec.stdio.stdin === 'pipe') {
      child = spawn(executable, args, { cwd: spec.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    } else {
      child = execFile(executable, args, { cwd: spec.cwd, env, signal: spec.signal, maxBuffer: 64 * 1024 }, (error) => {
        if (error !== null) result.reject(error)
      })
    }
    const collect = (stream: NodeJS.ReadableStream | null, mode: SubprocessSpawnSpec['stdio']['stdout']): SubprocessOutputReader | undefined => {
      if (mode === 'pipe' || mode === 'inherit') return undefined
      let buffer = Buffer.alloc(0), total = 0
      stream?.on('data', (data: Buffer) => {
        total += data.byteLength
        buffer = Buffer.concat([buffer, data]).subarray(-mode.maxBytes)
      })
      return { readFrom(offset) {
        const retained = total - buffer.byteLength
        return { text: buffer.subarray(Math.max(0, offset - retained)).toString('utf8'), nextOffset: total, lossy: offset < retained }
      } }
    }
    const stdout = collect(child.stdout, spec.stdio.stdout), stderr = collect(child.stderr, spec.stdio.stderr)
    const collected = { ...stdout === undefined ? {} : { stdout }, ...stderr === undefined ? {} : { stderr } }
    let stopped = false, terminating = false
    let timer: NodeJS.Timeout | undefined
    const terminate = (): void => {
      if (stopped || terminating) return
      terminating = true
      child.kill('SIGTERM')
      timer = setTimeout(() => { child.kill('SIGKILL') }, spec.graceMs)
    }
    const handle: SubprocessHandle = {
      stdin: spec.stdio.stdin === 'pipe' ? child.stdin ?? undefined : undefined,
      stdout: spec.stdio.stdout === 'pipe' ? child.stdout ?? undefined : undefined,
      stderr: spec.stdio.stderr === 'pipe' ? child.stderr ?? undefined : undefined,
      control: undefined, collected, done: result.promise, terminate,
      async waitForExit() { await closed.promise; return true },
    }
    child.once('error', (error) => { result.reject(error) })
    child.once('close', (exitCode: number | null, signal: NodeJS.Signals | null) => {
      stopped = true
      clearTimeout(timer)
      spec.signal?.removeEventListener('abort', terminate)
      this.handles.delete(handle)
      result.resolve({ exitCode, signal })
      closed.resolve(undefined)
    })
    spec.signal?.addEventListener('abort', terminate, { once: true })
    this.handles.add(handle)
    return handle
  }
}
