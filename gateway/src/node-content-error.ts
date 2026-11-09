/** A selected allocation cannot be serviced by a different or unavailable volume. */
export class NodeContentUnavailable extends Error {
  readonly code = 'node-content/unavailable'
  readonly status = 503
  constructor(message = 'The assigned node content volume is unavailable.') { super(message); this.name = 'NodeContentUnavailable' }
}
