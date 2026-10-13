/** The tool-details tab's chip: the call's card-intent glyph and its resolved name. */
import type { ReactNode } from 'react'
import {
  IconBrowseOutline16, IconFilePenOutline16, IconGlobeOutline14, IconSearchOutline16, IconTerminalOutline16, IconWrenchOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { shallowEqual } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { parseToolAddress } from './address.ts'
import { toolCallPresentation } from './name.ts'
import css from './ToolDetailsTitle.module.css'

/**
 * The glyph naming the card the details body renders for the call: the
 * terminal card's prompt, the diff card's edited file, the search, read, and
 * web cards' own marks, and the wrench for the generic body or an unresolved
 * call.
 * @param card - the call's render intent, `undefined` while unknown.
 * @returns the chip's leading glyph.
 */
function CallGlyph({ card }: { readonly card: string | undefined }): ReactNode {
  switch (card) {
    case 'terminal': return <IconTerminalOutline16 className={css.titleIcon} aria-hidden="true" />
    case 'diff': return <IconFilePenOutline16 className={css.titleIcon} aria-hidden="true" />
    case 'search': return <IconSearchOutline16 className={css.titleIcon} aria-hidden="true" />
    case 'read': return <IconBrowseOutline16 className={css.titleIcon} aria-hidden="true" />
    case 'web': return <IconGlobeOutline14 className={css.titleIcon} aria-hidden="true" />
    default: return <IconWrenchOutline16 className={css.titleIcon} aria-hidden="true" />
  }
}

/**
 * Render the call's intent glyph followed by its wire name, live while the
 * call stays inside the Session's loaded window. The tab's recorded title —
 * the call id the registry captured at open time — remains the chip's text
 * for a call outside the window, including a restored tab.
 * @param props - Session snapshot hook and tab information.
 * @returns the chip's glyph and text.
 */
export function ToolDetailsTitle({ useSession, useTabInfo }: PropsRuntime<'sidebar.right.pane.tab.title'>): ReactNode {
  const { tab } = useTabInfo()
  const callId = parseToolAddress(tab.navigation.address)?.callId
  // A fresh {name, card} per commit: member-wise equality keeps a same-named
  // call's settling from repainting the chip.
  const call = useSession(
    snapshot => (callId === undefined ? undefined : toolCallPresentation(snapshot, callId)),
    shallowEqual,
  )
  return (
    <>
      <CallGlyph card={call?.card} />
      {call?.name ?? tab.title}
    </>
  )
}
