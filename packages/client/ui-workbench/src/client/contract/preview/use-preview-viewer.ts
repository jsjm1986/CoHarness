/** A mounted preview owns its selected viewer import independently of its authorized content read. */
import { lazy, useEffect, useMemo } from 'react'
import type { ComponentType, LazyExoticComponent } from 'react'

/**
 * Download the selected viewer alongside metadata and the authorized content read.
 * An import cannot be cancelled, but its completion mounts no content or Worker;
 * the caller renders the returned component only after its read succeeds.
 * @param load - stable loader for this preview's renderer, excluding all other document types.
 * @param ready - the selected preview is mounted and access has not been denied.
 * @returns a lazy component sharing this mounted preview's preload result, including import failures.
 */
export function usePreviewViewer<P extends object>(
  load: () => Promise<{ default: ComponentType<P> }>,
  ready: boolean,
): LazyExoticComponent<ComponentType<P>> {
  const viewer = useMemo(() => {
    let pending: Promise<{ default: ComponentType<P> }> | undefined
    const read = () => pending ??= load()
    return { Body: lazy(read), preload: read }
  }, [load])
  useEffect(() => {
    if (!ready) return
    void viewer.preload().catch(() => {
      // React's lazy component reports this same rejection if authorized bytes are rendered.
    })
  }, [viewer, ready])
  return viewer.Body
}
