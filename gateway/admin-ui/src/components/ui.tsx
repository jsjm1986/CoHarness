import {
  AlertCircle,
  Inbox,
  LoaderCircle,
  X,
  type LucideIcon,
} from 'lucide-react'
import {
  cloneElement,
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  type ButtonHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from 'react'
import { adminLanguage, translateCopy } from '../language.ts'
import { zh as chromeZh, en as chromeEn } from '../chrome.copy.ts'

/** Organization-scoped control displayed beside each Admin page title. */
export const PageHeaderComputerContext = createContext<ReactNode>(null)

/**
 * Render the Admin title and its document-scoped computer control.
 * @param props - Title, description, metadata and actions supplied by the page.
 * @returns The page header.
 */
export function PageHeader({
  title,
  description,
  meta,
  actions,
}: {
  title: string
  description?: string
  meta?: ReactNode
  actions?: ReactNode
}) {
  const computer = useContext(PageHeaderComputerContext)
  useEffect(() => { document.title = `${title} — COHARNESS` }, [title])
  return (
    <header className={computer === null ? 'pageHeader' : 'pageHeader pageHeaderWithComputer'}>
      <div className="pageHeading">
        <div className="pageTitleLine">
          <h1>{title}</h1>
          {meta === undefined ? null : <span className="pageMeta">{meta}</span>}
        </div>
        {description === undefined ? null : <p>{description}</p>}
      </div>
      {computer === null ? null : <div className="pageHeaderComputer">{computer}</div>}
      {actions === undefined ? null : <div className="pageActions">{actions}</div>}
    </header>
  )
}

export function Section({
  title,
  meta,
  actions,
  flush = false,
  children,
  className = '',
}: {
  title?: string
  meta?: ReactNode
  actions?: ReactNode
  /** Content that intentionally spans the card edge to edge (tables, filter strips, metric grids) instead of the padded body. */
  flush?: boolean
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`section ${className}`.trim()}>
      {title === undefined && actions === undefined ? null : (
        <div className="sectionHeader">
          <div className="sectionTitleLine">
            {title === undefined ? null : <h2>{title}</h2>}
            {meta === undefined ? null : <span className="sectionMeta">{meta}</span>}
          </div>
          {actions === undefined ? null : <div className="sectionActions">{actions}</div>}
        </div>
      )}
      {flush ? children : <div className="sectionBody">{children}</div>}
    </section>
  )
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

export function Button({
  variant = 'secondary',
  loading = false,
  icon: Icon,
  className = '',
  children,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  loading?: boolean
  icon?: LucideIcon
}) {
  return (
    <button
      {...props}
      className={`button button-${variant} ${className}`.trim()}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
    >
      {loading ? <LoaderCircle className="spin" aria-hidden="true" /> : Icon === undefined ? null : <Icon aria-hidden="true" />}
      {children}
    </button>
  )
}

export function IconButton({
  label,
  icon: Icon,
  variant = 'ghost',
  loading = false,
  className = '',
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'title'> & {
  label: string
  icon: LucideIcon
  variant?: ButtonVariant
  loading?: boolean
}) {
  return (
    <button
      {...props}
      type={props.type ?? 'button'}
      className={`iconButton iconButton-${variant} ${className}`.trim()}
      aria-label={label}
      title={label}
      disabled={props.disabled === true || loading}
    >
      {loading ? <LoaderCircle className="spin" aria-hidden="true" /> : <Icon aria-hidden="true" />}
    </button>
  )
}

type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

export function StatusBadge({ tone = 'neutral', children }: { tone?: StatusTone; children: ReactNode }) {
  return <span className={`statusBadge status-${tone}`}><span className="statusDot" />{children}</span>
}

const unavailableServices = new Set([
  'node-configuration-unavailable', 'webhook-deliveries-unavailable', 'webhook-endpoints-unavailable',
  'tunnel-unavailable', 'document-catalog-unavailable', 'conversation-archive-unavailable',
  'desktop-coordination-unavailable',
])

export function ErrorBanner({ message }: { message: string }) {
  if (message === '') return null
  const t = translateCopy(adminLanguage(), { zh: chromeZh, en: chromeEn })
  return (
    <div className="errorBanner" role="alert">
      <AlertCircle aria-hidden="true" />
      <span>{unavailableServices.has(message) ? t('serviceUnavailable') : message}</span>
    </div>
  )
}

export function LoadingState({ label }: { label?: string }) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: chromeZh, en: chromeEn }), [])
  return <div className="loadingState" role="status"><LoaderCircle className="spin" aria-hidden="true" />{label ?? t('loading')}</div>
}

export function EmptyState({
  icon: Icon = Inbox,
  title,
  detail,
  action,
}: {
  icon?: LucideIcon
  title: string
  detail?: string
  action?: ReactNode
}) {
  return (
    <div className="emptyState">
      <span className="emptyIcon"><Icon aria-hidden="true" /></span>
      <strong>{title}</strong>
      {detail === undefined ? null : <p>{detail}</p>}
      {action === undefined ? null : <div>{action}</div>}
    </div>
  )
}

type FieldControlProps = { id: string; 'aria-describedby'?: string }

