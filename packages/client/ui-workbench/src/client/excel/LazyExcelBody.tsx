/** Load the spreadsheet renderer only when a supported workbook is opened. */
import { lazy, Suspense, type ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { excelFormat, type ExcelFormat } from './format.ts'
import type { ExcelLimits } from './model.ts'
import css from './LazyExcelBody.module.css'

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

const LoadedExcelBody = lazy(async () => ({ default: (await import('./excel.tsx')).ExcelBody }))

/**
 * Load the browser spreadsheet renderer for every registered format.
 * @param props - Complete file bytes, workspace path, limits, and locale.
 * @returns Localized loading state or Excel preview.
 */
export function LazyExcelBody(props: ExcelBodyProps): ReactNode {
  const format = excelFormat(props.path)
  const loading = <p className={css.loading} role="status">{props.t('loading')}</p>
  return <Suspense fallback={loading}>
    <LoadedExcelBody {...props} format={format} loading={loading} />
  </Suspense>
}
