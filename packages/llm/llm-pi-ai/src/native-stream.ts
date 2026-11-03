/** Native Responses transport bound to a prepared pi-ai model and parent credentials. */
import type { Api, Model } from '@earendil-works/pi-ai'
import { createParser, type EventSourceMessage } from 'eventsource-parser'
import { attributionHeaders, LlmError, type LlmOperationFactories, type TokenUsage } from '@deepseek-ai/dsh-llm'
import { idleWatchdog } from '@deepseek-ai/dsh-timeout'
import type { PiAiAdapterOptions } from './adapter.ts'
import type { ResolvedPiAiProviderProfile } from './config.ts'

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function responseUsage(response: Record<string, unknown> | undefined): TokenUsage | undefined {
  const usage = object(response?.usage)
  if (!count(usage?.input_tokens) || !count(usage.output_tokens)) return undefined
  const cached = object(usage.input_tokens_details)?.cached_tokens
  const reasoning = object(usage.output_tokens_details)?.reasoning_tokens
  if (cached !== undefined && (!count(cached) || cached > usage.input_tokens)) return undefined
  if (reasoning !== undefined && (!count(reasoning) || reasoning > usage.output_tokens)) return undefined
  return {
    inputTokens: usage.input_tokens - (typeof cached === 'number' ? cached : 0),
    outputTokens: usage.output_tokens,
    totalTokens: usage.input_tokens + usage.output_tokens,
    ...cached === undefined ? {} : { cacheReadTokens: cached },
    ...reasoning === undefined ? {} : { reasoningTokens: reasoning },
  }
}

/**
 * Contribute native streaming only for API-key-authenticated Responses routes.
 * @param profile - frozen configuration retained during preparation.
 * @param model - exact registered model and wire protocol.
 * @param baseURL - endpoint selected by the owning adapter.
 * @param resolveApiKey - parent credential resolver, invoked only after admission.
 * @returns a native-stream factory, or absence for another wire protocol.
 */
export function nativeStreamOperations(
  profile: ResolvedPiAiProviderProfile,
  model: Model<Api>,
  baseURL: string,
  resolveApiKey: PiAiAdapterOptions['resolveApiKey'],
): LlmOperationFactories | undefined {
  if (model.api !== 'openai-responses') return undefined
  return {
    'native-stream': (parameters, config) => {
      if (parameters.protocol !== 'openai-responses') {
        throw new LlmError('This model does not support the requested native protocol.', 'MODEL_OPERATION_UNSUPPORTED')
      }
      if (profile.apiKeyEnv === undefined && profile.api === undefined) {
        throw new LlmError('Native streaming requires an explicit API-key reference or configured Responses route.',
          'MODEL_OPERATION_AUTH_UNSUPPORTED')
      }
      const body = {
        ...structuredClone(parameters.body), model: config.model, stream: true, store: false,
        ...config.maxTokens === undefined ? {} : { max_output_tokens: config.maxTokens },
        ...config.temperature === undefined ? {} : { temperature: config.temperature },
        ...config.reasoningEffort === undefined ? {} : {
          reasoning: { ...object(parameters.body.reasoning), effort: config.reasoningEffort },
        },
      }
      const endpoint = `${baseURL.replace(/\/+$/u, '')}/responses`
      return {
        request: { protocol: parameters.protocol, body },
        async run(options, observer) {
          const credential = await resolveApiKey(config.provider, profile)
          const key = typeof credential === 'object' ? credential.value : credential
          const source = typeof credential === 'object' ? credential.source : undefined
          const controller = new AbortController()
          const signal = options.signal === undefined ? controller.signal : AbortSignal.any([options.signal, controller.signal])
          using watchdog = idleWatchdog(signal, profile.streamIdleTimeoutMs, 'NATIVE_MODEL_STREAM_IDLE_TIMEOUT')
          let response: Response | undefined
          let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
          try {
            const headers = new Headers({ ...model.headers, ...profile.headers })
            if (key !== undefined) headers.set('authorization', `Bearer ${key}`)
            for (const [name, value] of Object.entries(attributionHeaders())) headers.set(name, value)
            headers.set('content-type', 'application/json')
            headers.set('accept', 'text/event-stream')
            if (options.sessionId !== undefined) headers.set('x-deepseek-harness-session-id', options.sessionId)
            const header = await watchdog.next<Response>({ next: async () => ({ done: false,
              value: await observer.dispatch(() => fetch(endpoint, {
                method: 'POST', redirect: 'error', signal: watchdog.signal,
                headers, body: JSON.stringify(body),
              })),
            }) })
            // This single-value iterator yields only the completed fetch result.
            response = header.value as Response
            if (!response.ok) throw new LlmError(`Native model request failed (HTTP ${response.status}).`,
              response.status === 401 || response.status === 403 ? 'AUTH' : response.status === 429 ? 'RATE_LIMIT' : 'SERVER')
            if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream') || response.body === null) {
              throw new LlmError('Native model response is not an event stream.', 'MALFORMED_RESPONSE')
            }
            const pending: (EventSourceMessage | LlmError)[] = []
            const parser = createParser({ maxBufferSize: parameters.maxResponseBytes,
              onEvent: (event) => { pending.push(event) },
              onError: (error) => { pending.push(new LlmError('Native model event framing is invalid.', 'MALFORMED_RESPONSE', { cause: error })) },
            })
            const decoder = new TextDecoder()
            const input = response.body.getReader()
            reader = input
            let bytes = 0
            let terminal = false
            while (!terminal) {
              const part = await watchdog.next<Uint8Array>({ next: () => input.read() })
              if (part.done) throw new LlmError('Native model stream ended before its terminal event.', 'STREAM_TRUNCATED')
              const accepted = part.value.subarray(0, parameters.maxResponseBytes - bytes)
              bytes += accepted.byteLength
              parser.feed(decoder.decode(accepted, { stream: true }))
              for (const frame of pending.splice(0)) {
                if (frame instanceof LlmError) throw frame
                let value: unknown
                try { value = JSON.parse(frame.data) } catch (cause) {
                  throw new LlmError('Native model event contains invalid JSON.', 'MALFORMED_RESPONSE', { cause })
                }
                const event = object(value)
                if (typeof event?.type !== 'string' || !/^[A-Za-z0-9_.-]+$/u.test(event.type)
                  || frame.event !== undefined && frame.event !== event.type) {
                  throw new LlmError('Native model event type is invalid.', 'MALFORMED_RESPONSE')
                }
                const usage = responseUsage(object(event.response))
                if (usage !== undefined) observer.usage(usage, source)
                if (event.type === 'error' || event.type === 'response.failed') {
                  throw new LlmError('Native model stream reported a failure.', 'SERVER')
                }
                await parameters.write({ event: event.type, data: frame.data })
                terminal = event.type === 'response.completed' || event.type === 'response.incomplete'
                if (terminal) break
              }
              if (!terminal && accepted.byteLength < part.value.byteLength) {
                throw new LlmError('Native model response exceeds its byte limit.', 'RESPONSE_TOO_LARGE')
              }
            }
          } finally {
            controller.abort()
            try {
              if (reader !== undefined) {
                try { await reader.cancel() } finally { reader.releaseLock() }
              } else if (response?.body !== null) await response?.body?.cancel()
            } catch (error) {
              // This owner aborts fetch before cancelling its already-aborted body.
              if (!(error instanceof Error && error.name === 'AbortError')) throw error
            }
          }
        },
      }
    },
  }
}
