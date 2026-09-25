/**
 * Profile-named Codex one-shot subagent provider. Every accepted run starts a
 * fresh official package-local Codex wrapper with `app-server --stdio` in the
 * delegating Session's workspace and publishes only after an ephemeral thread exists.
 *
 * @module @deepseek-ai/dsh-subagent-codex
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
  CODEX_PERMISSION_MODES,
  DEFAULT_CODEX_PERMISSION_MODE,
  DEFAULT_DISPOSE_GRACE_MS,
  codexStartupFailure,
  startCodexRun,
  type CodexPermissionMode,
  type CodexRunSpec,
} from './run.ts'
import {
  CODEX_MEMBER_MODEL,
  CODEX_MEMBER_ROUTE,
  CodexMemberAdapter,
  CodexMemberTransport,
  type CodexMemberConfig,
} from './member.ts'

export const name = 'subagent-codex'
export const inject = ['subagents', 'subprocess']

const DEFAULT_PROVIDER_NAME = 'codex'

/** Deployment-owned model, permission, environment, and process-release settings. */
export interface Config {
  /** Provider name on `ctx.subagents` (default `codex`). */
  providerName?: string
  /** Native Codex model fixed for this instance; omitted to inherit Codex settings. */
  model?: string
  /**
   * Explicit environment entries layered over the subprocess seam's
   * credential-scrubbed parent environment.
   */
  env?: Record<string, string>
  /** Native non-interactive permission mode fixed for this Provider instance. */
  permissionMode?: CodexPermissionMode
  /** Grace in milliseconds between app-server managed-range termination tiers. */
  disposeGraceMs?: number
  /**
   * Directory holding the instance-specific member binding store (default `codex.jsonl`),
   * which maps each durable child session to its Codex thread id and pending
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
  permissionMode: z.union([...CODEX_PERMISSION_MODES])
    .default(DEFAULT_CODEX_PERMISSION_MODE),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
  stateDir: z.string().min(1),
  memberCwd: z.string().min(1),
})

type ResolvedConfig = Omit<Required<Config>, 'model' | 'stateDir' | 'memberCwd'>
  & Pick<Config, 'model' | 'stateDir' | 'memberCwd'>

class CodexProvider implements SubagentProvider {
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
        model: config.model ?? CODEX_MEMBER_MODEL,
      }
      this.prepareContinuable = (_request: ContinuableCreateRequest) => Promise.resolve({})
    }
  }

  declare prepareContinuable?: (
    request: ContinuableCreateRequest,
  ) => Promise<ContinuableCreateSpec>

  start(request: ResolvedSubagentStartRequest) {
    const parentCwd = request.parent.session.header.cwd
    if (parentCwd === undefined) {
      throw new Error(
        'subagent-codex: no working directory for the child — delegate from a parent session that has one',
      )
    }
    let cwd: string
    try {
      cwd = resolveChildCwd(
        'subagent-codex',
        undefined,
        parentCwd,
      )
    } catch (error: unknown) {
      if (request.signal.aborted) {
        throw new Error(
          'subagent-codex: request was aborted before app-server startup',
        )
      }
      throw codexStartupFailure(error)
    }
    const spec: CodexRunSpec = {
      cwd,
      ...this.config.model === undefined ? {} : { model: this.config.model },
      permissionMode: this.config.permissionMode,
      env: this.config.env,
      disposeGraceMs: this.config.disposeGraceMs,
      spawn: spawnSpec => this.ctx.subprocess.spawn(spawnSpec),
      onError: (error, stopReason) => {
        this.ctx.logger.warn(
          `subagent-codex "${this.name}": child run failed (${stopReason}): ${error.message}`,
        )
      },
    }
    return startCodexRun(request, spec)
  }
}

/**
 * Register one Profile-named Codex provider.
 * @param ctx - context carrying shared subagent and subprocess services.
 * @param config - registry name, optional model, permission mode, child environment, and disposal grace.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved: ResolvedConfig = {
    providerName: config.providerName ?? DEFAULT_PROVIDER_NAME,
    ...config.model === undefined ? {} : { model: config.model },
    env: config.env as Record<string, string>,
    permissionMode: config.permissionMode ?? DEFAULT_CODEX_PERMISSION_MODE,
    disposeGraceMs: config.disposeGraceMs as number,
    ...config.stateDir === undefined ? {} : { stateDir: config.stateDir },
    ...config.memberCwd === undefined ? {} : { memberCwd: config.memberCwd },
  }
  assertPositiveFinite(
    'subagent-codex',
    'disposeGraceMs',
    resolved.disposeGraceMs,
  )
  if (resolved.disposeGraceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `subagent-codex: disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  // Persistent members need the `llm` service to resolve their model route.
  // When no LLM capability is mounted the provider stays one-shot only:
  // without `prepareContinuable` the service rejects continuable starts.
  const llm = ctx.get('llm')
  const identity = externalMemberIdentity(resolved.providerName, DEFAULT_PROVIDER_NAME, CODEX_MEMBER_ROUTE)
  let memberRoute: string | undefined
  if (llm !== undefined) {
    const memberConfig: CodexMemberConfig = {
      cwd: resolved.memberCwd ?? process.cwd(),
      ...resolved.model === undefined ? {} : { model: resolved.model },
      permissionMode: resolved.permissionMode,
      env: resolved.env,
      disposeGraceMs: resolved.disposeGraceMs,
    }
    const store = new ExternalBindingStore(
      join(resolved.stateDir ?? join(homedir(), '.dsh', 'external-members'), identity.filename),
    )
    const transport = new CodexMemberTransport(
      memberConfig,
      spec => ctx.subprocess.spawn(spec),
    )
    ctx.effect(() => {
      const registration = llm.registerAdapter(
        [identity.route],
        new CodexMemberAdapter(transport, store),
      )
      return () => { registration() }
    })
    memberRoute = identity.route
  }
  ctx.subagents.registerProvider(new CodexProvider(
    resolved.providerName,
    ctx,
    resolved,
    memberRoute,
  ))
}
