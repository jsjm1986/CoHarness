/** Derived observable sources for the row actions' injected hooks. */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/**
 * Project one observable into another, recomputing only when the source
 * snapshot changes identity, so consumers that select from the projection
 * (a Set lookup per row) never rebuild it per read.
 * @param source - the observable to project.
 * @param project - pure projection of one source snapshot.
 * @returns the projected observable, subscribing through the source.
 */
export function derive<S, T>(source: HostObservable<S>, project: (snapshot: S) => T): HostObservable<T> {
  let seen: S | undefined
  let value: T | undefined
  return {
    getSnapshot: () => {
      const snapshot = source.getSnapshot()
      if (value === undefined || snapshot !== seen) {
        seen = snapshot
        value = project(snapshot)
      }
      return value
    },
    subscribe: listener => source.subscribe(listener),
  }
}

/**
 * Project two observables into one, recomputing only when either source
 * snapshot changes identity — the same projection contract as {@link derive}
 * over a pair.
 * @param first - first observable.
 * @param second - second observable.
 * @param project - pure projection of both snapshots.
 * @returns the projected observable, subscribing through both sources.
 */
export function derivePair<A, B, T>(
  first: HostObservable<A>,
  second: HostObservable<B>,
  project: (firstSnapshot: A, secondSnapshot: B) => T,
): HostObservable<T> {
  let seenFirst: A | undefined
  let seenSecond: B | undefined
  let value: T | undefined
  return {
    getSnapshot: () => {
      const firstSnapshot = first.getSnapshot()
      const secondSnapshot = second.getSnapshot()
      if (value === undefined || firstSnapshot !== seenFirst || secondSnapshot !== seenSecond) {
        seenFirst = firstSnapshot
        seenSecond = secondSnapshot
        value = project(firstSnapshot, secondSnapshot)
      }
      return value
    },
    subscribe: (listener) => {
      const offFirst = first.subscribe(listener)
      const offSecond = second.subscribe(listener)
      return () => { offFirst(); offSecond() }
    },
  }
}
