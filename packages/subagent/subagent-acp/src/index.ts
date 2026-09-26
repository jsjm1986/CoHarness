/**
 * Out-of-process ACP subagent backend. Each child has its own process, session, model, and
 * tools, so it shares no Cordis context and advertises no parent-enforced start capabilities;
 * the ONE thing it reads off `request.parent` is the session's workspace cwd (see
 * {@link resolveCwd}). This plugin uses named exports only; a default would hide its
 * loader metadata (see `docs/postmortem/0001-acp-default-export-drops-inject.md`).
 * @module @deepseek-ai/dsh-subagent-acp
 */

import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  ContinuableCreateRequest,
  ContinuableCreateSpec,
  ResolvedSubagentStartRequest,
  SubagentCapabilities,
  SubagentProvider,
  SubagentStartRequest,
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
   * Workspace for member ACP sessions. Member turns have no parent session to
   * inherit one from; defaults to {@link cwd}, else the harness launch
   * directory. Used only when {@link resume} is enabled.
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
 * Whether `path` names an existing directory the harness can ENTER. The
 * search-permission probe matters: `statSync().isDirectory()` is true for a
 * mode-600 directory, but a subprocess cwd needs `X_OK` or spawn fails EACCES.
 */
function isDirectory(path: string): boolean {
  try {
    if (!statSync(path).isDirectory()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    // statSync/accessSync throw only filesystem access errors here
    // (ENOENT/EACCES/ENOTDIR/…), and every one of them means the path cannot
    // serve as the child's cwd.
    return false
  }
}

/**
 * Assert `cwd` can actually host the child: absolute (it doubles as the ACP
 * session workspace, and a relative path would be re-anchored to the server
 * process's launch directory) and an existing directory (fail here, before the
 * process boundary, instead of as an ambiguous spawn ENOENT).
 * @param label - which source supplied the value, for the diagnostic.
 * @param cwd - the candidate working directory.
 * @returns `cwd`, validated.
 */
function assertUsableCwd(label: string, cwd: string): string {
  if (!isAbsolute(cwd)) {
    throw new Error(`subagent-acp: ${label} must be an absolute path: ${cwd}`)
  }
  if (!isDirectory(cwd)) {
    throw new Error(`subagent-acp: ${label} is not an accessible directory: ${cwd}`)
  }
  return cwd
}

/**
 * Resolve the child's working directory: the deployment `cwd` override when
 * configured (already validated at load), else the parent session's workspace
 * cwd (validated here, its earliest resolvable point). Fails loud when neither
 * exists — falling back to the harness process cwd would silently bind the
 * child to the server's launch directory instead of the delegating session's
 * workspace (one server process serves many sessions, each with its own cwd).
 */
function resolveCwd(configured: string | undefined, request: SubagentStartRequest): string {
  if (configured !== undefined) return configured
  const parentCwd = request.parent.session.header.cwd
  if (parentCwd === undefined) {
    throw new Error('subagent-acp: no working directory for the child — configure `cwd` or delegate from a parent session that has one')
  }
  return assertUsableCwd('parent session cwd', parentCwd)
}

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
    transport?: AcpMemberTransport,
  ) {
    if (transport !== undefined) {
      this.agentRouteDefaults = {
        provider: ACP_MEMBER_ROUTE,
        model: ACP_MEMBER_MODEL,
      }
      this.prepareContinuable = async (
        request: ContinuableCreateRequest,
      ): Promise<ContinuableCreateSpec> => {
        // Probe once at member creation: a one-shot-only ACP agent is rejected
        // here, before the durable child exists.
        await transport.probe(request.signal)
        return {}
      }
    }
  }

  declare prepareContinuable?: (
    request: ContinuableCreateRequest,
  ) => Promise<ContinuableCreateSpec>

  start(request: ResolvedSubagentStartRequest) {
    if (request.signal.aborted) {
      throw new Error('subagent request was aborted before the ACP child started')
    }
    let cwd: string
    try {
      cwd = resolveCwd(this.config.cwd, request)
    } catch (error: unknown) {
      const failure = acpConfigurationFailure(error)
      this.ctx.logger.warn(`subagent-acp "${this.name}": child start failed: %o`, error)
      throw failure
    }
    const spec: AcpRunSpec = {
      command: this.config.command,
      args: this.config.args,
      cwd,
      permission: this.config.permission,
      env: this.config.env,
      disposeEofGraceMs: this.config.disposeEofGraceMs,
      disposeGraceMs: this.config.disposeGraceMs,
      spawn: spec => this.ctx.subprocess.spawn(spec),
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
  // ONCE, at load, and fail a misconfigured directory here — not per start.
  const validated: ResolvedConfig = resolved.cwd === undefined
    ? resolved
    : { ...resolved, cwd: assertUsableCwd('config cwd', resolve(resolved.cwd)) }

  // Persistent members need the `llm` service for their model route AND the
  // `resume` opt-in. Without either the provider stays one-shot only: no
  // `prepareContinuable`, so continuable starts are rejected.
  let transport: AcpMemberTransport | undefined
  const llm = ctx.get('llm')
  if (validated.resume) {
    if (llm === undefined) {
      throw new Error(
        'subagent-acp: `resume` requires the `llm` service for the member model route',
      )
    }
    const memberCwd = validated.memberCwd === undefined
      ? validated.cwd ?? process.cwd()
      : assertUsableCwd('memberCwd', resolve(validated.memberCwd))
    const memberConfig: AcpMemberConfig = {
      command: validated.command,
      args: validated.args,
      cwd: memberCwd,
      permission: validated.permission,
      env: validated.env,
      disposeEofGraceMs: validated.disposeEofGraceMs,
      disposeGraceMs: validated.disposeGraceMs,
    }
    transport = new AcpMemberTransport(
      memberConfig,
      spec => ctx.subprocess.spawn(spec),
    )
    const store = new ExternalBindingStore(
      join(validated.stateDir ?? join(homedir(), '.dsh', 'external-members'), 'acp.jsonl'),
    )
    ctx.effect(() => {
      const registration = llm.registerAdapter(
        [ACP_MEMBER_ROUTE],
        new AcpMemberAdapter(transport as AcpMemberTransport, store),
      )
      return () => { registration() }
    })
  }
  ctx.subagents.registerProvider(new AcpProvider(
    validated.providerName,
    ctx,
    validated,
    transport,
  ))
}
