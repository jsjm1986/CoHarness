/**
 * Read-only Host and Client runtime API and session-owned package inspection.
 * @module @deepseek-ai/dsh-tool-cordis
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import {
  CordisDynamicPackageId, CordisDynamicPluginId,
} from '@deepseek-ai/dsh-cordis-host-runner'
import type { DynamicCordisReference } from '@deepseek-ai/dsh-cordis-host-runner'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { missingServices, providedServices } from './inspect.ts'
import {
  presentInspectListCall, presentInspectQueryCall, presentInspectSelfCall,
} from './present.ts'
import { CORDIS_SYSTEM_PROMPT } from './prompt.ts'
import { hostInspectProviders } from './providers.ts'

export const name = 'tool-cordis'
export const inject = ['tools', 'systemPrompt', 'dynamicCordisRunner', 'cordisInspect']

function requireAgent(exec: ToolExecution): Agent {
  if (exec.agent === undefined) throw new Error('Cordis inspection requires an Agent-backed session')
  return exec.agent
}

/** Register read-only Cordis tools and explicit `@pluginId` inspection context.
 * @param ctx - Agent-scoped registration context.
 */
export function apply(ctx: Context): void {
  ctx.systemPrompt.section({ name: 'tool:cordis', order: ctx.systemPrompt.getSectionOrder('TOOL_CORDIS'), text: CORDIS_SYSTEM_PROMPT })
  for (const provider of hostInspectProviders(ctx)) {
    ctx.effect(() => ctx.cordisInspect.register(provider), `tool-cordis: inspect ${provider.manifest.id}`)
  }

  ctx.tools.register(defineTool({
    name: 'cordis_inspect_list',
    description:
      'List every Cordis Inspect Provider currently known to the Host, including local Host Providers and the latest '
      + 'manifests synchronized from the Client. Each entry includes its platform, purpose, read-only methods, and '
      + 'input/output schemas. Call this Tool before writing or configuring a plugin, then select the provider and '
      + 'method for cordis_inspect_query from its result. Do not guess names or treat an Inspect method as a business '
      + 'Service that Plugin code can call.',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute(_args, _exec): Promise<JsonValue> {
      return Promise.resolve({ providers: ctx.cordisInspect.list() } as unknown as JsonValue)
    },
    presentCall: presentInspectListCall,
  }))

  ctx.tools.register(defineTool({
    name: 'cordis_inspect_query',
    description:
      'Run a read-only query explicitly declared by an Inspect Provider. platform, provider, and method must come '
      + 'from cordis_inspect_list, and input must satisfy that method\'s schema. Use this Tool before writing plugin code '
      + 'to read exact Service methods, Event modes, Builtin signatures, Tool schemas, theme tokens, or live Slot '
      + 'trees and props. Host queries run locally. A Client query waits for the first valid page response and '
      + 'remains pending until a page answers or the Tool is cancelled. This Tool cannot invoke business Service '
      + 'methods or modify the runtime. For Service.listService and Event.listEvents, query without input to navigate '
      + 'the compact signature directory, then query the exact service or event for its structured contract and '
      + 'referenced types. For Slots.listSubTree, query without root to navigate the compact tree, then query the '
      + 'exact root for its complete registration contract and props.',
    parameters: {
      platform: { type: 'string', required: true, enum: ['host', 'client'], description: 'Runtime platform that owns the Provider.' },
      provider: { type: 'string', required: true, description: 'Exact Provider ID returned by cordis_inspect_list.' },
      method: { type: 'string', required: true, description: 'Exact method name declared by the Provider manifest.' },
      input: { type: 'json', description: 'Optional query input; it must satisfy the method input schema.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const data = await ctx.cordisInspect.query(
        args.platform,
        args.provider,
        args.method,
        args.input,
        requireAgent(exec),
        exec.signal,
      )
      return { platform: args.platform, provider: args.provider, method: args.method, data }
    },
    presentCall: presentInspectQueryCall,
  }))

  ctx.tools.register(defineTool({
    name: 'cordis_inspect_self',
    description:
      'Inspect dynamic Cordis objects owned by the current Session at increasing levels of detail. With no IDs, '
      + 'list only Plugin summaries. With pluginId alone, return version pointers, the latest Run, and every Package '
      + 'summary. Only pluginId plus packageId returns that immutable Package\'s Host/Client source and runtime '
      + 'diagnostics. packageId cannot be supplied alone. Query an exact Package before handling @pluginId, repairing '
      + 'a recorded runtime failure. This Tool is read-only: it neither executes code '
      + 'nor changes version pointers.',
    parameters: {
      pluginId: { type: 'string', description: 'Existing session-owned Plugin ID or an explicit @pluginId reference; omit it to list every current Plugin.' },
      packageId: { type: 'string', description: 'Exact immutable Package ID owned by pluginId; when specified, source and diagnostics are returned.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute(args, exec): Promise<JsonValue> {
      const agent = requireAgent(exec)
      if (args.packageId !== undefined && args.pluginId === undefined) {
        throw new Error('cordis_inspect_self packageId requires pluginId')
      }
      if (args.pluginId === undefined) {
        return Promise.resolve({
          mode: 'plugins',
          plugins: ctx.dynamicCordisRunner.listPlugins(agent).map(reference => selfSummary(reference)),
        } as unknown as JsonValue)
      }
      const pluginId = CordisDynamicPluginId(args.pluginId)
      if (args.packageId === undefined) {
        const plugin = ctx.dynamicCordisRunner.inspectPlugin(agent, pluginId)
        return Promise.resolve({
          mode: 'plugin',
          ...selfSummary(plugin),
          packages: plugin.packages.map(pkg => ({
            ...pkg,
            packageId: String(pkg.packageId),
            isCurrent: pkg.packageId === plugin.currentPackageId,
            isNext: pkg.packageId === plugin.nextPackageId,
          })),
        } as unknown as JsonValue)
      }
      return Promise.resolve(inspectSelfPackage(
        ctx,
        agent,
        pluginId,
        CordisDynamicPackageId(args.packageId),
      ) as unknown as JsonValue)
    },
    presentCall: presentInspectSelfCall,
  }))

  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const ids = referencedPluginIds(messages)
    if (ids.length === 0) return decision
    signal.throwIfAborted()
    const contexts = ids.map((id) => {
      const reference = ctx.dynamicCordisRunner.reference(agent, CordisDynamicPluginId(id))
      return createUserMessage({
        content: [{
          type: 'text',
          text: reference === undefined ? renderUnavailableReference(id) : renderReference(reference),
        }],
        source: { kind: 'plugin', plugin: name, form: 'instructions' },
      })
    })
    return { kind: 'enter', messages: [...decision.messages, ...contexts] }
  })
}

