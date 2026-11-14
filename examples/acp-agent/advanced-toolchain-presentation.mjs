/** Select PTC for the parent program, then restore native calls before child creation. */
import * as PtcToolExecutor from '@deepseek-ai/dsh-tool-executor-ptc'

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
      selections.get(exec.agent)?.()
      selections.set(exec.agent, null)
    }
  })
}
