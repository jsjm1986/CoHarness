/** Browser bootstrap values shared by Client plugin and assembled panel fixtures. */

import type { InspectorClientBootstrap } from '../../src/shared/bridge/messages/control.ts'

/** A valid loopback bootstrap with short fixture reconnect and query deadlines. */
export const bootstrap: InspectorClientBootstrap = {
  endpoint: 'ws://127.0.0.1:9230/ingest',
  protocol: 'dsh-inspector-v0-token',
  clientOrigins: [],
  maxQueuedRecords: 16,
  maxQueuedBytes: 16_384,
  maxRecordsPerFrame: 8,
  maxFrameBytes: 32_768,
  reconnectBaseMs: 10,
  reconnectMaxMs: 20,
  queryTimeoutMs: 100,
  maxRuntimeObjectsPerSession: 100,
  maxRuntimePropertiesPerResult: 100,
  maxClientSourceBytes: 1_048_576,
  maxCordisNodes: 100,
}
