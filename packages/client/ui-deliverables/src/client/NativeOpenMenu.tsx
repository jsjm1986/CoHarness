/** The native-open chooser shared by delivery cards and the change review: default app, registered handlers, file-manager reveal. */
import { useState } from 'react'
import type { ReactNode } from 'react'
import {
  Menu, IconFolderOpenOutline16, IconRightUpOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { PresentedAction, PresentedHost } from '../presented.ts'
import type { PresentedAppState } from './present-open.ts'
import type { NS } from './locales.ts'
import css from './Deliverables.module.css'

/** One application image with a per-image fallback to the generic opener glyph. */
function ApplicationIcon({ source }: { source: string | null }): ReactNode {
  const [failed, setFailed] = useState(false)
  return source === null || failed
    ? <IconRightUpOutline16 size={16} className={css.menuActionIcon} />
    : <img src={source} width={16} height={16} className={css.appIcon} alt="" draggable={false} onError={() => { setFailed(true) }} />
}

/**
 * Render the anchored association menu: the OS default first, the Host's
 * registered handlers with their loading and failure rows, and the file
 * manager reveal pinned to the footer. The owner keeps the open state, the
 * trigger, and gesture state; the chooser only decodes row selection into the
 * shared (action, application) vocabulary.
 * @param props.open - whether the list is showing.
 * @param props.anchor - the trigger element rendered in place.
 * @param props.apps - the file's current association read, when loaded.
 * @param props.host - the serving Host's desktop facts, naming the file manager.
 * @param props.align - list alignment against the anchor.
 * @param props.className - optional class on the Menu's anchor wrapper.
 * @param props.onClose - invoked on outside click or Escape.
 * @param props.onAction - emit the decoded native action for the owning surface.
 * @param props.t - localized copy.
 * @returns the anchor wrapper with the conditional menu.
 */
export function NativeOpenMenu({ open, anchor, apps, host, align = 'end', className, onClose, onAction, t }: {
  open: boolean
  anchor: ReactNode
  apps: PresentedAppState | undefined
  host: PresentedHost | null
  align?: 'start' | 'end' | undefined
  className?: string | undefined
  onClose: () => void
  onAction: (action: PresentedAction, application?: string) => void
} & PropsLocale<typeof NS>): ReactNode {
  const reveal = host?.fileManager ?? 'directory'
  return <Menu className={className} open={open} autoFocus portal align={align} onClose={onClose}
    anchor={anchor}
    items={[
      { id: 'open', icon: <IconRightUpOutline16 size={16} className={css.menuActionIcon} />,
        label: t('presented.defaultApp') },
      ...(apps?.loading === true ? [{ id: 'apps:loading', label: t('presented.appsLoading'), disabled: true }] : []),
      ...(apps?.failed === true ? [{ id: 'apps:error', label: t('presented.appsError'), disabled: true }] : []),
      ...(apps?.applications.map(app => ({
        id: `app:${app.id}`,
        icon: <ApplicationIcon source={app.icon} />,
        label: app.default ? t('presented.appDefault', { app: app.name }) : app.name,
      })) ?? []),
    ]}
    footer={[{ id: 'reveal', icon: <IconFolderOpenOutline16 />, label: t(`presented.${reveal}`) }]}
    onSelect={(id) => {
      if (id === 'reveal') onAction('reveal')
      else if (id.startsWith('app:')) onAction('open', id.slice(4))
      else onAction('open')
    }} />
}
