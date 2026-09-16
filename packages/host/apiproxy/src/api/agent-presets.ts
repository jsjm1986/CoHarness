/**
 * agent-presets domain contract. Roster, selection, reads, copies, and
 * deletes ride the generated `agentPresets` Remote surface; the native
 * directory hand-off stays here because it carries a platform-open result,
 * not a preset fact.
 */

import type { RpcRequest, RpcResponse } from './rpc.ts'

/** agent-preset-domain unary methods (the map key agentPreset.* of RpcMethodMap). */
export interface AgentPresetsApi {
  /**
   * Hand one locally authored preset's DIRECTORY to the platform opener, for
   * editing the files that are now the only composition editor. The request
   * carries an id, never a path — the Host resolves it — so no browser
   * payload can select an arbitrary filesystem target. Where the deployment
   * has no native opener (`canOpenPath: false` on `host.describe`), the reply
   * carries the resolved directory for the surface to show as text instead.
   * Shipped presets are refused: their install is not the user's to manage.
   */
  openDocument(request: RpcRequest<{ agentPreset: string }>, signal: AbortSignal):
  Promise<RpcResponse<{ opened: true } | { opened: false; path: string }>>
}
