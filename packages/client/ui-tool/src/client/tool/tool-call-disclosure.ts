/** Call-local disclosure binding for the atomic Tool slot. */
import { useSyncExternalStore } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { UseDisclosure } from '../contract/slots.ts'

/**
 * Bind one call's shared disclosure cell. Every row form of the same call (the
 * generic row and the question panel row) reads the cell the Tool tree owns,
 * so a form swap keeps the expanded state and a remounted call starts
 * collapsed.
 * @param cell - the call's disclosure cell from its Hook context.
 * @returns a Hook exposing this call's expanded state and its actions.
 */
export function bindToolCallDisclosure(cell: SnapshotStore<boolean>): UseDisclosure {
  const subscribe = (listener: () => void) => cell.subscribe(listener)
  const getSnapshot = () => cell.getSnapshot()
  return function useToolCallDisclosure(): ReturnType<UseDisclosure> {
    const expanded = useSyncExternalStore(subscribe, getSnapshot)
    return {
      expanded,
      setExpanded: (open) => { cell.set(open) },
      toggle: () => { cell.set(!cell.getSnapshot()) },
    }
  }
}
