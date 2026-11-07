/** Spreadsheet viewer inputs and its package-local dynamic loader. */
import type { ComponentType, ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ExcelFormat } from './format.ts'
import type { ExcelLimits } from './model.ts'

/** Spreadsheet input: complete authorized bytes, parser limits, and localized copy. */
export type ExcelBodyProps = PropsLocale<'sidebarExcel'> & {
  /** Complete file bytes borrowed for parser input; the preview copies before transfer. */
  readonly data: Uint8Array<ArrayBuffer>
  /** Decoded workspace-relative filename selecting the parser. */
  readonly path: string
  /** File, matrix, and elapsed-time limits. */
  readonly limits: ExcelLimits
}

/** Lazily loaded renderer input with the parser choice and main-bundle loading content. */
export type LoadedExcelBodyProps = ExcelBodyProps & { readonly format: ExcelFormat; readonly loading: ReactNode }

/**
 * Load the spreadsheet renderer without starting a parser or mounting a workbook.
 * @returns the component for an authorized, mounted preview.
 */
export async function loadExcelBody(): Promise<{ default: ComponentType<LoadedExcelBodyProps> }> {
  return { default: (await import('./excel.tsx')).ExcelBody }
}
