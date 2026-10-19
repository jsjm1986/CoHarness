/** Call-local disclosure binding for the atomic Tool slot. */
import { useSyncExternalStore } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { UseDisclosure } from '../contract/slots.ts'

/**
 * Bind one call's shared disclosure cell. Every row form of the same call (the
 * generic row and the question panel row) reads the cell the Tool tree owns,
 * so a form swap keeps the expanded state and a remounted call starts
 * collapsed. The cell records the seat fold generation the call was expanded
 * under; once the seat's generation advances past it the record reads as
 * collapsed without unmounting the mounted call.
 * @param cell - the call's expansion record from its Hook context.
 * @param resetVersion - the seat's current fold generation.
 * @returns a Hook exposing this call's expanded state and its actions.
 */
export function bindToolCallDisclosure(
  cell: SnapshotStore<number | null>,
  resetVersion: number,
): UseDisclosure {
  const subscribe = (listener: () => void) => cell.subscribe(listener)
  const getSnapshot = () => cell.getSnapshot()
  return function useToolCallDisclosure(): ReturnType<UseDisclosure> {
    const expandedVersion = useSyncExternalStore(subscribe, getSnapshot)
    return {
      expanded: expandedVersion === resetVersion,
      setExpanded: (open) => { cell.set(open ? resetVersion : null) },
      toggle: () => { cell.set(cell.getSnapshot() === resetVersion ? null : resetVersion) },
    }
  }
}
