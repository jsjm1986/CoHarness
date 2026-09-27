/** Composer submission vocabulary shared by the input and settings domains. */

import type { BusyEnterBehavior } from '../../submission-settings.ts'

export type { BusyEnterBehavior } from '../../submission-settings.ts'

/** Delivery mode requested for one ordinary composer message. */
export type InputSubmitMode = BusyEnterBehavior

/** Keyboard gesture whose delivery mode the submission policy resolves. */
export type ComposerSubmitGesture = 'enter' | 'accelerated'

/**
 * Resolve delivery for one composer gesture from the displayed preference.
 * @param busyEnter - current account preference for Enter and the Send button.
 * @param running - whether the addressed agent currently reports busy.
 * @param gesture - plain Enter or the Cmd/Ctrl-accelerated chord.
 * @param steeringAvailable - whether this session transport supports steering.
 * @returns Queue outside steer-capable busy state; otherwise the preferred mode or its opposite.
 */
export function resolveSubmitMode(
  busyEnter: BusyEnterBehavior,
  running: boolean,
  gesture: ComposerSubmitGesture,
  steeringAvailable: boolean,
): InputSubmitMode {
  if (!running || !steeringAvailable) return 'queue'
  return gesture === 'enter' ? busyEnter : busyEnter === 'queue' ? 'steer' : 'queue'
}
