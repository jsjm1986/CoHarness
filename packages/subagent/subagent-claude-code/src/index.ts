/**
 * Profile-named Claude Code one-shot subagent provider. Every accepted run
 * invokes the official Agent SDK in the delegating Session's workspace and
 * places the SDK-spawned real CLI under the shared subprocess owner.
 *
 * @module @deepseek-ai/dsh-subagent-claude-code
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  assertPositiveFinite,
  NO_START_CAPABILITIES,
  resolveChildCwd,
  type ContinuableCreateRequest,
  type ContinuableCreateSpec,
  type ResolvedSubagentStartRequest,
  type SubagentCapabilities,
  type SubagentProvider,
} from '@deepseek-ai/dsh-subagent'
import { ExternalBindingStore, externalMemberIdentity } from '@deepseek-ai/dsh-subagent/external'
import {
  CLAUDE_CODE_PERMISSION_MODES,
  DEFAULT_CLAUDE_CODE_PERMISSION_MODE,
  DEFAULT_DISPOSE_GRACE_MS,
  claudeCodeStartupFailure,
  startClaudeCodeRun,
  type ClaudeCodePermissionMode,
  type ClaudeCodeRunSpec,
} from './run.ts'
import {
  CLAUDE_MEMBER_MODEL,
  CLAUDE_MEMBER_ROUTE,
  ClaudeMemberAdapter,
  ClaudeMemberTransport,
  type ClaudeMemberConfig,
} from './member.ts'

export const name = 'subagent-claude-code'
export const inject = ['subagents', 'subprocess']

const DEFAULT_PROVIDER_NAME = 'claude-code'

/* jscpd:ignore-start -- sibling product providers intentionally expose
 * overlapping deployment-owned fields without adding a shared config owner. */
/** Deployment-owned model, permission, environment, and process-release settings. */
export interface Config {
  /** Provider name on `ctx.subagents` (default `claude-code`). */
  providerName?: string
  /** Native Claude model fixed for this instance; omitted to inherit Claude settings. */
  model?: string
  /**
   * Explicit environment entries layered over the subprocess seam's
   * credential-scrubbed parent environment.
   */
  env?: Record<string, string>
  /**
   * Native non-interactive mode fixed for this Provider instance. Defaults to
   * `dontAsk`; `acceptEdits` accepts edits, `auto` uses the native classifier,
   * `plan` returns a plan without approving execution, and
   * `bypassPermissions` explicitly skips permission checks.
   */
  permissionMode?: ClaudeCodePermissionMode
  /** Grace in milliseconds between Claude Code managed-range termination tiers. */
  disposeGraceMs?: number
  /**
   * Directory holding the instance-specific member binding store (default `claude-code.jsonl`),
   * which maps each durable child session to its Claude session id and pending
   * prompt. Required only for continuable members; defaults under `~/.dsh`.
   */
  stateDir?: string
  /**
   * Workspace for persistent member sessions. Member turns have no parent
   * Agent to inherit one from; defaults to the harness launch directory.
   */
  memberCwd?: string
}

export const Config: z<Config> = z.object({
  providerName: z.string().min(1).default(DEFAULT_PROVIDER_NAME),
  model: z.string().min(1),
  env: z.dict(z.string()).default({}),
  permissionMode: z.union([...CLAUDE_CODE_PERMISSION_MODES])
    .default(DEFAULT_CLAUDE_CODE_PERMISSION_MODE),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
  stateDir: z.string().min(1),
  memberCwd: z.string().min(1),
})

type ResolvedConfig = Omit<Required<Config>, 'model' | 'stateDir' | 'memberCwd'>
  & Pick<Config, 'model' | 'stateDir' | 'memberCwd'>
/* jscpd:ignore-end */

/* jscpd:ignore-start -- Cordis registration and shared-seam plumbing mirror
 * the Codex sibling; each product's lifecycle remains package-private. */
class ClaudeCodeProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = NO_START_CAPABILITIES
  readonly inheritsParentContext = false
  readonly agentRouteDefaults?: Readonly<{ provider: string; model: string }>

  constructor(
    readonly name: string,
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
    memberRoute: string | undefined,
  ) {
    if (memberRoute !== undefined) {
      this.agentRouteDefaults = {
        provider: memberRoute,
        model: config.model ?? CLAUDE_MEMBER_MODEL,
      }
      // Continuable members are in-process Agents whose model calls resolve to
      // this provider's member route; the external Claude session is bound and
      // resumed by the member adapter.
      this.prepareContinuable = (_request: ContinuableCreateRequest) => Promise.resolve({})
    }
  }

  declare prepareContinuable?: (
    request: ContinuableCreateRequest,
  ) => Promise<ContinuableCreateSpec>

  async start(request: ResolvedSubagentStartRequest) {
    const parentCwd = request.parent.session.header.cwd
    if (parentCwd === undefined) {
      throw new Error(
        'subagent-claude-code: no working directory for the child — delegate from a parent session that has one',
      )
    }
    let cwd: string
    try {
      cwd = resolveChildCwd(
        'subagent-claude-code',
        undefined,
        parentCwd,
      )
    } catch (error: unknown) {
      if (request.signal.aborted) {
        throw new Error(
          'subagent-claude-code: request was aborted before SDK startup',
        )
      }
      const failure = claudeCodeStartupFailure(error)
      this.ctx.logger.warn(
        `subagent-claude-code "${this.name}": child start failed: %o`,
        failure,
      )
      throw failure
    }
    const spec: ClaudeCodeRunSpec = {
      cwd,
      ...this.config.model === undefined ? {} : { model: this.config.model },
      permissionMode: this.config.permissionMode,
      env: this.config.env,
      disposeGraceMs: this.config.disposeGraceMs,
      spawn: spawnSpec => this.ctx.subprocess.spawn(spawnSpec),
      onError: (error, stopReason) => {
        this.ctx.logger.warn(
          `subagent-claude-code "${this.name}": child run failed (${stopReason}): %o`,
          error,
        )
      },
    }
    return startClaudeCodeRun(request, spec)
  }
}

/**
 * Register one Profile-named Claude Code provider.
 * @param ctx - context carrying shared subagent and subprocess services.
 * @param config - registry name, optional model, permission mode, child environment, and disposal grace.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved: ResolvedConfig = {
    providerName: config.providerName ?? DEFAULT_PROVIDER_NAME,
    ...config.model === undefined ? {} : { model: config.model },
    env: config.env as Record<string, string>,
    permissionMode: config.permissionMode ?? DEFAULT_CLAUDE_CODE_PERMISSION_MODE,
    disposeGraceMs: config.disposeGraceMs as number,
    ...config.stateDir === undefined ? {} : { stateDir: config.stateDir },
    ...config.memberCwd === undefined ? {} : { memberCwd: config.memberCwd },
  }
  assertPositiveFinite(
    'subagent-claude-code',
    'disposeGraceMs',
    resolved.disposeGraceMs,
  )
  if (resolved.disposeGraceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `subagent-claude-code: disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  // Persistent members need the `llm` service to resolve their model route.
  // When no LLM capability is mounted the provider stays one-shot only:
  // without `prepareContinuable` the service rejects continuable starts.
  const llm = ctx.get('llm')
  const identity = externalMemberIdentity(resolved.providerName, DEFAULT_PROVIDER_NAME, CLAUDE_MEMBER_ROUTE)
  let memberRoute: string | undefined
  if (llm !== undefined) {
    const memberConfig: ClaudeMemberConfig = {
      cwd: resolved.memberCwd ?? process.cwd(),
      ...resolved.model === undefined ? {} : { model: resolved.model },
      permissionMode: resolved.permissionMode,
      env: resolved.env,
      disposeGraceMs: resolved.disposeGraceMs,
    }
    const store = new ExternalBindingStore(
      join(resolved.stateDir ?? join(homedir(), '.dsh', 'external-members'), identity.filename),
    )
    const transport = new ClaudeMemberTransport(
      memberConfig,
      spec => ctx.subprocess.spawn(spec),
    )
    ctx.effect(() => {
      const registration = llm.registerAdapter(
        [identity.route],
        new ClaudeMemberAdapter(transport, store),
      )
      return () => { registration() }
    })
    memberRoute = identity.route
  }
  ctx.subagents.registerProvider(new ClaudeCodeProvider(
    resolved.providerName,
    ctx,
    resolved,
    memberRoute,
  ))
}
/* jscpd:ignore-end */
