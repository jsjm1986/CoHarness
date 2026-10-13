/** The workspace-file tab's chip: the file's type glyph and basename. */
import type { ReactNode } from 'react'
import { FileTypeIcon } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import css from './WorkspaceFileTitle.module.css'

/** The basename of a workspace path, on either separator. */
function basename(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}

/**
 * Render the path-classified glyph followed by the file's basename; the
 * registry's captured title is the resource's full path, which names the chip
 * only as a fallback for a nameless path.
 * @param props - the tab information hook.
 * @returns the chip's glyph and text.
 */
export function WorkspaceFileTitle({ useTabInfo }: PropsRuntime<'sidebar.right.pane.tab.title'>): ReactNode {
  const { tab } = useTabInfo()
  const name = basename(tab.title)
  return (
    <>
      <FileTypeIcon path={tab.title} size={14} className={css.titleIcon} />
      {name === '' ? tab.title : name}
    </>
  )
}
