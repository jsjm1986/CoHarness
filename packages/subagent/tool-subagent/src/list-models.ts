/** Model-facing discovery of LLM routes available to child Agents. */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ModelSelectionPolicy } from './model-selection.ts'

interface ListSubagentModelsRequest { readonly provider?: string; readonly model?: string }

function modelLine(provider: string, model: { id: string; name: string; description?: string }): string {
  return `${provider}/${model.id} — ${model.name}${model.description === undefined ? '' : `: ${model.description}`}`
}

async function listSubagentModels(
  ctx: Context,
  policy: ModelSelectionPolicy,
  request: ListSubagentModelsRequest,
  signal: AbortSignal,
): Promise<string> {
  const llm = ctx.get('llm')
  if (llm === undefined) throw new Error('cannot discover child LLM routes because the `llm` service is unavailable')
  if (request.model !== undefined && request.provider === undefined) throw new Error('`model` requires `provider`')
  if (request.provider === undefined) {
    const providers = llm.listProviders().filter(provider => policy.routes.some(route => route.provider === provider.id))
    return providers.length === 0 ? '(no LLM providers)' : providers.map(provider => `${provider.id} — ${provider.name}`).join('\n')
  }
  if (request.provider.length === 0) throw new Error('`provider` must be non-empty')
  const allowed = policy.routes.filter(route => route.provider === request.provider)
  if (allowed.length === 0) throw new Error(`LLM provider "${request.provider}" is not allowed for this Session`)
  if (request.model === undefined) {
    const models = (await llm.listModels(request.provider)).filter(model => allowed.some(route => route.model === model.id))
    const provider = request.provider
    return models.length === 0
      ? `(no advertised models for ${provider})`
      : models.map(model => modelLine(provider, model)).join('\n')
  }
  if (request.model.length === 0) throw new Error('`model` must be non-empty')
  if (!allowed.some(route => route.model === request.model)) throw new Error(`child LLM route "${request.provider}/${request.model}" is not allowed for this Session`)
  const model = await llm.resolveModelInfo(request.provider, request.model, signal)
  const efforts = model.reasoning?.efforts.map(effort => `${effort.id}${model.reasoning?.defaultEffort === effort.id ? ' (default)' : ''} — ${effort.name}`).join('\n') || '(no advertised reasoning efforts)'
  return `${modelLine(request.provider, model)}\nReasoning efforts:\n${efforts}`
}

/** Register the model discovery tool for one policy-carrying delegation scope. */
export function registerListSubagentModels(ctx: Context, policy: ModelSelectionPolicy): void {
  ctx.tools.register(defineTool({
    name: 'list_subagent_models',
    description: 'Discover allowed LLM routes for subagents. Call with no arguments for providers, with provider for models, or with provider and model for reasoning efforts.',
    parameters: {
      provider: { type: 'string', description: 'Allowed provider id; omit to list providers.' },
      model: { type: 'string', description: 'Exact model id; requires provider.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: (args, exec) => listSubagentModels(ctx, policy, args, exec.signal),
  }))
}
