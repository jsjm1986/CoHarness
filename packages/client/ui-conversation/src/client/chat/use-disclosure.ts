/** Disclosure state bound to a Chat seat's fold-generation reset source. */
import { useCallback, useState, useSyncExternalStore } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { UseDisclosure, UseDisclosureReset } from '../contract/slots.ts'

/**
 * Own one initially collapsed disclosure without an external subscription.
 * @param version - reset generation; unchanged generations retain local open state.
 * @returns the open state, an explicit setter, and a toggle action.
 */
export function useDisclosure(version = 0): ReturnType<UseDisclosure> {
  const [expandedVersion, setExpandedVersion] = useState<number | null>(null)
  const expanded = expandedVersion === version
  const setExpanded = useCallback((open: boolean) => {
    setExpandedVersion(open ? version : null)
  }, [version])
  const toggle = useCallback(() => {
    setExpandedVersion(previous => previous === version ? null : version)
  }, [version])
  return { expanded, setExpanded, toggle }
}

/**
 * Bind a Hook without subscribing until a component calls it.
 * @param reset - stable source whose version advances when the seat's process window folds.
 * @returns a Hook with independent open state for each invocation.
 */
export function bindDisclosure(reset: ObservableSnapshot<number>): UseDisclosure {
  const subscribe = (listener: () => void) => reset.subscribe(listener)
  const getSnapshot = () => reset.getSnapshot()
  return function useBoundDisclosure() {
    const version = useSyncExternalStore(subscribe, getSnapshot)
    return useDisclosure(version)
  }
}

/**
 * Bind a Hook exposing the seat's current fold generation.
 * @param reset - stable source whose version advances when the seat's process window folds.
 * @returns a Hook returning the live generation number.
 */
export function bindDisclosureReset(reset: ObservableSnapshot<number>): UseDisclosureReset {
  const subscribe = (listener: () => void) => reset.subscribe(listener)
  const getSnapshot = () => reset.getSnapshot()
  return function useBoundDisclosureReset() {
    return useSyncExternalStore(subscribe, getSnapshot)
  }
}
