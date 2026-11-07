/** Window-local Inspector frontend in the layout's bottom slot. */
import type { Context } from '@deepseek-ai/cordis'
import { useCallback, useId, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { Button, IconCloseOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { InspectorSourceId } from '../../shared/bridge/ids.ts'
import { INSPECTOR_CLIENT_QUERY, INSPECTOR_SOURCE_SCOPE_QUERY } from '../../shared/source-selection.ts'
import { bindInspectorKeyboard } from './keyboard.ts'
import { InspectorResizeHandle } from './resize.tsx'
import { zh, en } from './locales.ts'
import css from './page.module.css'

const ID = 'inspector.toggle' as ShortcutCommandId
type PanelState = 'unopened' | 'visible' | 'hidden'

interface InspectorPanelInjected {
  readonly frontendUrl: string
  readonly hostOnly: boolean
  readonly close: () => void
  readonly bindFrame: (frame: HTMLIFrameElement) => () => void
  readonly hooks: { readonly panel: HostObservable<PanelState> }
}

function InspectorPage({ t, frontendUrl, hostOnly, close, bindFrame, usePanel }:
  PropsRuntime<'shell.bottom'> & PropsLocale<'inspectorPanel'> & InjectFace<InspectorPanelInjected>) {
  const state = usePanel(value => value)
  const title = t(hostOnly ? 'hostOnlyTitle' : 'title')
  const [height, setHeight] = useState(45)
  const panelId = useId()
  const release = useRef<(() => void) | undefined>(undefined)
  const frameRef = useCallback((frame: HTMLIFrameElement | null) => {
    release.current?.()
    release.current = frame === null ? undefined : bindFrame(frame)
  }, [bindFrame])
  return <section id={panelId} className={css.panel} style={{ '--inspector-height': `${height}dvh` } as CSSProperties}
    hidden={state !== 'visible'} aria-label={title} data-inspector-panel>
    {state === 'visible' && <InspectorResizeHandle height={height} onResize={setHeight} label={t('resize')} panelId={panelId} />}
    <header className={css.header}>
      <span>{title}</span>
      <Tooltip label={t('close')} side="top" portal>
        <Button variant="ghost" size="sm" className={css.close} aria-label={t('close')} onClick={close}
          icon={<IconCloseOutline16 size={14} />} />
      </Tooltip>
    </header>
    {state !== 'unopened' && <iframe ref={frameRef} className={css.page} src={frontendUrl} title={hostOnly ? title : t('frameTitle')}
      name="dsh-nodejs-inspector" referrerPolicy="no-referrer" data-inspector-devtools />}
  </section>
}

/**
 * Register bottom content and its window-local toggle command for the page's inspection scope.
 * @param ctx - Inspector context owning the registrations.
 * @param sourceId - Claimed Client identity, or null for Host-only inspection.
 */
export function registerInspectorPage(ctx: Context, sourceId: InspectorSourceId | null): void {
  const query = new URLSearchParams({ disableLocaleInfoBar: 'true' })
  if (sourceId === null) query.set(INSPECTOR_SOURCE_SCOPE_QUERY, 'host')
  else query.set(INSPECTOR_CLIENT_QUERY, sourceId)
  const frontendUrl = `inspector/devtools/devtools_app.html?${query}`
  ctx.effect(() => ctx.locale.register('inspectorPanel', { zh, en }))
  const t = ctx.locale.bind('inspectorPanel')
  ctx.slots.inject('shell.bottom', function* () {
    const panel = createSnapshotStore<PanelState>('unopened')
    let opener: HTMLElement | undefined
    const close = (): void => {
      if (panel.getSnapshot() !== 'visible') return
      panel.set('hidden')
      if (opener?.isConnected) opener.focus()
    }
    yield ctx.shortcuts.register({
      id: ID, label: () => t(sourceId === null ? 'hostOnlyToggle' : 'toggle'), aliases: ['inspector', 'nodejs', 'devtools'],
      defaults: {
        'desktop:macos': { code: 'Period', modifiers: ['primary', 'shift'] },
        'desktop:windows': { code: 'Period', modifiers: ['primary', 'shift'] },
        'desktop:linux': { code: 'Period', modifiers: ['primary', 'shift'] },
        'web:macos': { code: 'Period', modifiers: ['primary', 'shift'] },
        'web:windows': { code: 'Period', modifiers: ['primary', 'shift'] },
        'web:linux': { code: 'Period', modifiers: ['primary', 'shift'] },
      },
      regions: ['page', 'editable', 'terminal'], modals: [],
      resolve: ({ target }) => ({ status: 'handled', run: () => {
        if (panel.getSnapshot() === 'visible') close()
        else {
          opener = target instanceof HTMLElement ? target : undefined
          panel.set('visible')
        }
      } }),
    })
    yield ctx.slots.register({
      name: 'shell.bottom', locale: 'inspectorPanel',
      inject: (): InspectorPanelInjected => ({
        frontendUrl, hostOnly: sourceId === null, close, hooks: { panel },
        bindFrame: frame => bindInspectorKeyboard(frame, () => ctx.shortcuts.catalog.getSnapshot().find(row => row.id === ID)?.binding),
      }),
    }, InspectorPage)
  })
}
