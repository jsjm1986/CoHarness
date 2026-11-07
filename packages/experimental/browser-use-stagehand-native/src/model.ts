/** Host-owned Stagehand inference uses normal LLM admission, policy, metering, and durable inputs. */

import { ClientLLMSchema } from '@browserbasehq/stagehand'
import type { ClientLLM } from '@browserbasehq/stagehand'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { admitEncodedImages } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { BlockAssembler, LlmError, ToolCallId, createAssistantMessage, createToolResultMessage, deepFreeze } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session/types'
import { z } from 'zod'
import type { StagehandModelConfig } from './native.ts'

type Input = Parameters<ClientLLM['generate']>[0]
type Output = Awaited<ReturnType<ClientLLM['generate']>>
type InputBlock = Extract<Input['messages'][number]['content'], { type: string }>

/** One Worker inference request, canceled and attributed by its current tool operation. */
export type StagehandModelHandler = (input: unknown, signal: AbortSignal) => Promise<unknown>

/** Exact provider-neutral input recorded before each Stagehand model dispatch. */
export interface StagehandLlmRequestEventData {
  /** Complete request except runtime-only ownership and cancellation. */
  readonly request: Omit<GenerateOptions, 'signal' | 'sessionId' | 'resourceOrigin' | 'purpose' | 'toolHistory'>
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Log-only input for an individually admitted browser-model request. */
    'browser-use/stagehand-llm-request': StagehandLlmRequestEventData
  }
}

/**
 * Execute a validated SDK model request through the registered host model route.
 * JSON Schema and required-tool selection use logged instructions plus strict result validation.
 * @param agent - exact live owner; its execution context is supplied by the current Worker operation.
 * @param route - independent browser-model route and optional output cap.
 * @param raw - untrusted SDK request received from the Worker.
 * @param signal - current operation, Worker lifetime, and model-capacity cancellation.
 * @returns validated SDK text/tool or structured output, with measured usage when available.
 */
export async function generateStagehandModel(
  agent: Agent, route: StagehandModelConfig, raw: unknown, signal: AbortSignal,
): Promise<unknown> {
  const ctx = agent.ctx
  const generate = ClientLLMSchema.shape.generate.implementAsync(async (input): Promise<Output> => {
    signal.throwIfAborted()
    if (ctx.agents.get(agent.id) !== agent) throw new Error('Stagehand model requests require their exact live Agent')
    const messages = await projectMessages(ctx, route, input, signal)
    const format = input.responseFormat
    const schema = format?.type === 'json_schema'
      ? z.fromJSONSchema(z.union([z.boolean(), z.record(z.string(), z.json())]).parse(format.schema)) : undefined
    const toolChoice = 'toolChoice' in input ? input.toolChoice?.mode : undefined
    const declaredTools = 'tools' in input ? input.tools ?? [] : []
    if (toolChoice === 'required' && declaredTools.length === 0) throw new Error('Stagehand required-tool generation has no tools')
    const instructions = [
      ...input.systemPrompt === undefined ? [] : [input.systemPrompt],
      ...format?.type !== 'json_schema' ? [] : [
        `Return only a JSON value matching this JSON Schema (${format.name}): ${JSON.stringify(format.schema)}.`,
        ...format.description === undefined ? [] : [format.description],
      ],
      ...toolChoice !== 'required' ? [] : ['Respond with at least one call to a declared tool.'],
    ]
    const call = await ctx.llm.prepareCall({
      ...route,
      ...input.temperature === undefined ? {} : { temperature: input.temperature },
      ...input.stopSequences === undefined ? {} : { stop: input.stopSequences },
    }, signal)
    const request: StagehandLlmRequestEventData['request'] = deepFreeze({
      ...call.config, messages,
      ...instructions.length === 0 ? {} : { system: instructions.join('\n\n') },
      ...toolChoice === 'none' || declaredTools.length === 0 ? {} : {
        tools: declaredTools.map(tool => ({ name: tool.name, description: tool.description ?? '', parameters: tool.inputSchema })),
      },
    })
    signal.throwIfAborted()
    agent.session.append('browser-use/stagehand-llm-request', { request })
    const assembler = new BlockAssembler()
    for await (const chunk of call.stream({ ...request, sessionId: agent.id, resourceOrigin: 'execution', signal })) {
      signal.throwIfAborted()
      assembler.push(chunk)
    }
    signal.throwIfAborted()
    const finish = assembler.finish
    if (finish.kind === 'error' || finish.kind === 'aborted') {
      throw new LlmError(finish.failure.message, finish.failure.code, finish.failure)
    }
    if (finish.kind === 'max-tokens') throw new LlmError('Stagehand model output exceeded its token limit', 'MAX_TOKENS')
    const content: Extract<Output['content'], unknown[]> = []
    const textParts: string[] = []
    for (const block of assembler.blocks()) {
      switch (block.type) {
        case 'reasoning': break
        case 'text': textParts.push(block.text); content.push({ type: 'text', text: block.text }); break
        case 'tool-call': {
          if (toolChoice === 'none' || schema !== undefined) throw new Error('Stagehand model returned a disallowed tool call')
          const tool = declaredTools.find(candidate => candidate.name === block.name)
          if (tool === undefined) throw new Error(`Stagehand model returned undeclared tool ${block.name}`)
          const input = z.record(z.string(), z.json()).parse(JSON.parse(block.arguments))
          z.fromJSONSchema(z.record(z.string(), z.json()).parse(tool.inputSchema)).parse(input)
          content.push({ type: 'tool_use', id: block.id, name: block.name, input })
          break
        }
        default: throw new Error(`Stagehand model cannot return content type ${block.type}`)
      }
    }
    if (toolChoice === 'required' && !content.some(block => block.type === 'tool_use')) {
      throw new Error('Stagehand model did not return the required tool call')
    }
    if (content.length === 0) throw new LlmError('Stagehand model returned no visible output', 'EMPTY_RESPONSE')
    const measured = assembler.usage
    const inputTokens = measured === undefined ? 0
      : measured.inputTokens + (measured.cacheReadTokens ?? 0) + (measured.cacheWriteTokens ?? 0)
    const usage = measured === undefined ? undefined : {
      inputTokens, outputTokens: measured.outputTokens,
      totalTokens: measured.totalTokens ?? inputTokens + measured.outputTokens,
      ...measured.cacheReadTokens === undefined ? {} : { cachedInputTokens: measured.cacheReadTokens },
      ...measured.reasoningTokens === undefined ? {} : { reasoningTokens: measured.reasoningTokens },
    }
    const result = { role: 'assistant' as const, content, stopReason: finish.kind, ...usage === undefined ? {} : { usage } }
    if (schema === undefined) return { ...result, outputFormat: 'text' }
    const structuredContent = z.json().parse(schema.parse(JSON.parse(textParts.join(''))))
    return { ...result, outputFormat: 'json_schema', structuredContent }
  })
  // The public SDK wrapper validates the Worker argument before entering the callback.
  return generate(raw as Input)
}

