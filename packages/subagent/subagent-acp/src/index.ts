/**
 * Out-of-process ACP subagent backend. Each child has its own process, session, model, and
 * tools, so it shares no Cordis context and advertises no parent-enforced start capabilities;
 * workspace and process execution use the owning Session's target. Named exports preserve
 * loader metadata (see `docs/postmortem/0001-acp-default-export-drops-inject.md`).
 * @module @deepseek-ai/dsh-subagent-acp
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { resolveChildExecution, externalMemberAgent, type ChildExecution } from '@deepseek-ai/dsh-subagent'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  ContinuableCreateRequest,
  ContinuableCreateSpec,
  ResolvedSubagentStartRequest,
  SubagentCapabilities,
  SubagentProvider,
} from '@deepseek-ai/dsh-subagent'
import { ExternalBindingStore } from '@deepseek-ai/dsh-subagent/external'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { acpConfigurationFailure, type AcpRunSpec, DEFAULT_DISPOSE_EOF_GRACE_MS, DEFAULT_DISPOSE_GRACE_MS, type PermissionPolicy, startAcpRun } from './run.ts'
import {
  ACP_MEMBER_MODEL,
  ACP_MEMBER_ROUTE,
  AcpMemberAdapter,
  AcpMemberTransport,
  type AcpMemberConfig,
} from './member.ts'

export const name = 'subagent-acp'
export const inject = ['subagents', 'subprocess']

/** Config: how to spawn and drive the child ACP agent process. */
export interface Config {
  /** Provider name on `ctx.subagents` (default `acp`). */
  providerName: string
  /** The executable to spawn for each run (the child ACP agent). */
  command: string
  /** Arguments passed to {@link command}. */
  args: string[]
  /**
   * Working directory override for the child process and its ACP session.
   * Must be non-empty; a relative path resolves against the harness launch
   * directory at load, and the result must be an existing directory. When
   * omitted, each child inherits its delegating parent session's cwd — and
   * starting one from a parent session that has no cwd fails.
   */
  cwd?: string
  /**
   * How to auto-answer the child's `session/request_permission` prompts:
   * `reject` (default — decline every prompt) or `allow` (approve via the first
   * `allow_once` or `allow_always` option). No prompt is surfaced to a human.
   */
  permission: PermissionPolicy
  /**
   * Extra environment variables for the child process — e.g. the child
   * harness's own `DEEPSEEK_API_KEY`. Forwarded on top of a credential-scrubbed
   * copy of the parent env, so an explicit key here reaches the child while
   * ambient secrets do not leak implicitly.
   */
  env: Record<string, string>
  /**
   * Grace period (ms) for the child's EOF-driven quiesce on dispose — its
   * window to flush persistence and tear down its own nested subprocesses
   * before the parent escalates to a signal. Must not exceed
   * `MAX_TIMER_DELAY_MS`.
   */
  disposeEofGraceMs?: number
  /** Termination-escalation grace (ms); must not exceed `MAX_TIMER_DELAY_MS`. */
  disposeGraceMs?: number
  /**
   * Enable persistent members: the provider gains `prepareContinuable`, so
   * Team members run as in-process continuation-managed children whose model
   * calls drive durable ACP sessions through `session/load`. Requires the
   * configured agent to advertise `loadSession`; the provider probes that
   * capability at member creation and rejects agents that cannot resume.
   * Default `false`: the provider stays one-shot only and continuable starts
   * are rejected.
   */
  resume?: boolean
  /**
   * Directory holding the member binding store (`<stateDir>/acp.jsonl`),
   * mapping each durable child session to its ACP session id and pending
   * prompt. Used only when {@link resume} is enabled; defaults under `~/.dsh`.
   */
  stateDir?: string
  /**
   * Workspace override for persistent ACP members; defaults to {@link cwd},
   * else the member Session working directory. Used only with {@link resume}.
   */
  memberCwd?: string
}

export const Config: z<Config> = z.object({
  providerName: z.string().default('acp'),
  command: z.string().required(),
  args: z.array(z.string()).default([]),
  cwd: z.string(),
  permission: z.union(['allow', 'reject'] as const).default('reject'),
  env: z.dict(z.string()).default({}),
  disposeEofGraceMs: z.number().default(DEFAULT_DISPOSE_EOF_GRACE_MS),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
  resume: z.boolean().default(false),
  stateDir: z.string(),
  memberCwd: z.string(),
})

