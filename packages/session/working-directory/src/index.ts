/**
 * Session working directories, durable changes, and model context.
 * @module @deepseek-ai/dsh-working-directory
 */

import { isAbsolute } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { environmentForAgent } from '@deepseek-ai/dsh-agent-presets'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'

declare module '@deepseek-ai/cordis' {
  interface Context {
    workingDirectory: WorkingDirectoryService
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Committed working-directory transition notices.
     * @persistenceAttribution
     */
    'working-directory': { kind: 'working-directory' }
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Effective working directory; the immutable Session header retains the original project. */
    'working-directory/change': {
      /** Absolute directory used by subsequent directory-based operations. */
      cwd: string
    }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Recorded current directory for Session observations, or null when none is recorded. */
    workingDirectory: string | null
  }

  interface SessionProjectionStateMap {
    /** Last committed working directory, or null before an explicit value exists. */
    workingDirectory: string | null
  }
}

/** Deployment default for Sessions without an original project directory. */
export interface Config {
  /** Absolute execution-world fallback directory; omitted values use the launch directory. */
  defaultDirectory?: string
}

/** A domain answer the service itself produced, distinct from a provider transport failure. */
class WorkingDirectoryError extends Error {}

/** One owner for each Session's effective directory and its model-visible changes. */
export class WorkingDirectoryService extends Service {
  static inject = ['fs', 'sessionProjections', 'systemPrompt']

  static Config: z<Config> = z.object({
    defaultDirectory: z.string(),
  })