type SelfState = 'defined' | 'awaiting-approval' | 'client-pending' | 'stopped' | 'running' | 'waiting' | 'failed'

function selfSummary(reference: DynamicCordisReference & { packages?: readonly unknown[] }): Record<string, JsonValue> {
  const latest = reference.latestRun
  const state = selfState(reference)
  return {
    pluginId: String(reference.pluginId),
    name: reference.name,
    packageCount: reference.packages?.length ?? 1,
    state,
    ...reference.currentPackageId === undefined ? {} : { currentPackageId: String(reference.currentPackageId) },
    ...reference.nextPackageId === undefined ? {} : { nextPackageId: String(reference.nextPackageId) },
    ...reference.activeRun === undefined ? {} : {
      activeRun: {
        pluginRunId: String(reference.activeRun.pluginRunId),
        packageId: String(reference.activeRun.packageId),
      },
    },
    ...latest?.status !== 'awaiting-approval' ? {} : {
      pendingApproval: {
        pluginRunId: String(latest.pluginRunId),
        packageId: String(latest.packageId),
        mode: latest.mode,
      },
    },
  }
}

function selfState(reference: DynamicCordisReference): SelfState {
  const status = reference.latestRun?.status
  if (status === 'awaiting-approval') return 'awaiting-approval'
  if (status === 'client-pending' || status === 'starting-host') return 'client-pending'
  if (status === 'failed' || status === 'rejected' || status === 'cancelled') return 'failed'
  if (status === 'waiting') return 'waiting'
  if (status === 'running') return 'running'
  if (reference.activeRun !== undefined) return 'running'
  return reference.currentPackageId === undefined ? 'defined' : 'stopped'
}

