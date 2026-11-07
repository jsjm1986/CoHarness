/** Browser bootstrap and DevTools source-selection exports for Host and Worker consumers. */

export {
  INSPECTOR_BOOTSTRAP_PATH, INSPECTOR_BOOTSTRAP_ROUTE, isInspectorClientOriginAllowed,
} from './client-bootstrap.ts'
export {
  INSPECTOR_CLIENT_QUERY, INSPECTOR_SOURCE_SCOPE_QUERY, isInspectorSourceSelected, readInspectorClientSelection,
} from './source-selection.ts'
export type { InspectorClientSelection } from './source-selection.ts'
