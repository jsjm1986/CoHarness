/**
 * Opens a collapsed panel from the conversation header on wide screens or
 * the shell topbar on compact screens. Both placements share the panel's
 * per-Session store and disappear while the panel is expanded.
 *
 * The glyph is the left sidebar's collapse icon mirrored: the same affordance,
 * on the other edge.
 */
import type { ShortcutCatalogEntry } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { ConversationViewportSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { HostObservable, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReactNode } from 'react'
import { IconPanelLeftOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { createSidebarRightStore } from '../stores.ts'
import { followsCurrentSession } from '../session-selection.ts'
import css from './ExpandButton.module.css'

/** Session identity, shared panel state, navigation, shortcuts, and copy. */
export type ExpandButtonProps =
  & PropsRuntime<'conversation.session.header.corner'>
  & PropsStore<ReturnType<typeof createSidebarRightStore>>
  & PropsLocale<'sidebarRight'>
  & InjectFace<{ hooks: { shortcuts: HostObservable<readonly ShortcutCatalogEntry[]> } }>
  & { focus: () => void }

type MobileExpandButtonProps = ExpandButtonProps
  & InjectFace<{ hooks: { viewport: HostObservable<ConversationViewportSnapshot> } }>

/**
 * Show the shell action only for the verified foreground Conversation.
 * @param props - shared expand control and the existing conversation viewport.
 * @returns the expand control once the current Session matches the foreground pane.
 */
export function MobileExpandButton({ useViewport, ...props }: MobileExpandButtonProps): ReactNode {
  const followsCurrent = useViewport(viewport => followsCurrentSession(viewport, props.sessionId))
  return followsCurrent ? <ExpandButton {...props} /> : null
}

/** The expand control while the panel is collapsed; nothing while it is shown. */
export function ExpandButton({ sessionId, useStore, actions, t, focus, useShortcuts }: ExpandButtonProps): ReactNode {
  const shortcut = useShortcuts(entries => entries.find(entry => entry.id === 'sidebar.right.toggle'))
  // A session with no surface yet is collapsed: the panel seat materializes the
  // surface on its own mount, and until then there is nothing expanded.
  const expanded = useStore(state => state.bySession[sessionId]?.layout.expanded ?? false)
  if (expanded) return null
  return (
    <Tooltip label={t('chrome.expand')} shortcutKeys={shortcut?.keys} side="bottom" delayMs={500}>
      <button
        type="button"
        className={css.button}
        aria-label={t('chrome.expandAria')}
        aria-keyshortcuts={shortcut?.aria}
        data-sidebar-right-expand
        onClick={() => { focus(); actions.setExpanded(sessionId, true) }}
      >
        <IconPanelLeftOutline16 className={css.icon} />
      </button>
    </Tooltip>
  )
}
