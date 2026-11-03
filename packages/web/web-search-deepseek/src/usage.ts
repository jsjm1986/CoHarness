/** Validate native Messages token counters before reporting model usage. */
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { modelSearchUsage } from '@deepseek-ai/dsh-web'

/**
 * Read complete input/output counters without inventing missing usage or cache counts.
 * @param value - untrusted native response usage field.
 * @returns validated provider counts, or undefined when usage is absent.
 * @throws WebError when present usage is incomplete or invalid.
 */
export function nativeSearchUsage(value: unknown): TokenUsage | undefined {
  return modelSearchUsage(value, { inputTokens: 'input_tokens', outputTokens: 'output_tokens',
    cacheReadTokens: 'cache_read_input_tokens', cacheWriteTokens: 'cache_creation_input_tokens' }, 'DeepSeek search')
}
