/** Shared agent-loop scheduler defaults.
 * @module dsh-agent-loop/constants
 */

/** Default maximum in-flight parallel-safe calls per agent step. */
export const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10

/** Default maximum number of pending inbox messages per agent. */
export const DEFAULT_MAX_INBOX_MESSAGES = 10_000

/** Default UTF-8 byte budget for pending inbox messages per agent. */
export const DEFAULT_MAX_INBOX_BYTES = 16 * 1024 * 1024
