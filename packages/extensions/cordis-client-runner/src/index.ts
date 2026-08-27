/**
 * Dynamic-package runner plugin, node half. Pure browser-side capability: the
 * empty apply exists so the row appears in the host cordis.yml / Loader, while
 * the browser half ships through exports["./client"], discovered from the
 * package.json dshClient declaration.
 */

import z from '@deepseek-ai/schemastery'

/** Configuration shared by the Host row and its browser half. */
export interface Config {
  /** Hard deadline for one dynamic browser-half evaluation and activation. */
  evaluationTimeoutMs?: number
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  evaluationTimeoutMs: z.number().step(1).min(1).default(5000),
})

/** Host plugin body — this package contributes nothing host-side. */
export function apply(): void {}
