/** Live terminal names in docked and floating tab chrome. */
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { TerminalView, TerminalViewState } from '@deepseek-ai/dsh-api-terminal-controller/client'
import { TerminalIcon } from './TerminalIcon.tsx'
import type { TerminalRenameInjected, TerminalTitleInjected } from './face.ts'
import type {} from './locales.ts'
import css from './TerminalTitle.module.css'

interface TerminalTitleProps extends PropsLocale<'sidebarTerminal'>, Pick<TerminalTitleInjected, 'bindRename'> {
  useTabInfo: () => { tab: { id: string; title: string } }
  useTerminal: (key: string, select: (state: TerminalViewState | undefined) => string | undefined) => string | undefined
  view: (key: string) => Pick<TerminalView, 'rename'>
}

interface TerminalRenameItemProps extends PropsLocale<'sidebarTerminal'>, TerminalRenameInjected {
  tab: { id: string; kind: string }
  dismiss: () => void
}

/**
 * Render the terminal name, editable through the tab menu, F2 or double-click.
 * @param props - sidebar occurrence, terminal model and localized copy.
 * @returns the terminal icon and current name or its editor.
 */
export function TerminalTitle({ useTabInfo, useTerminal, view, bindRename, t }: TerminalTitleProps): ReactNode {
  const { tab } = useTabInfo()
  const title = useTerminal(tab.id, state => state?.info?.title ?? state?.title) ?? tab.title
  const [editing, setEditing] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const label = useRef<HTMLSpanElement>(null)
  const cancelled = useRef(false)
  const edit = useCallback((): void => { cancelled.current = false; setEditing(true) }, [])
  useLayoutEffect(() => bindRename(tab.id, edit), [bindRename, tab.id, edit])
  useLayoutEffect(() => {
    if (editing) return
    // Dockkit captures the pointer on its drag handle, which receives the double-click.
    const chip = label.current?.closest('[data-dockkit-tab], [data-dockkit-float-grip]')
    const rename = (event: Event): void => {
      event.stopPropagation()
      edit()
    }
    const keydown = (event: Event): void => {
      if (!(event instanceof KeyboardEvent) || event.key !== 'F2' || event.altKey || event.ctrlKey || event.metaKey
        || event.shiftKey || event.isComposing) return
      event.preventDefault()
      rename(event)
    }
    chip?.addEventListener('dblclick', rename)
    chip?.addEventListener('keydown', keydown)
    return () => { chip?.removeEventListener('dblclick', rename); chip?.removeEventListener('keydown', keydown) }
  }, [edit, editing])
  useLayoutEffect(() => {
    if (!editing) return
    input.current?.focus()
    input.current?.select()
  }, [editing])
  return <>
    <TerminalIcon />
    {editing ? <input ref={input} className={css.name} defaultValue={title} maxLength={120} aria-label={t('rename')}
      onPointerDown={(event) => { event.stopPropagation() }}
      onClick={(event) => { event.stopPropagation() }}
      onDoubleClick={(event) => { event.stopPropagation() }}
      onBlur={(event) => {
        setEditing(false)
        const next = event.currentTarget.value.trim()
        if (!cancelled.current && next !== '' && next !== title) void view(tab.id).rename(next)
      }}
      onKeyDown={(event) => {
        event.stopPropagation()
        // oxlint-disable-next-line typescript/no-deprecated -- Some IMEs report composition only through keyCode 229.
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
        if (event.key === 'Escape') {
          cancelled.current = true
          event.currentTarget.blur()
        } else if (event.key === 'Enter') event.currentTarget.blur()
      }} />
      : <span ref={label} className={css.title}>{title}</span>}
  </>
}

/**
 * Offer terminal title editing through the shared keyboard and touch tab menu.
 * @param props - target tab, menu dismissal, localized label and mounted-title command.
 * @returns the rename action for terminal tabs only.
 */
export function TerminalRenameItem({ tab, dismiss, renameTitle, t }: TerminalRenameItemProps): ReactNode {
  if (tab.kind !== 'terminal') return null
  return <MenuItemButton shortcut={{ keys: ['F2'], aria: 'F2' }} onSelect={() => {
    dismiss()
    renameTitle(tab.id)
  }}>{t('renameAction')}</MenuItemButton>
}
