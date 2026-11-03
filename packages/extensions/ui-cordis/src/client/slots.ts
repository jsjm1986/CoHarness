/** Injected faces and the Package-owned `tool.view.cordis` slot declaration. */

import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { ConnectionRuntimeTarget } from '@deepseek-ai/dsh-client-connection/client'
import type { RuntimeEnvironments } from '@deepseek-ai/dsh-client-runtime/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  CordisRunActivity, CordisRunFailure, CordisUserRunRequest, DynamicCordisLivePackage,
  DynamicCordisRenderFailure, CordisPendingApproval,
} from '@deepseek-ai/dsh-cordis-client-runner/client'
import type { CordisActionResult } from './dynamic-port.ts'
import type { CordisInventory } from './inventory.ts'
import type { CordisRunCardPointer, CordisRunCardStore } from './run-card-index.ts'
import type {
  ApprovalRequestId, CordisDynamicPackageId, CordisDynamicPluginId, CordisDynamicPluginRunId,
} from './events.ts'

/** Owner currency delivered to a dynamic Package's business view. */
export interface CordisToolViewOwnerProps {
  readonly pluginId: CordisDynamicPluginId
  readonly packageId: CordisDynamicPackageId
  readonly pluginRunId: CordisDynamicPluginRunId
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * Interactive Package-owned region rendered inside the latest eligible
     * `cordis_run` card in the conversation flow. Use it for controls and other
     * UI the user can interact with. Dynamic Client code registers with
     * `key: 'self'`; the Guard binds that key to the current Plugin and Package.
     */
    'tool.view.cordis': {
      kind: 'keyed'
      scope: 'session'
      owner: CordisToolViewOwnerProps
    }
  }
}

/** Live facts used by the read-only Define card. */
export interface CordisCardFace {
  hooks: {
    inventory: CordisInventory
    loaded: HostObservable<readonly DynamicCordisLivePackage[]>
  }
}

/** Live facts used by the Run card and its business-view ownership index. */
export interface CordisRunCardFace extends CordisCardFace {
  /** Browser-only key prefix of the Runtime owning this card. */
  readonly viewPrefix: string
  hooks: CordisCardFace['hooks'] & {
    runCards: CordisRunCardStore
    activeRuns: HostObservable<ReadonlyMap<CordisDynamicPluginId, CordisRunActivity>>
  }
  /** Publish this successful result into the session's latest-card index. */
  onObserveRunCard(pointer: CordisRunCardPointer): void
}

/** Frame-wide panel state and lifecycle verbs. */
export interface CordisPanelRuntimeHooks {
  inventory: CordisInventory
  activeRuns: HostObservable<ReadonlyMap<CordisDynamicPluginId, CordisRunActivity>>
  runErrors: HostObservable<ReadonlyMap<CordisDynamicPluginId, CordisRunFailure>>
  renderFailures: HostObservable<ReadonlyMap<CordisDynamicPluginId, DynamicCordisRenderFailure>>
  loaded: HostObservable<readonly DynamicCordisLivePackage[]>
}

/** Actions captured to the Runtime shown when the panel opens. */
export interface CordisPanelActions {
  /** Page-local identity for retained version selections and pending actions. */
  readonly runtimeKey: string
  /** Captured allocation and retained computer label, independent of later conversation navigation. */
  readonly runtimeId?: ConnectionRuntimeTarget['runtimeId']
  readonly computerName?: string
  readonly onApprove: (requestId: ApprovalRequestId, approveFutureVersions: boolean) => Promise<void>
  readonly onDecline: (requestId: ApprovalRequestId) => Promise<void>
  readonly onRun: (request: CordisUserRunRequest) => Promise<void>
  readonly onStop: (sessionId: SessionId, pluginId: CordisDynamicPluginId) => Promise<CordisActionResult>
  readonly onRemove: (sessionId: SessionId, pluginId: CordisDynamicPluginId) => Promise<CordisActionResult>
  readonly onRefresh: () => void
}

/** Frame-wide notification source and Runtime-bound panel facts. */
export interface CordisPanelFace {
  hooks: {
    pendingApprovals: HostObservable<readonly CordisPendingApproval[]>
    runtimeEnvironments: HostObservable<RuntimeEnvironments>
  }
  keyedHooks: {
    inventory(key: string): CordisPanelRuntimeHooks['inventory']
    activeRuns(key: string): CordisPanelRuntimeHooks['activeRuns']
    runErrors(key: string): CordisPanelRuntimeHooks['runErrors']
    renderFailures(key: string): CordisPanelRuntimeHooks['renderFailures']
    loaded(key: string): CordisPanelRuntimeHooks['loaded']
  }
  actionsForSession(sessionId?: SessionId): CordisPanelActions
}
