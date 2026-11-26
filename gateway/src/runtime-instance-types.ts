/** Runtime launch coordinates shared by lifecycle code and diagnostics. */
import type { RuntimeId } from './runtime-catalog.ts'

/** Runtime ownership; omission of the exact identity requires an unambiguous local assignment. */
export type RuntimeTarget = ({ kind: 'user'; id: number } | { kind: 'project'; id: number }) & { runtimeId?: RuntimeId }

/** Explicit starts require an authenticated user action at the owning HTTP route. */
export type RuntimeStartIntent = 'passive' | 'explicit' | 'webhook'