  /** Absolute deployment fallback for Sessions with no recorded original directory. */
  readonly defaultDirectory: string
  private readonly pending = new WeakMap<Session, Promise<void>>()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly transportWarned = new WeakSet<Session>()
  private readonly lifecycle = new AbortController()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'workingDirectory')
    const directory = config.defaultDirectory ?? process.cwd()
    if (!isAbsolute(directory)) throw new Error('working-directory: defaultDirectory must be absolute')
    this.defaultDirectory = directory

    const directorySchema = zod.string().min(1).refine(isAbsolute).nullable()
    ctx.sessionProjections.register({
      key: 'workingDirectory',
      stateVersion: 1,
      stateSchema: directorySchema,
      init: header => header.cwd ?? null,
      apply: (state, event) => event.type === 'working-directory/change' ? event.data.cwd : state,
      wire: { viewSchema: directorySchema, view: state => state },
    })
    ctx.systemPrompt.context({
      name: 'working-directory:current',
      order: ctx.systemPrompt.getContextOrder('WORKING_DIRECTORY'),
      required: true,
      interpolate: false,
      text: context => context.agent === undefined ? '' : this.contextText(context.agent.session),
    })
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      if (context.agent === undefined) return next()
      await this.ensure(context.agent, context.signal)
      const assembly = await next()
      this.lifecycle.signal.throwIfAborted()
      const text = this.contextText(context.agent.session)
      const contribution = assembly.contexts.find(entry => entry.name === 'working-directory:current')
      if (contribution === undefined) assembly.contexts.unshift({ name: 'working-directory:current', text, interpolate: false })
      else {
        contribution.text = text
        contribution.interpolate = false
      }
      return assembly
    }, { prepend: true })
    ctx.effect(() => async () => {
      this.lifecycle.abort(new Error('working-directory service disposed'))
      await Promise.allSettled(this.operations)
    })
  }

  /**
   * Read the committed directory without filesystem I/O.
   * @param session - Session whose directory is requested.
   * @returns its effective absolute directory.
   */
  get(session: Session): string {
    return this.ctx.sessionProjections.stateOf(session, 'workingDirectory') ?? this.defaultDirectory
  }

  /**
   * Validate the current directory and restore the original project when it disappeared.
   * @param agent - live or unpublished Agent owning the Session.
   * @param signal - cancellation for filesystem inspection.
   * @returns the existing directory; recovery is committed before fulfillment.
   * A notice failure is warned without reverting the committed state. A provider
   * transport failure returns the recorded directory without committing anything
   * and warns once per Session until a later validation succeeds.
   * @throws when the original project is also unavailable.
   */
  ensure(agent: Agent, signal?: AbortSignal): Promise<string> {
    return this.serialize(agent, signal, async (control) => {
      const fs = this.fsFor(agent)
      const current = this.get(agent.session)
      const original = agent.session.header.cwd ?? this.defaultDirectory
      let info
      let target
      try {
        target = await fs.resolve(current, { signal: control })
        info = await fs.stat(target, control)
      } catch (error) {
        if (control.aborted) throw error
        return this.degraded(agent, error, current)
      }
      control.throwIfAborted()
      agent.ctx.fiber.assertActive()
      if (info?.type === 'directory') {
        // A recorded directory must sit inside the project root; logs written
        // without containment, or forked and imported logs, can carry one
        // that does not.
        let root
        try {
          root = await fs.resolve(original, { signal: control })
        } catch (error) {
          if (control.aborted) throw error
          return this.degraded(agent, error, current)
        }
        control.throwIfAborted()
        if (fs.contains(root, target)) {
          this.transportWarned.delete(agent.session)
          if (this.ctx.sessionProjections.stateOf(agent.session, 'workingDirectory') === null) {
            agent.session.append('working-directory/change', { cwd: current })
          }
          return current
        }
      }
      let restored: string
      try {
        restored = await this.resolveCanonical(agent, original, original, control)
      } catch (error) {
        if (control.aborted || error instanceof WorkingDirectoryError) throw error
        return this.degraded(agent, error, current)
      }
      this.transportWarned.delete(agent.session)
      this.commit(agent, restored, true, control)
      return restored
    })
  }

  /**
   * Canonicalize a candidate directory under the project root without committing.
   * @param agent - live or unpublished Agent owning the Session.
   * @param path - absolute path or a path relative to its current directory.
   * @param signal - cancellation for filesystem inspection.
   * @returns the canonical absolute directory, guaranteed inside the project root.
   * @throws when the path is not an existing directory inside the project.
   */
  resolve(agent: Agent, path: string, signal?: AbortSignal): Promise<string> {
    return this.serialize(agent, signal, async control => this.resolveCanonical(agent, path, this.get(agent.session), control))
  }

  /**
   * Change one Session's directory without changing existing processes or permissions.
   * @param agent - live or unpublished Agent owning the Session.
   * @param path - absolute path or a path relative to its current directory.
   * @param signal - cancellation before the durable change.
   * @returns the canonical absolute directory, committed before fulfillment.
   * A notice failure is warned; the next request still receives the committed directory.
   * @throws when the requested path is not an existing directory inside the project root.
   */
  set(agent: Agent, path: string, signal?: AbortSignal): Promise<string> {
    return this.serialize(agent, signal, async (control) => {
      const directory = await this.resolveCanonical(agent, path, this.get(agent.session), control)
      this.commit(agent, directory, false, control)
      return directory
    })
  }

  /**
   * The filesystem one Session's directories live on. An SSH-bound Session runs
   * inside a standing realm whose provider tree is not the host's, so its
   * directories resolve and compare through the realm's `fs` — never the host
   * filesystem, which would read a different machine's paths.
   */
  private fsFor(agent: Agent): FileSystem {
    if (agent.session.header.sshTarget === undefined) return this.ctx.fs
    const fs = environmentForAgent(this.ctx, agent, 'fs')
    if (fs === undefined) {
      throw new WorkingDirectoryError(`working-directory: SSH-bound Session ${JSON.stringify(agent.session.id)} has no SSH filesystem`)
    }
    return fs
  }

  private contextText(session: Session): string {
    return `Current working directory: ${JSON.stringify(this.get(session))}.`
  }

  /** Resolve an existing directory inside the project root to its canonical absolute path. */
  private async resolveCanonical(agent: Agent, path: string, cwd: string, signal: AbortSignal): Promise<string> {
    if (path.length === 0) throw new WorkingDirectoryError('working-directory: cd must not be empty')
    const fs = this.fsFor(agent)
    const rootPath = agent.session.header.cwd ?? this.defaultDirectory
    const root = await fs.resolve(rootPath, { signal })
    const target = await fs.resolve(path, { cwd, signal })
    const info = await fs.stat(target, signal)
    signal.throwIfAborted()
    if (info?.type !== 'directory') {
      throw new WorkingDirectoryError(`working-directory: directory does not exist: ${JSON.stringify(path)}`)
    }
    if (!fs.contains(root, target)) {
      throw new WorkingDirectoryError(`working-directory: ${JSON.stringify(path)} is outside the project directory ${JSON.stringify(fs.processPath(root))}`)
    }
    return fs.processPath(target)
  }

  /** Keep the recorded directory when the provider could not answer, warning once per Session. */
  private degraded(agent: Agent, error: unknown, current: string): string {
    if (!this.transportWarned.has(agent.session)) {
      this.transportWarned.add(agent.session)
      this.ctx.logger.warn(`working-directory: could not validate ${JSON.stringify(current)} for Session ${JSON.stringify(agent.session.id)}; keeping the recorded directory: ${String(error)}`)
    }
    return current
  }

  private commit(agent: Agent, directory: string, recovered: boolean, signal: AbortSignal): void {
    signal.throwIfAborted()
    agent.ctx.fiber.assertActive()
    const previous = this.get(agent.session)
    if (previous === directory) return
    agent.session.append('working-directory/change', { cwd: directory })
    const notice = createUserMessage({
      content: [{
        type: 'text',
        text: recovered
          ? `The working directory ${JSON.stringify(previous)} is unavailable. The working directory is now ${JSON.stringify(directory)}.`
          : `The working directory changed from ${JSON.stringify(previous)} to ${JSON.stringify(directory)}.`,
      }],
      source: { kind: 'working-directory' },
    })
    try {
      agent.inject(notice)
    } catch (error) {
      this.ctx.logger.warn(`working-directory: committed ${JSON.stringify(directory)}, but could not queue its notice: ${String(error)}`)
    }
  }

  private serialize<T>(agent: Agent, signal: AbortSignal | undefined, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const session = agent.session
    const control = signal === undefined
      ? this.lifecycle.signal
      : AbortSignal.any([this.lifecycle.signal, signal])
    const operation = (this.pending.get(session) ?? Promise.resolve()).then(() => {
      control.throwIfAborted()
      agent.ctx.fiber.assertActive()
      return action(control)
    })
    const settled = operation.finally(() => this.operations.delete(settled))
    this.operations.add(settled)
    this.pending.set(session, settled.then(() => {}, () => {}))
    return settled
  }
}

export default WorkingDirectoryService
