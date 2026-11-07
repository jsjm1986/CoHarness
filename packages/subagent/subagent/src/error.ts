/**
 * Typed failures shared by subagent service and provider operations.
 *
 * @module @deepseek-ai/dsh-subagent
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Typed failure for the subagent seam. */
export class SubagentError extends HarnessError {
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'SubagentError'
  }
}

/**
 * Render provider and listener failures without interrupting their cleanup.
 * @param value - thrown or rejected failure value.
 * @returns error name and message, ordinary value text, or a fixed conversion-failure label.
 */
export function renderSubagentFailure(value: unknown): string {
  try {
    return value instanceof Error ? `${value.name}: ${value.message}` : String(value)
  } catch {
    return '<unrenderable thrown value>'
  }
}
