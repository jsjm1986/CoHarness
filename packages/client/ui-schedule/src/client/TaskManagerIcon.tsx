/** Task-manager sidebar glyph and compact shell title. */
import { IconClockOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the clock glyph at the size the sidebar asks for; the sidebar owns
 * its accessible navigation label. The glyph is the row's direct icon child,
 * as on every other panel row: an inline wrapper makes it the baseline of a
 * line box inside the row's glyph slot, which lifts it above the label.
 * @param props - the sidebar's icon share: the requested edge and whether the panel is selected.
 * @returns decorative clock icon.
 */
export function TaskManagerIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <IconClockOutline16 size={size} />
}

/**
 * Render the task page's title in the compact shell.
 * @param props - framework runtime and task-manager locale.
 * @returns the localized task-manager title.
 */
export function TaskManagerTitle({ t }: PropsRuntime<'shell.mobile.header.title'> & PropsLocale<'schedule.manager'>) {
  return t('title')
}
