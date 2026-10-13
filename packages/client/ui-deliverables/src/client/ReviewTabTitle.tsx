/** The changes-review tab's chip: the review glyph and the captured title. */
import type { ReactNode } from 'react'
import { IconFilePenOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import css from './ReviewTabTitle.module.css'

/**
 * Render the file-pen glyph followed by the registry's captured title — the
 * localized "Turn N review" text the definition minted at open time.
 * @param props - the tab information hook.
 * @returns the chip's glyph and text.
 */
export function ReviewTabTitle({ useTabInfo }: PropsRuntime<'sidebar.right.pane.tab.title'>): ReactNode {
  const { tab } = useTabInfo()
  return (
    <>
      <IconFilePenOutline16 className={css.titleIcon} aria-hidden="true" />
      {tab.title}
    </>
  )
}
