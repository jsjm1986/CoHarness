/**
 * One delegation tool selects a configured external provider for each task.
 *
 * Local adaptation: the fork's `ctx.subagents` seam publishes a one-shot run
 * rather than an upstream-style managed activation, so this tool awaits
 * `subagents.start()` for the upstream publication boundary and hands the run
 * to `ctx.jobs`, whose settlement notice is the parent's completion delivery.
 * Sibling names are reserved tool-locally (this lane passes no name into
 * the catalog's version-3 committed-name field), matching the upstream
 * `agent-N` defaulting the model sees.
 *
 * @module @deepseek-ai/dsh-experimental-tool-subagent-oar
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import {
  renderSubagentFailure,
  settleRun,
  SubagentError,
} from '@deepseek-ai/dsh-subagent'
import type { SubagentRun } from '@deepseek-ai/dsh-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-subagent'

export const name = 'experimental-tool-subagent-oar'
export const inject = ['tools', 'subagents']

/** Deployment-owned runtime choices exposed by the external delegation tool. */
export interface Config {
  /** Model-visible runtime aliases mapped to registered subagent provider names. */
  providers: Record<string, string>
  /** Model-facing tool name (default subagent_oar). */
  toolName?: string
}

export const Config: z<Config> = z.object({
  providers: z.dict(z.string().min(1)).required(),
  toolName: z.string().min(1).default('subagent_oar'),
})

/** The root agent's fixed name; no child may take it. */
const ROOT_AGENT_NAME = 'lead'

/** One lower-case segment of at most 32 characters, so a 36-character UUID never matches. */
const NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u

/**
 * Whether a string is a valid child name.
 * @param value - candidate name segment.
 * @returns true for 1–32 lower-case letters, digits, or hyphens starting with a letter, other than `lead`.
 */
function isAgentName(value: string): boolean {
  return NAME_PATTERN.test(value) && value !== ROOT_AGENT_NAME
}

/**
 * Claim a sibling name against the names this tool already gave one parent.
 * This lane publishes no name into the catalog's version-3 committed-name
 * field, so claims cover only this plugin's own allocations; names the
 * catalog committed for other creators' children are not checked.
 * @param parent - exact live creator whose children share the namespace.
 * @param requested - requested name; omission selects the first free `agent-N`.
 * @returns the claimed name and its release for a failed startup.
 * @throws {@link SubagentError} `INVALID_AGENT_NAME` or `DUPLICATE_AGENT_NAME`.
 */
class SiblingNames {
  private readonly claimed = new WeakMap<Agent, Set<string>>()

  /**
   * Reserve a name; {@link SiblingNames.release} returns it to the pool.
   * @param parent - exact live parent delegating the child.
   * @param requested - model-supplied name, or undefined for `agent-N`.
   * @returns a release handle restoring the name when startup fails.
   */
  claim(parent: Agent, requested: string | undefined): { name: string; release(): void } {
    const taken = this.claimed.get(parent) ?? new Set<string>()
    let name: string
    if (requested === undefined) {
      let ordinal = 1
      while (taken.has(`agent-${ordinal}`)) ordinal++
      name = `agent-${ordinal}`
    } else {
      if (!isAgentName(requested)) {
        throw new SubagentError(
          `agent name ${JSON.stringify(requested)} is invalid; use 1-32 lower-case letters, digits, or hyphens `
          + `starting with a letter, other than "${ROOT_AGENT_NAME}"`,
          'INVALID_AGENT_NAME',
        )
      }
      if (taken.has(requested)) {
        throw new SubagentError(
          `agent name ${JSON.stringify(requested)} is already used by another subagent you created; choose another name`,
          'DUPLICATE_AGENT_NAME',
        )
      }
      name = requested
    }
    taken.add(name)
    this.claimed.set(parent, taken)
    // Exactly one caller invokes release: the execute that created the claim,
    // in its single failure path — set deletion keeps it idempotent.
    return {
      name,
      release: () => {
        taken.delete(name)
        if (taken.size === 0) this.claimed.delete(parent)
      },
    }
  }
}

/**
 * Settle one published run into the job's terminal outcome and hand
 * unconfirmed cleanup back to the service that owns the parent's lease.
 * @param run - published external child.
 * @param subagents - service owning the parent's run lease.
 * @param parent - exact delegating Agent the lease belongs to.
 * @returns outcome after child resources are released or retained.
 */
async function settlePublishedRun(
  run: SubagentRun,
  subagents: Context['subagents'],
  parent: Agent,
): Promise<JobOutcome> {
  return settleRun({
    ...run,
    dispose: async () => {
      try {
        await run.dispose()
      } catch (error: unknown) {
        // The runtime keeps exact-parent retry access to the failed cleanup;
        // the outcome still reports the failure this disposal surfaced.
        void subagents.retainFailedCleanup(parent, run).catch(() => undefined)
        throw error
      }
    },
  })
}

