/** Direct-fd CI diagnostic channel for Host and Worker teardown tracing. */

import { writeSync } from 'node:fs'

const enabled = process.env.DSH_INSPECTOR_DIAG === '1'
const t0 = Date.now()

/**
 * Write one timestamped diagnostic line straight to fd 2.
 * The synchronous write survives a blocked event loop and bypasses piped stdio,
 * so Worker output reaches the parent log even when the parent loop is frozen.
 * @param step - Teardown stage being entered or completed.
 */
export function diag(step: string): void {
  if (enabled) writeSync(2, `[diag] ${step} +${Date.now() - t0}ms\n`)
}