async function projectMessages(
  ctx: Context, route: StagehandModelConfig, input: Input, signal: AbortSignal,
): Promise<RequestMessage[]> {
  const messages: RequestMessage[] = []
  for (const message of input.messages) {
    signal.throwIfAborted()
    const raw = Array.isArray(message.content) ? message.content : [message.content]
    const images = raw.flatMap(block => block.type === 'image' ? [block]
      : block.type === 'tool_result' ? block.content.filter(part => part.type === 'image') : [])
    const attachments = ctx.get('attachments')
    if (images.length > 0 && attachments === undefined) throw new Error('Stagehand model image input requires an attachment store')
    const admitted = attachments === undefined || images.length === 0 ? [] : await admitEncodedImages(attachments, images.map(image => ({
      data: image.data, mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']).parse(image.mimeType),
    })))
    let imageIndex = 0
    const project = (block: Extract<InputBlock, { type: 'text' | 'image' }>): ContentBlock => {
      if (block.type === 'text') return { type: 'text', text: block.text }
      return { type: 'image', attachment: admitted[imageIndex++] as ImageAttachmentRef }
    }
    let content: ContentBlock[] = []
    const flush = () => {
      if (content.length === 0) return
      messages.push(message.role === 'assistant'
        ? createAssistantMessage({ content, source: { provider: route.provider, model: route.model } })
        : { role: 'user', content })
      content = []
    }
    for (const block of raw) {
      switch (block.type) {
        case 'text':
        case 'image': content.push(project(block)); break
        case 'tool_use':
          if (message.role !== 'assistant') throw new Error('Stagehand tool calls require an assistant message')
          content.push({ type: 'tool-call', id: ToolCallId(block.id), name: block.name, arguments: JSON.stringify(block.input) })
          break
        case 'tool_result': {
          if (message.role !== 'user') throw new Error('Stagehand tool results require a user message')
          flush()
          messages.push(createToolResultMessage({
            callId: ToolCallId(block.toolUseId), isError: block.isError ?? false,
            content: [
              ...block.content.map(project),
              ...block.structuredContent === undefined ? [] : [{ type: 'text' as const, text: JSON.stringify(block.structuredContent) }],
            ],
          }))
          break
        }
      }
    }
    flush()
  }
  return messages
}
