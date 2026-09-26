// Read toolview registrant: the keyed toolview hole for the read tool. The row
// composes the shared read-family assembly and feeds it the file's
// line-numbered, syntax-highlighted content as ToolRow's `read` card material,
// so it renders through ReadBlock in the collapsed-by-default expanded body —
// the same unified interaction every other card row has. The summary path is
// an openable host link that lands on the line the call named. A running read
// (no result yet) and a non-read result render the summary row alone: the read
// intent is result-side only, so there is no running-state read card to draw.

import type { Context } from '@deepseek-ai/cordis'
import { readCallLine, readCardModel } from '../models/read-card-model.ts'
import { readFamilyRow, type ReadFamilyRowProps } from './read-family-row.tsx'
import { CONVERSATION_NS as NS } from '../../locale.ts'

/**
 * Read row: the read-family chrome with the file's read card as the row's
 * collapsed-by-default card body. The summary path is an openable host link
 * that lands on the read's own start line when the call named one.
 */
export function ReadRow(props: ReadFamilyRowProps) {
  const { block } = props
  return readFamilyRow(props, {
    read: readCardModel(block, props.cwd, props.home),
    filePathLine: readCallLine(block),
  })
}

/**
 * The read row as a plain registrant plugin following the atomic Tool-view
 * declaration across independent activation and reload lifetimes.
 */
export const readToolview = {
  name: 'read-toolview',
  inject: ['slots'],
  /**
   * Register the read row into the Tool-owned keyed view slot.
   * @param ctx - registrant context (disposal rides ctx.effect inside slots.register).
   */
  apply(ctx: Context): void {
    ctx.slots.inject('tool.call.toolview', () =>
      ctx.slots.register({ name: 'tool.call.toolview', key: 'read', locale: NS }, ReadRow))
  },
}