/** Associates one native control with its visible label and hint. Wrapped controls forward the render child's props. */
export function Field({
  label,
  hint,
  children,
  className = '',
}: {
  label: string
  hint?: string
  children: ReactElement<Partial<FieldControlProps>> | ((props: FieldControlProps) => ReactNode)
  className?: string
}) {
  const generatedId = useId()
  const id = typeof children === 'function' ? generatedId : children.props.id ?? generatedId
  const hintId = hint === undefined ? undefined : `${generatedId}-hint`
  const describedBy = typeof children === 'function' ? undefined : children.props['aria-describedby']
  const controlProps = { id, 'aria-describedby': [describedBy, hintId].filter(Boolean).join(' ') || undefined }
  return (
    <div className={`field ${className}`.trim()}>
      <label className="fieldLabel" htmlFor={id}>{label}</label>
      {typeof children === 'function' ? children(controlProps) : cloneElement(children, controlProps)}
      {hint === undefined ? null : <span id={hintId} className="fieldHint">{hint}</span>}
    </div>
  )
}

export function Switch({
  label,
  ariaLabel,
  checked,
  onChange,
  disabled = false,
}: {
  label?: string
  /** Accessible name for icon-less toggles whose cell context already labels them. */
  ariaLabel?: string
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
}) {
  return (
    <label className="switchControl">
      <input type="checkbox" aria-label={ariaLabel} checked={checked} onChange={event => onChange(event.target.checked)} disabled={disabled} />
      <span className="switchTrack" aria-hidden="true"><span /></span>
      {label === undefined ? null : <span>{label}</span>}
    </label>
  )
}

export function Dialog({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  danger = false,
  wide = false,
}: {
  open: boolean
  title: string
  description?: string
  onClose: () => void
  children?: ReactNode
  footer?: ReactNode
  danger?: boolean
  wide?: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const hasFooter = footer !== undefined
  const titleId = useId()
  const descriptionId = useId()
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: chromeZh, en: chromeEn }), [])

  useEffect(() => {
    const dialog = ref.current
    if (dialog === null) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  useEffect(() => {
    const dialog = ref.current
    const viewport = window.visualViewport
    if (!open || dialog === null || !viewport) return
    const surface = dialog.querySelector<HTMLElement>('.dialogSurface')
    if (surface === null) return
    const header = surface.querySelector<HTMLElement>('.dialogHeader')
    const footer = surface.querySelector<HTMLElement>('.dialogFooter')
    const update = () => {
      const wasShort = dialog.hasAttribute('data-short-viewport')
      dialog.style.setProperty('--dialog-viewport-height', `${viewport.height}px`)
      dialog.style.setProperty('--dialog-viewport-top', `${viewport.offsetTop}px`)
      dialog.toggleAttribute('data-compact-viewport', viewport.height <= 320)
      const bodyHeight = surface.querySelector<HTMLElement>('.dialogBody')?.scrollHeight ?? 0
      const pinnedHeight = (header?.offsetHeight ?? 0) + (footer?.offsetHeight ?? 0) + Math.min(44, bodyHeight)
      const short = viewport.height < 192 || pinnedHeight > surface.clientHeight + 1
      dialog.toggleAttribute('data-short-viewport', short)
      if (wasShort && !short) surface.scrollTop = 0
      const focused = document.activeElement
      if (viewport.height < 96 && focused instanceof HTMLElement && dialog.contains(focused)
        && focused.matches('input:not([readonly]), textarea:not([readonly])')) {
        const field = focused.getBoundingClientRect()
        const surfaceBounds = surface.getBoundingClientRect()
        surface.scrollTop += field.top + field.height / 2 - (surfaceBounds.top + surfaceBounds.height / 2)
      }
    }
    update()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update)
    if (header !== null) observer?.observe(header)
    if (footer !== null) observer?.observe(footer)
    viewport.addEventListener('resize', update)
    viewport.addEventListener('scroll', update)
    return () => {
      observer?.disconnect()
      viewport.removeEventListener('resize', update)
      viewport.removeEventListener('scroll', update)
      dialog.style.removeProperty('--dialog-viewport-height')
      dialog.style.removeProperty('--dialog-viewport-top')
      dialog.removeAttribute('data-compact-viewport')
      dialog.removeAttribute('data-short-viewport')
    }
  }, [open, hasFooter])

  return (
    <dialog
      ref={ref}
      className={`dialog ${wide ? 'dialogWide' : ''}`.trim()}
      aria-labelledby={titleId}
      aria-describedby={description === undefined ? undefined : descriptionId}
      onCancel={event => { event.preventDefault(); onClose() }}
      onClick={event => { if (event.target === event.currentTarget) onClose() }}
    >
      <div className="dialogSurface">
        <header className="dialogHeader">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description === undefined ? null : <p id={descriptionId}>{description}</p>}
          </div>
          <IconButton label={t('dialogClose')} icon={X} onClick={onClose} />
        </header>
        {children === undefined ? null : <div className="dialogBody">{children}</div>}
        {hasFooter ? <footer className={`dialogFooter ${danger ? 'dialogFooterDanger' : ''}`}>{footer}</footer> : null}
      </div>
    </dialog>
  )
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  pending = false,
  error = '',
  confirmDisabled = false,
  onConfirm,
  onClose,
}: {
  open: boolean
  title: string
  description: string
  confirmLabel: string
  pending?: boolean
  error?: string
  confirmDisabled?: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: chromeZh, en: chromeEn }), [])
  return (
    <Dialog
      open={open}
      title={title}
      description={description}
      onClose={onClose}
      danger
      footer={(
        <>
          <Button type="button" onClick={onClose} disabled={pending}>{t('cancel')}</Button>
          <Button type="button" variant="danger" loading={pending} disabled={confirmDisabled} onClick={onConfirm}>{confirmLabel}</Button>
        </>
      )}
    >
      {error === '' ? undefined : <ErrorBanner message={error} />}
    </Dialog>
  )
}
