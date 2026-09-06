/** Lossless-JSON validation and detached snapshots for durable session data. @module @deepseek-ai/dsh-session/json */

/** JSON values accepted by Session persistence. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

// The shared implementation lives in `dsh-util-values` so every package uses
// identical lossless rules while this local type remains part of the Session face.
export { isJsonValue, snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