/** A dispose grace must fit the single Node timer that owns its teardown tier. */
function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(`subagent-acp: ${name} must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}

/** The shape after schemastery applied the defaults (cwd/stateDir/memberCwd have none). */
type ResolvedConfig =
  Required<Omit<Config, 'cwd' | 'stateDir' | 'memberCwd'>>
  & Pick<Config, 'cwd' | 'stateDir' | 'memberCwd'>

/**
 * The ACP provider. Advertises NO start-time capabilities: an out-of-process
 * child cannot honor `outputSchema`/`maxDepth`/`toolFilter` (the service rejects
 * a request needing any of them before `start` runs).
 */
class AcpProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = {
    outputSchema: false,
    depthLimit: false,
    toolFilter: false,
    persona: false,
    agentOptions: false,
  }
  // Context contract: an out-of-process ACP child starts fresh — no parent conversation crosses the process boundary.
  readonly inheritsParentContext = false
  readonly agentRouteDefaults?: Readonly<{ provider: string; model: string }>

  constructor(
    readonly name: string,
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
    prepareMember?: (request: ContinuableCreateRequest) => Promise<void>,
  ) {
    if (prepareMember !== undefined) {
      this.agentRouteDefaults = {
        provider: ACP_MEMBER_ROUTE,
        model: ACP_MEMBER_MODEL,
      }
      this.prepareContinuable = async (
        request: ContinuableCreateRequest,
      ): Promise<ContinuableCreateSpec> => {
        // Probe once at member creation: a one-shot-only ACP agent is rejected
        // here, before the durable child exists.
        await prepareMember(request)
        return {}
      }
    }
  }

  declare prepareContinuable?: (
    request: ContinuableCreateRequest,
  ) => Promise<ContinuableCreateSpec>

  async start(request: ResolvedSubagentStartRequest) {
    if (request.signal.aborted) {
      throw new Error('subagent request was aborted before the ACP child started')
    }
    let execution: ChildExecution
    try {
      execution = await resolveChildExecution(this.ctx, request.parent, this.config.cwd, request.signal)
    } catch (error: unknown) {
      const failure = acpConfigurationFailure(error)
      this.ctx.logger.warn(`subagent-acp "${this.name}": child start failed: %o`, error)
      throw failure
    }
    const spec: AcpRunSpec = {
      command: execution.remote
        ? await execution.subprocess.resolveExecutable(this.config.command, this.config.env, request.signal) : this.config.command,
      args: this.config.args,
      cwd: execution.cwd,
      permission: this.config.permission,
      env: this.config.env,
      disposeEofGraceMs: this.config.disposeEofGraceMs,
      disposeGraceMs: this.config.disposeGraceMs,
      spawn: spec => execution.subprocess.spawn(spec),
      onError: (error, stopReason) => {
        // The seam forbids `result` rejecting, so a child-level failure is
        // flattened to a stop reason — preserve it here rather than losing it.
        this.ctx.logger.warn(`subagent-acp "${this.name}": child run failed (${stopReason}): ${error.message}`)
      },
    }
    return startAcpRun(request, spec)
  }
}

export function apply(ctx: Context, config: Config): void {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  assertPositiveFinite('disposeEofGraceMs', resolved.disposeEofGraceMs)
  assertPositiveFinite('disposeGraceMs', resolved.disposeGraceMs)
  // `path.resolve('')` is the process cwd — an empty string would silently
  // reintroduce the launch-directory fallback this resolution removed.
  if (resolved.cwd === '') {
    throw new Error('subagent-acp: config cwd must not be empty — omit the key to inherit the parent session cwd')
  }
  // Interpret a relative configured cwd against the harness launch directory
  // once at load; directory access is checked on the selected execution target.
  const validated: ResolvedConfig = resolved.cwd === undefined
    ? resolved
    : { ...resolved, cwd: resolve(resolved.cwd) }

  // Persistent members need the `llm` service for their model route AND the
  // `resume` opt-in. Without either the provider stays one-shot only: no
  // `prepareContinuable`, so continuable starts are rejected.
  let prepareMember: ((request: ContinuableCreateRequest) => Promise<void>) | undefined
  const llm = ctx.get('llm')
  if (validated.resume) {
    if (llm === undefined) {
      throw new Error(
        'subagent-acp: `resume` requires the `llm` service for the member model route',
      )
    }
    const store = new ExternalBindingStore(
      join(validated.stateDir ?? join(homedir(), '.dsh', 'external-members'), 'acp.jsonl'),
    )
    const resolveMember = async (agent: Agent, signal: AbortSignal) => {
      const execution = await resolveChildExecution(ctx, agent, validated.memberCwd ?? validated.cwd, signal)
      const memberConfig: AcpMemberConfig = {
        command: execution.remote
          ? await execution.subprocess.resolveExecutable(validated.command, validated.env, signal) : validated.command,
        args: validated.args, cwd: execution.cwd, permission: validated.permission, env: validated.env,
        disposeEofGraceMs: validated.disposeEofGraceMs, disposeGraceMs: validated.disposeGraceMs,
      }
      return { execution, transport: new AcpMemberTransport(memberConfig, spec => execution.subprocess.spawn(spec)) }
    }
    prepareMember = async (request) => {
      const { transport } = await resolveMember(request.parent, request.signal)
      await transport.probe(request.signal)
    }
    const transport = async (child: SessionId, signal: AbortSignal) => {
      const member = await resolveMember(externalMemberAgent(ctx, child), signal)
      store.assertExecution(child, member.execution)
      return member.transport
    }
    ctx.effect(() => {
      const registration = llm.registerAdapter(
        [ACP_MEMBER_ROUTE],
        new AcpMemberAdapter(transport, store),
      )
      return () => { registration() }
    })
  }
  ctx.subagents.registerProvider(new AcpProvider(
    validated.providerName,
    ctx,
    validated,
    prepareMember,
  ))
}