function inspectSelfPackage(
  ctx: Context,
  agent: Agent,
  pluginId: ReturnType<typeof CordisDynamicPluginId>,
  packageId: ReturnType<typeof CordisDynamicPackageId>,
): Record<string, JsonValue> {
  const inspected = ctx.dynamicCordisRunner.inspectPackage(agent, pluginId, packageId)
  const row = ctx.dynamicCordisRunner.snapshot(agent).find(candidate => candidate.pluginId === pluginId)
  const pkg = row?.packages.find(candidate => candidate.packageId === packageId)
  const active = row?.activeRun?.packageId === packageId ? row.activeRun : undefined
  const latest = inspected.latestRun?.packageId === packageId ? inspected.latestRun : undefined
  const hostWaiting = active?.fiber === undefined ? [...(latest?.host.waitingFor ?? [])] : missingServices(ctx, active.fiber)
  const hostStatus = pkg?.hasHostHalf !== true
    ? 'absent'
    : latest?.host.status ?? (active === undefined ? 'stopped' : hostWaiting.length === 0 ? 'running' : 'waiting')
  const clientStatus = pkg?.hasClientHalf !== true
    ? 'absent'
    : latest?.client.status ?? 'stopped'
  return {
    mode: 'package',
    plugin: selfSummary(inspected),
    packageId: String(packageId),
    name: inspected.name,
    purpose: inspected.purpose,
    code: inspected.code,
    runtime: {
      state: selfState(inspected),
      host: {
        status: hostStatus,
        provides: active?.fiber === undefined ? [] : providedServices(ctx, active.fiber),
        waitingFor: hostWaiting,
        handlers: active?.handlers ?? [],
        ...latest?.host.error === undefined ? {} : { error: latest.host.error },
      },
      client: {
        status: clientStatus,
        waitingFor: [...(latest?.client.waitingFor ?? [])],
        ...latest?.client.error === undefined ? {} : { error: latest.client.error },
        ...active?.renderFailure === undefined ? {} : { renderFailure: active.renderFailure },
      },
    },
  } as unknown as Record<string, JsonValue>
}

function referencedPluginIds(messages: readonly UserMessage[]): string[] {
  const found = new Set<string>()
  const pattern = /(?:^|\s)@([a-z]{3,6}-\d+)(?=\s|$)/g
  for (const message of messages) {
    if (message.source.kind !== 'user') continue
    const text = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    for (const match of text.matchAll(pattern)) if (match[1] !== undefined) found.add(match[1])
  }
  return [...found]
}

function renderReference(reference: ReturnType<Context['dynamicCordisRunner']['reference']> & {}): string {
  return [
    '<cordis_dynamic_plugin_context>',
    JSON.stringify(reference, null, 2),
    '',
    `The user explicitly referenced @${reference.pluginId}. Package ${reference.packageId} identifies its current inspection target.`,
    `Call cordis_inspect_self with pluginId="${reference.pluginId}" and packageId="${reference.packageId}" to read the exact metadata and source.`,
    'Inspection cannot change or activate this definition. For a requested persistent change, use the installed Plugin development workflow.',
    '</cordis_dynamic_plugin_context>',
  ].join('\n')
}

function renderUnavailableReference(id: string): string {
  return [
    '<cordis_dynamic_plugin_context>',
    `The user explicitly referenced @${id}, but this Plugin is unavailable in the current Session.`,
    'It may have been removed, belong to another Session, or have been lost when the DSH process restarted.',
    'Do not claim that it was updated or silently create a replacement Plugin. Tell the user that the reference is currently unavailable.',
    '</cordis_dynamic_plugin_context>',
  ].join('\n')
}
