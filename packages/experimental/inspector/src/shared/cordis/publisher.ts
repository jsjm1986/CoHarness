/** Shared Host/Client publication of browser-safe Cordis snapshots. */

import type { Context } from '@deepseek-ai/cordis'
import { CORDIS_TREE_TOPIC } from '../bridge/messages/cordis.ts'
import type { InspectorStatePublisher } from '../bridge/publisher.ts'
import { isJsonValue } from '../json.ts'
import type { CordisTreeLimits } from './collector.ts'
import { observeCordisTree } from './observer.ts'

/**
 * Observe one Cordis runtime and retain its latest source snapshot.
 * @param ctx - Plugin context whose root is inspected.
 * @param publisher - Active Host or Client source publisher.
 * @param limits - Snapshot node and encoded-byte limits.
 * @returns A disposer that stops observation and releases retained objects.
 */
export function publishCordisTree(
  ctx: Context,
  publisher: InspectorStatePublisher,
  limits: CordisTreeLimits,
): () => void {
  return observeCordisTree(ctx, (snapshot) => {
    // The collector model is serializable by construction; re-check before
    // it crosses into the retained-state wire contract.
    if (!isJsonValue(snapshot)) throw new Error('inspector: Cordis tree snapshot is not JSON')
    publisher.setState(CORDIS_TREE_TOPIC, snapshot)
  }, limits)
}
