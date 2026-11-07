/** Display metadata follows an exact execution Runtime and the current verified account. */
import type { SessionRuntimeTarget } from '@deepseek-ai/dsh-client-runtime/client'
import type { CollaborationSnapshot } from './collaboration-client.ts'

/**
 * Resolve a Runtime's physical computer without borrowing another selected environment.
 * @param runtime - addressed Session or explicitly selected Runtime.
 * @param state - current verified account and authorized directory metadata.
 * @returns its computer name, or undefined until that Runtime's location is known.
 */
export function runtimeComputerName(runtime: SessionRuntimeTarget | undefined, state: CollaborationSnapshot): string | undefined {
  if (!state.contextVerified || runtime === undefined) return undefined
  if (runtime.nodeName !== undefined) return runtime.nodeName
  if (runtime.runtimeId === undefined) return undefined
  const listed = [...(state.environments?.items ?? []), ...(state.preferredEnvironments ?? [])]
    .find(item => item.target.runtimeId === runtime.runtimeId)
  if (listed !== undefined) return listed.nodeName
  return runtime.runtimeId === state.context?.environment?.id ? state.context.environment.nodeName : undefined
}
