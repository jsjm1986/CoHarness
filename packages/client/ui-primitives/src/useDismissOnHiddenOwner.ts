/** Dismiss floating controls whose owning region has become hidden. */
import { useEffect, type RefObject } from 'react'

/**
 * Keep a portaled popover from outliving its visible trigger region.
 * @param root - trigger wrapper, retained while its containing region is hidden.
 * @param open - whether the popover is currently mounted.
 * @param dismiss - close the popover without moving focus to its hidden trigger.
 */
export function useDismissOnHiddenOwner(root: RefObject<HTMLElement | null>, open: boolean, dismiss: () => void): void {
  useEffect(() => {
    const anchor = root.current
    if (!open || anchor === null) return
    const check = (): void => { if (anchor.closest('[hidden]') !== null) dismiss() }
    const observer = new MutationObserver(check)
    for (let owner: HTMLElement | null = anchor; owner !== null; owner = owner.parentElement) {
      observer.observe(owner, { attributes: true, attributeFilter: ['hidden'] })
    }
    check()
    return () => { observer.disconnect() }
  }, [root, open, dismiss])
}
