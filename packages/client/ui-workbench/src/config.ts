/** Deployment limits shared by the Host configuration and browser spreadsheet previews. */
import z from '@deepseek-ai/schemastery'

/** Spreadsheet parser limits applied before allocating FortuneSheet's dense cell matrices. */
export interface Config {
  /** Browser spreadsheet parser and matrix allocation limits. */
  excel: {
    /** Maximum source file bytes. */
    maxBytes: number
    /** Maximum combined rectangular cell area across worksheets. */
    maxCells: number
    /** Maximum parser Worker lifetime in milliseconds. */
    timeoutMs: number
  }
}

/** Validated deployment limits applied before spreadsheet preview registration. */
export const Config: z<{ excel?: Partial<Config['excel']> }, Config> = z.object({
  excel: z.object({
    maxBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(16 * 1024 * 1024),
    maxCells: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(250_000),
    timeoutMs: z.natural().min(1).max(2_147_483_647).default(15_000),
  }),
})
