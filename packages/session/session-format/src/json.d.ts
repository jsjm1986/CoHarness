import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { SessionFormatArtifact, SessionFormatHeader } from './types.ts'
/** Require a non-negative safe integer. */
export declare function sessionFormatCount(value: unknown, label: string): number
/** Read and validate a version without inspecting body rows. */
export declare function inspectSessionFormatVersion(value: unknown): number
/** Snapshot an arbitrary value at the durable JSON boundary. */
export declare function snapshotSessionFormatJson(value: unknown, label?: string): JsonValue
/** Snapshot and validate one logical header. */
export declare function snapshotSessionFormatHeader(value: SessionFormatHeader, label?: string): SessionFormatHeader
/** Snapshot and validate one complete artifact's coordinates. */
export declare function snapshotSessionFormatArtifact(value: SessionFormatArtifact, label?: string): SessionFormatArtifact
//# sourceMappingURL=json.d.ts.map
