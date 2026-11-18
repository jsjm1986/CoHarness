/** Select PTC for the parent program, then restore native calls before child creation. */
import * as PtcToolExecutor from '@deepseek-ai/dsh-tool-executor-ptc'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'

export const name = 'advanced-toolchain-presentation'
export const inject = ['tools']

export function apply(ctx) {
  const selections = new WeakMap()
  ctx.on('tools/result', (exec, result) => {
    if (exec.agent === undefined || exec.parent !== undefined || result.error !== undefined) return
    if (exec.name === 'cordis_inspect_list' && !selections.has(exec.agent)) {
      const fiber = exec.agent.ctx.plugin(PtcToolExecutor)
      selections.set(exec.agent, () => { void fiber.dispose() })
    } else if (exec.name === 'run_code') {
      const restore = selections.get(exec.agent)
      if (typeof restore !== 'function') return
      restore()
      // Disposing the scoped PTC selection leaves an unavailable tombstone
      // rather than falling through to the deployment default, so remount
      // the native executor at the same agent scope for the calls that follow.
      const fiber = exec.agent.ctx.plugin(NativeToolExecutor)
      selections.set(exec.agent, () => { void fiber.dispose() })
    }
  })
}
