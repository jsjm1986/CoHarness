/** File identity and explicit default-app, registered-app, or file-manager actions for one delivery. */
import { useRef, useState } from 'react'
import { resolveWorkspacePath } from '@deepseek-ai/dsh-client-runtime/client'
import {
  FileTypeIcon, fileExtension, IconChevronDownOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { PresentedAction, PresentedHost } from '../presented.ts'
import type { PresentedAppState, PresentedOpenPhase } from './present-open.ts'
import { NativeOpenMenu } from './NativeOpenMenu.tsx'
import { basename, type PresentedPath } from './turn-deliverables.ts'
import type { NS } from './locales.ts'
import css from './Deliverables.module.css'

function cardDescription(description: string | undefined, fallback: string): string {
  const trimmed = description?.replace(/\s*(?:\([^()]*\)|（[^（）]*）)\s*$/u, '').trim()
  return trimmed === undefined || trimmed === '' ? fallback : trimmed
}

/**
 * Render independent file actions without nesting buttons inside a clickable card.
 * @param props - durable file metadata, Sidebar preview, Host capabilities, association read, gesture status, and localized copy.
 * @returns the file card and its anchored action menu.
 */
export function PresentedFileCard({ file, cwd, phase, apps, host, onPreview, onLoadApps, onAction, t }: {
  file: PresentedPath
  cwd: string | undefined
  phase: PresentedOpenPhase | undefined
  apps: PresentedAppState | undefined
  host: PresentedHost | null
  onPreview: () => void
  onLoadApps: () => void
  onAction: (action: PresentedAction, application?: string) => void
} & PropsLocale<typeof NS>) {
  const [menuOpen, setMenuOpen] = useState(false)
  const previewRef = useRef<HTMLButtonElement>(null)
  const pending = phase === 'opening' || phase === 'revealing'
  const menuDisabled = pending || host === null || !host.available
  if (menuDisabled && menuOpen) setMenuOpen(false)
  const reveal = host?.fileManager ?? 'directory'
  const act = (action: PresentedAction, application?: string) => {
    setMenuOpen(false)
    previewRef.current?.focus()
    onAction(action, application)
  }
  const name = basename(file.path)
  const metadata = fileExtension(name).toUpperCase() || t('presented.file')
  const status = phase === undefined
    ? cardDescription(file.description, metadata)
    : t(reveal === 'directory' && phase === 'revealed' ? 'presented.directoryOpened'
      : reveal === 'directory' && phase === 'revealing' ? 'presented.directoryOpening'
        : reveal === 'directory' && phase === 'revealError' ? 'presented.directoryError' : `presented.${phase}`)
  return <div className={css.file} data-presented-file>
    <button type="button" className={css.cardPreview} title={resolveWorkspacePath(cwd, file.path)}
      aria-label={t('presented.previewCard', { name: file.path })} onClick={onPreview} />
    <span className={css.fileIcon}><FileTypeIcon path={file.path} size={20} /></span>
    <div className={css.fileBody}>
      <div className={css.details}>
        <span className={css.fileName}>{name}</span>
        <span className={css.description} role={phase === undefined ? undefined : 'status'}
          data-error={phase === 'error' || phase === 'revealError' || phase === 'nativeUnavailable' ? true : undefined}>
          <span className={css.secondaryText}>{status}</span>
          <span className={css.previewHint}>{t('presented.preview')}</span>
        </span>
      </div>
      <div className={css.split}>
        <button ref={previewRef} type="button" className={css.open}
          aria-label={t('presented.previewButton', { name: file.path })}
          onClick={onPreview}>{t('presented.action')}</button>
        <NativeOpenMenu className={css.menuAnchor} open={menuOpen && !menuDisabled} apps={apps} host={host} t={t}
          onClose={() => { setMenuOpen(false) }} onAction={act}
          anchor={<button type="button" className={css.chevron} disabled={menuDisabled}
            aria-haspopup="menu" aria-expanded={menuOpen && !menuDisabled}
            aria-label={t('presented.more', { name: file.path })}
            onClick={() => {
              if (!menuOpen) onLoadApps()
              setMenuOpen(value => !value)
            }}>
            <IconChevronDownOutline14 size={11} />
          </button>} />
      </div>
    </div>
  </div>
}
