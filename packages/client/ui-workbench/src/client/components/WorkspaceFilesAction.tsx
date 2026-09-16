/** Session-header Workspace files entry for the single-conversation surface. */
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconFolderOpenOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { NS } from '../locales.ts'
import css from './Workbench.module.css'

interface Props extends PropsRuntime<'conversation.session.header.utilities'>, PropsLocale<typeof NS> {
  /** Provider availability for this Session's runtime, evaluated at render time. */
  filesAvailable?: (() => boolean) | undefined
  /** Open the Workspace file browser bound to this Session and runtime target. */
  openFiles?: (() => void) | undefined
  /** Whether the viewport is showing the workbench grid, where the pane header carries this action. */
  inWorkbench?: (() => boolean) | undefined
}

/** Render the files button while the pane header does not already offer it. */
export function WorkspaceFilesAction({ filesAvailable, openFiles, inWorkbench, t }: Props) {
  if (inWorkbench?.() === true || filesAvailable?.() !== true || openFiles === undefined) return null
  return (
    <button
      type="button"
      className={css.iconAction}
      aria-label={t('files')}
      title={t('files')}
      onClick={() => { openFiles() }}
    >
      <IconFolderOpenOutline16 />
    </button>
  )
}