/**
 * Register a tool that selects one configured external provider per task.
 * @param ctx - shared tool registry and managed subagent service.
 * @param config - runtime choices and the model-facing tool name.
 */
export function apply(ctx: Context, config: Config): void {
  const providers = new Map(Object.entries(config.providers))
  if (providers.size === 0 || [...providers.keys()].some(runtime => runtime.trim().length === 0)) {
    throw new Error('subagent_oar: providers must contain at least one non-empty runtime alias')
  }
  const toolName = config.toolName ?? 'subagent_oar'
  const names = new SiblingNames()
  ctx.tools.register(defineTool({
    name: toolName,
    description: 'Delegate a self-contained task to a configured external agent. Choose its runtime for each call. '
      + 'The child works in its own context and does not see this conversation. '
      + 'This tool returns the child\'s name; a later completion notice reports its background job id — read the final answer with job_output. '
      + 'The child does not accept follow-up messages. Start independent tasks together and continue useful work while they run. '
      + 'When only waiting for their results remains, end your turn instead of polling.',
    parameters: {
      runtime: {
        type: 'string',
        required: true,
        enum: [...providers.keys()],
        description: 'Configured external runtime for this task.',
      },
      description: {
        type: 'string',
        required: true,
        description: 'A short description of the delegated task, for display.',
      },
      name: {
        type: 'string',
        description: 'Optional short name for the subagent, unique among the subagents you create: lower-case letters, '
          + 'digits, and hyphens, starting with a letter, at most 32 characters; lead is reserved for the root agent. Omitted names default to agent-1, agent-2, and so on.',
      },
      prompt: {
        type: 'string',
        required: true,
        description: 'The complete, self-contained task. Include all context the external agent needs.',
      },
      cwd: {
        type: 'string',
        description: 'Initial child working directory. Relative paths use your current directory; omission inherits it.',
      },
    },
    /* jscpd:ignore-start -- External and local delegation share the canonical
     * activation acknowledgement; their provider-selection policies remain separate. */
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'activation' },
          name: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `started subagent ${value.name}` }],
      presentationMeta: (_args, value) => ({ kind: value.kind, name: value.name }),
    },
    /* jscpd:ignore-end */
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) throw new Error('subagent_oar requires a calling agent')
      // The parameter enum admits only keys from this immutable configuration.
      const providerName = providers.get(args.runtime) as string
      const provider = ctx.subagents.getProvider(providerName)
      if (provider !== undefined && (provider.prepareContinuable !== undefined || provider.inheritsParentContext)) {
        throw new Error('subagent_oar requires a one-shot provider with independent conversation context')
      }
      // The jobs registry is the local parent-delivery seam: settlement of the
      // published run becomes the completion notice tool-jobs injects or wakes.
      const jobs = ctx.get('jobs')
      if (jobs === undefined) {
        throw new Error('subagent_oar requires a job registry for parent result delivery; load @deepseek-ai/dsh-jobs-local and @deepseek-ai/dsh-tool-jobs')
      }
      const claim = names.claim(parent, args.name)
      const controller = new AbortController()
      // The caller signal owns startup only until publication; after the run
      // publishes, the background job owns its remaining cancellation.
      const onAbort = (): void => { controller.abort() }
      exec.signal.addEventListener('abort', onAbort, { once: true })
      try {
        let run: SubagentRun
        try {
          run = await ctx.subagents.start(providerName, {
            label: args.description,
            prompt: [{ type: 'text', text: args.prompt }],
            parent,
            ...args.cwd === undefined ? {} : { cwd: args.cwd },
            signal: controller.signal,
          })
        } finally {
          exec.signal.removeEventListener('abort', onAbort)
        }
        try {
          jobs.start({
            kind: 'subagent',
            label: claim.name,
            toolCall: { callId: exec.callId, rootCallId: exec.rootCallId },
            owner: parent.id,
            run: () => ({
              cancel: () => {
                controller.abort()
                void run.dispose().catch(() => undefined)
              },
              done: settlePublishedRun(run, ctx.subagents, parent),
            }),
          })
        } catch (error: unknown) {
          // The run is already published: cancel and join it before surfacing
          // the registration failure rather than orphaning the child.
          void run.result.catch(() => undefined)
          try {
            await run.dispose()
          } catch (cleanupError: unknown) {
            ctx.logger.warn(`subagent_oar: disposal after job registration failure failed: ${renderSubagentFailure(cleanupError)}`)
            void ctx.subagents.retainFailedCleanup(parent, run).catch(() => undefined)
          }
          throw error
        }
        return { kind: 'activation' as const, name: claim.name }
      } catch (error: unknown) {
        claim.release()
        throw error
      }
    },
    presentCall: args => ({ card: 'generic', title: args.description, rawInput: args }),
  }))
}
