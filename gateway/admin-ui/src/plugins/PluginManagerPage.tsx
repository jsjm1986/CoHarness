/**
 * The friendly plugin list: every package the profile installed or the
 * installation ships beside every official plugin that registered a page,
 * one row per plugin with its live switch, its startup choice, and its
 * expandable detail. The entry-level composition stays in the matrix view
 * the page folds below this list.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { PluginInstallFailureKind, Registry } from '../../../../packages/boot/plugin-manager/src/types.ts'
import {
  Button, IconCheckOutline16, IconChevronDownOutline14, IconChevronLeftOutline14, IconChevronRightOutline14, IconCloseOutline16,
  IconPlusOutline16, IconRefreshOutline16, IconTrashOutline16, IconWarningOutline16, Input, Modal, pointerModality,
  PluginArtworkDefault, PluginArtworkLoop, PluginArtworkSearch, PluginArtworkSubagent, PluginArtworkTerminal,
  StateDot, Switch, Tag, TerminalBlock, Toast, useAnchoredPosition, useDismissOnOutsidePointer,
  type IconProps, type StateDotState, type TerminalBlockLabels,
} from '@deepseek-ai/dsh-client-ui-primitives'

import { rowConfigKey, type OfficialItem } from './config-ledger.ts'
import { INSTALL_GIT_EXAMPLE, INSTALL_PATH_EXAMPLE, type PluginManagerLocaleKey } from './locales.ts'
import {
  asksMirror, githubRecoveryRegistry, isInstallPending, offeredRegistries, rowKey,
  type InstallInputError, type InstallState, type InstallSubject, type PackageRow, type PackageView,
  type PluginManagerFace, type RegistryChoice,
} from './manager-store.ts'
import { managementText, noticeText, packageText, registryText, rowText, type ResolveText, type Translate } from './presentation.ts'
import { effective, ENTRY_CHOICES, type EntryChoice, type PluginComposition } from './composition.ts'

import css from './PluginManagerPage.module.css'

/** Full component props assembled by the main slot renderer. */
export type PluginManagerPageProps =
  Omit<PluginManagerFace, 'hooks'> & {
    t: Translate
    /** Current-locale package metadata resolver, supplied with `t`. */
    resolveText: ResolveText
    /** The shared target composition the page edits through its row controls. */
    composition: PluginComposition
    usePluginManager<T>(selector: (state: import('./manager-store.ts').PluginManagerState) => T): T
    useConfigLedger<T>(selector: (state: import('./config-ledger.ts').ConfigLedger) => T): T
    renderSlot(name: string, props: { view: 'page' | 'summary' }, selection: { only?: string; entryKey?: string }): ReactNode
  }

/** The page's slot renderer, narrowed to the configuration slots. */
type RenderConfig = PluginManagerPageProps['renderSlot']

/** What the page shows: the cards, a bundle's page, an official plugin's page, or a row's configuration page. */
type View =
  | { readonly kind: 'list' }
  | { readonly kind: 'package'; readonly name: string }
  | { readonly kind: 'item'; readonly id: string }
  | { readonly kind: 'row'; readonly name: string; readonly rowId: string }

type RowPhase = NonNullable<PackageRow['phase']>

/** How long the list marks a package an install just enabled. */
const HIGHLIGHT_MS = 2_400

/** Built-in profile bundles stay out of this page even when the profile declares them as dependencies. */
const BUILTIN_PROFILE_BUNDLES = new Set([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-headless',
  '@deepseek-ai/dsh-sdk-app',
  '@deepseek-ai/dsh-acp-app',
  '@deepseek-ai/dsh-sdk-minimal',
])

/** How long a toast holds: long enough to read a failure that names what broke. */
function toastHoldMs(text: string): number {
  return Math.min(8_000, Math.max(3_000, text.length * 80))
}

const PHASE_KEYS = {
  pending: 'rowPhasePending',
  loading: 'rowPhaseLoading',
  active: 'rowPhaseActive',
  failed: 'rowPhaseFailed',
  unloading: 'rowPhaseUnloading',
} satisfies Record<RowPhase, PluginManagerLocaleKey>

/** Status dot naming a root-fiber phase; loading and unloading are live transitions. */
const PHASE_STATES = {
  pending: 'idle',
  loading: 'ongoing',
  active: 'done',
  failed: 'error',
  unloading: 'ongoing',
} satisfies Record<RowPhase, StateDotState>

/** The count line over a pack's components: the total, then only the states that occur. */
function partsSummary(rows: readonly PackageRow[], t: Translate): string {
  const failed = rows.filter(row => row.phase === 'failed').length
  const off = rows.filter(row => !row.enabled).length
  const running = rows.filter(row => row.enabled && row.phase === 'active').length
  return [
    t('partsCountTotal', { count: String(rows.length) }),
    ...running > 0 ? [t('partsCountRunning', { count: String(running) })] : [],
    ...off > 0 ? [t('partsCountOff', { count: String(off) })] : [],
    ...failed > 0 ? [t('partsCountFailed', { count: String(failed) })] : [],
  ].join(' · ')
}

/** Switching for a pack's rows: which rows have a write in flight, and the write. */
interface RowToggles {
  readonly busy: (row: PackageRow) => boolean
  readonly onSetEnabled: (row: PackageRow, enabled: boolean) => void
}

/** Configuration for a pack's rows: which rows registered a page of their own, and opening it. */
interface RowConfigure {
  readonly has: (row: PackageRow) => boolean
  readonly open: (row: PackageRow) => void
}

/** Rows beyond this count get a filter box above the list. */
const ROW_FILTER_THRESHOLD = 10

/** The size the 36-viewBox plugin artwork renders at inside a card's 48px frame. */
const CARD_ARTWORK_SIZE = 36

/** The size the artwork renders at inside a row's 40px frame. */
const ROW_ARTWORK_SIZE = 30

/** The artwork of the official plugins that registered their configuration, by registration id. */
const ITEM_ARTWORK = new Map<string, (props: IconProps) => ReactNode>([
  ['shell', PluginArtworkTerminal],
  ['agent-loop', PluginArtworkLoop],
  ['subagent', PluginArtworkSubagent],
  ['web-search', PluginArtworkSearch],
])

/** An official plugin's card and page artwork; plugins without their own get the default. */
function itemArtwork(id: string): ReactNode {
  const Artwork = ITEM_ARTWORK.get(id) ?? PluginArtworkDefault
  return <Artwork size={CARD_ARTWORK_SIZE} />
}

/** Manifest images remain isolated from the page DOM; a failed decode keeps the position's default artwork. */
function PackageArtwork({ src, row = false, size = row ? ROW_ARTWORK_SIZE : CARD_ARTWORK_SIZE }: {
  readonly src: string | undefined
  readonly row?: boolean
  readonly size?: number
}): ReactNode {
  const [failedSource, setFailedSource] = useState<string>()
  const Fallback = row ? PluginArtworkSubagent : PluginArtworkDefault
  return src === undefined || src === failedSource
    ? <Fallback size={size} />
    : <img className={css.packageImage} src={src} width={size} height={size} alt="" onError={() => { setFailedSource(src) }} />
}

/** A row's switch: locked, saying why, when the Host refuses to address the row through the profile patch. */
function RowSwitch({ row, title, t, busy, onChange }: {
  readonly row: PackageRow
  readonly title: string
  readonly t: Translate
  readonly busy: boolean
  readonly onChange: (enabled: boolean) => void
}): ReactNode {
  const locked = row.readOnlyReason !== undefined || row.entryId === undefined
  return (
    <Switch
      checked={row.enabled}
      label={t('partToggle', { name: title })}
      disabled={busy || locked}
      {...row.readOnlyReason === undefined ? {} : { title: managementText({ code: row.readOnlyReason }, t) }}
      onChange={onChange}
    />
  )
}

/** What a row's state line says: off, or the phase its fiber is in. */
function rowStateText(row: PackageRow, t: Translate): string {
  if (!row.enabled) return t('partOff')
  return row.phase === null ? t('rowStateIdle') : t(PHASE_KEYS[row.phase])
}

/** The dot beside a row: its fiber phase, or idle. */
function rowDotState(row: PackageRow): StateDotState {
  if (!row.enabled || row.phase === null) return 'idle'
  return PHASE_STATES[row.phase]
}

/** A Host metadata diagnostic does not change the package's management permissions. */
function MetadataError({ error, t }: { readonly error: string | undefined; readonly t: Translate }): ReactNode {
  return error === undefined ? null : <p className={css.reason} role="status" data-package-meta-error>{t('metadataError', { error })}</p>
}

/**
 * A pack's rows as a list in the order the pack declares them: a state dot,
 * the row id, one line saying its state, a configure control for a row that
 * registered a page, and, when the pack is on, a switch. A pack like base
 * carries close to a hundred rows, so a long list gets a filter.
 */
function RowsSection({ rows, t, resolveText, toggle, configure }: {
  readonly rows: readonly PackageRow[]
  readonly t: Translate
  readonly resolveText: ResolveText
  readonly toggle?: RowToggles | undefined
  readonly configure?: RowConfigure | undefined
}): ReactNode {
  const [filter, setFilter] = useState('')
  const query = filter.trim().toLowerCase()
  const localized = rows.map(row => ({ row, ...rowText(row, resolveText) }))
  const shown = query === '' ? localized : localized.filter(({ row, title, description }) =>
    [title, description, row.rowId, row.moduleName].some(value => value?.toLowerCase().includes(query)))
  return (
    <section className={css.detailSection} data-plugin-rows>
      <div className={css.sectionHead}>
        <h4 className={css.sectionTitle}>{t('partsLabel')}</h4>
        {rows.length === 0 ? null : <span className={css.sectionCount}>{partsSummary(rows, t)}</span>}
      </div>
      {rows.length === 0 ? <p className={css.status}>{t('partsEmpty')}</p> : null}
      {rows.length > ROW_FILTER_THRESHOLD
        ? (
          <Input
            type="search"
            className={css.partsFilter as string}
            placeholder={t('partsFilter')}
            aria-label={t('partsFilter')}
            value={filter}
            onChange={(event) => { setFilter(event.target.value) }}
          />
        )
        : null}
      {rows.length > 0 && shown.length === 0 ? <p className={css.status}>{t('partsFilterEmpty')}</p> : null}
      {shown.length === 0
        ? null
        : (
          <ul className={css.rows}>
            {shown.map(({ row, title, description }) => (
              <li
                key={row.rowId}
                className={css.row}
                data-plugin-row={row.entryId ?? row.rowId}
                {...row.phase === 'failed' ? { 'data-state': 'failed' } : row.enabled ? {} : { 'data-state': 'off' }}
              >
                <div className={css.rowLine}>
                  <span className={css.rowIcon} aria-hidden="true"><PackageArtwork key={row.meta?.icon} src={row.meta?.icon} row /></span>
                  <div className={css.rowMain}>
                    {configure?.has(row) === true
                      ? (
                        <button type="button" className={css.rowOpen} aria-label={t('configureRow', { name: title })} onClick={() => { configure.open(row) }}>
                          <span className={css.rowId}>{title}</span>
                          <IconChevronRightOutline14 className={css.rowOpenIcon} aria-hidden="true" />
                        </button>
                      )
                      : <span className={css.rowId}>{title}</span>}
                    {description === undefined ? null : <span className={css.rowModule}>{description}</span>}
                    {title === row.rowId ? null : <code className={css.rowModule}>{row.rowId}</code>}
                    {title === row.moduleName ? null : <code className={css.rowModule}>{row.moduleName}</code>}
                  </div>
                  <span className={css.rowState}>
                    <StateDot state={rowDotState(row)} />
                    {rowStateText(row, t)}
                  </span>
                  {toggle === undefined
                    ? null
                    : (
                      <RowSwitch
                        row={row} title={title} t={t} busy={toggle.busy(row)}
                        onChange={(enabled) => { toggle.onSetEnabled(row, enabled) }}
                      />
                    )}
                </div>
                <MetadataError error={row.meta?.error} t={t} />
              </li>
            ))}
          </ul>
        )}
    </section>
  )
}

/**
 * A bundle's live enable switch on its row: locked, saying why, for
 * one the Host protects; off and locked for one it cannot read.
 */
function EnableSwitch({ pkg, title, t, busy, onSetEnabled }: {
  readonly pkg: PackageView
  readonly title: string
  readonly t: Translate
  readonly busy: boolean
  readonly onSetEnabled: (enabled: boolean) => void
}): ReactNode {
  return (
    <Switch
      checked={pkg.enabled}
      label={t('enableToggle', { name: title })}
      disabled={busy || pkg.readOnlyReason !== undefined || (!pkg.enabled && pkg.error !== undefined)}
      {...pkg.readOnlyReason === undefined ? {} : { title: managementText({ code: pkg.readOnlyReason }, t) }}
      onChange={onSetEnabled}
    />
  )
}

/** The status one package row carries: running, off, or a problem the Host reported. */
function packageStatus(pkg: PackageView): 'running' | 'disabled' | 'problem' {
  if (pkg.error !== undefined) return 'problem'
  return pkg.enabled ? 'running' : 'disabled'
}

/** The head every entity row shares: the artwork, the toggle title with its badges, the one-liner, and the expand chevron. */
function EntityHead({ icon, title, badges, description, expanded, toggleLabel, onToggle }: {
  readonly icon: ReactNode
  readonly title: string
  readonly badges?: ReactNode
  readonly description: ReactNode
  readonly expanded: boolean
  readonly toggleLabel: string
  readonly onToggle: () => void
}): ReactNode {
  const descriptionId = useId()
  return (
    <div className={css.cardHead} {...expanded ? { 'data-expanded': '' } : {}}>
      <span className={css.cardIcon} aria-hidden="true">{icon}</span>
      <div className={css.cardMain}>
        <div className={css.titleRow}>
          <button
            type="button"
            className={`${css.cardTitle} ${css.cardOpen}`}
            aria-label={toggleLabel}
            aria-expanded={expanded}
            aria-describedby={description === undefined ? undefined : descriptionId}
            onClick={onToggle}
          >
            {title}
          </button>
          {badges}
        </div>
        {description === undefined ? null : <span className={css.cardDesc} id={descriptionId}>{description}</span>}
      </div>
      <span className={css.entityChevron} aria-hidden="true"><IconChevronDownOutline14 /></span>
    </div>
  )
}

/** One labeled control pair in an entity row: the facet name, then its widget. */
function EntityControl({ label, children }: { readonly label: string; readonly children: ReactNode }): ReactNode {
  return <span className={css.entityControl}><span className={css.entityControlLabel}>{label}</span>{children}</span>
}

/** First-read placeholders share the list's row and text-line layout. */
function ListSkeleton({ label }: { readonly label: string }): ReactNode {
  return (
    <section className={css.group} role="status" aria-label={label} data-plugin-loading>
      <ul className={css.entityList} aria-hidden="true">
        {[0, 1, 2, 3].map(index => (
          <li key={index} className={css.entity}>
            <div className={css.cardHead}>
              <span className={`${css.cardIcon} ${css.skeletonFill} ${css.skeletonIcon}`} />
              <div className={css.cardMain}>
                <div className={css.titleRow}>
                  <span className={`${css.cardTitle} ${css.skeletonText} ${css.skeletonTitle}`}>
                    <span className={`${css.skeletonFill} ${css.skeletonBar}`} />
                  </span>
                </div>
                <span className={`${css.cardDesc} ${css.skeletonText} ${css.skeletonDescription}`}>
                  <span className={`${css.skeletonFill} ${css.skeletonBar}`} />
                </span>
              </div>
              <div className={`${css.cardEnd} ${css.skeletonActions}`} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** The top every detail shares: the crumb that collapses when one is given, then the icon with the detail's actions at its right. */
function DetailTop({ crumbLabel, crumbText, onBack, icon, actions }: {
  readonly crumbLabel?: string
  readonly crumbText?: string
  readonly onBack?: (() => void) | undefined
  readonly icon: ReactNode
  readonly actions?: ReactNode
}): ReactNode {
  return (
    <>
      {onBack === undefined || crumbLabel === undefined ? null : (
        <button type="button" className={css.crumb} aria-label={crumbLabel} onClick={onBack}>
          <IconChevronDownOutline14 className={css.crumbIcon} aria-hidden="true" />
          <span>{crumbText}</span>
        </button>
      )}
      <div className={css.detailHead}>
        <span className={css.cardIcon} aria-hidden="true">{icon}</span>
        {actions}
      </div>
    </>
  )
}

/**
 * One plugin in the unified list: the head with its kind, state, and pending
 * badges, the live and startup controls, and the detail that unfolds in place.
 */
function EntityRow({ icon, title, badges, description, expanded, toggleLabel, onToggle, controls, detail, attrs }: {
  readonly icon: ReactNode
  readonly title: string
  readonly badges?: ReactNode
  readonly description: ReactNode
  readonly expanded: boolean
  readonly toggleLabel: string
  readonly onToggle: () => void
  readonly controls?: ReactNode
  readonly detail?: ReactNode
  readonly attrs?: Record<string, string | undefined>
}): ReactNode {
  return (
    <li className={css.entity} {...attrs}>
      <EntityHead icon={icon} title={title} badges={badges} description={description} expanded={expanded} toggleLabel={toggleLabel} onToggle={onToggle} />
      {controls === undefined ? null : <div className={css.entityControls}>{controls}</div>}
      {expanded && detail !== undefined ? <div className={css.entityDetail}>{detail}</div> : null}
    </li>
  )
}

/** An official plugin's detail: the icon, its title over its one-liner, and the form the entry renders. */
function ItemDetail({ item, t, resolveText, renderSlot, onBack }: {
  readonly item: OfficialItem
  readonly t: Translate
  readonly resolveText: ResolveText
  readonly renderSlot: RenderConfig
  readonly onBack?: (() => void) | undefined
}): ReactNode {
  const title = item.labelText === undefined ? item.label : resolveText(item.labelText) ?? item.label
  return (
    <div className={css.detail} data-plugin-item-detail={item.id}>
      <DetailTop icon={itemArtwork(item.id)} crumbLabel={t('backToList')} crumbText={t('crumbRoot')} onBack={onBack} />
      <div className={css.detailMain}>
        <div className={css.titleRow}>
          <h3 className={css.detailTitle}>{title}</h3>
        </div>
        <p className={css.detailDesc}>{renderSlot('plugins.item', { view: 'summary' }, { only: item.id })}</p>
      </div>
      <div className={css.detailSections} data-plugin-config>
        {renderSlot('plugins.item', { view: 'page' }, { only: item.id })}
      </div>
    </div>
  )
}

/**
 * A row's configuration page: the crumb back to its bundle's page, the row id
 * over the module it names and the entry's one-liner, and the form the entry renders.
 */
function RowDetail({ pkg, row, t, resolveText, onBack, renderSlot }: {
  readonly pkg: PackageView
  readonly row: PackageRow
  readonly t: Translate
  readonly resolveText: ResolveText
  readonly onBack: () => void
  readonly renderSlot: RenderConfig
}): ReactNode {
  const { title } = packageText(pkg, resolveText)
  const { title: rowTitle, description } = rowText(row, resolveText)
  const key = rowConfigKey(pkg.name, row.rowId)
  return (
    <div className={css.detail} data-plugin-row-detail={key}>
      <DetailTop
        crumbLabel={t('backToPackage', { name: title })}
        crumbText={title}
        onBack={onBack}
        icon={<PackageArtwork key={row.meta?.icon} src={row.meta?.icon} row size={CARD_ARTWORK_SIZE} />}
      />
      <div className={css.detailMain}>
        <div className={css.titleRow}>
          <h3 className={css.detailTitle}>{rowTitle}</h3>
        </div>
        {rowTitle === row.rowId ? null : <p className={css.detailName}><code>{row.rowId}</code></p>}
        <p className={css.detailName}><code>{row.moduleName}</code></p>
        <p className={css.detailDesc}>{description ?? renderSlot('plugins.row.config', { view: 'summary' }, { entryKey: key })}</p>
      </div>
      <MetadataError error={row.meta?.error} t={t} />
      <div className={css.detailSections} data-plugin-config>
        {renderSlot('plugins.row.config', { view: 'page' }, { entryKey: key })}
      </div>
    </div>
  )
}

/**
 * One package's detail inside its row: the crumb that collapses; its icon
 * with, for a package the profile installed, uninstall; its title beside its
 * version tag, its beta tag, and its problem tag; the package name the title
 * stands for, which is what installs it elsewhere; its one-liner; the Host's
 * problem when it reports one; the configuration the bundle registered for
 * itself; and its rows with their switches and configure controls. Its live
 * switch stays on the row above.
 */
function PackageDetail({
  pkg, t, resolveText, busy, rowBusy, configured, configure, renderSlot,
  onBack, onUninstall, onSetRowEnabled,
}: {
  readonly pkg: PackageView
  readonly t: Translate
  readonly resolveText: ResolveText
  readonly busy: boolean
  /** Whether a row has a write in flight. */
  readonly rowBusy: (row: PackageRow) => boolean
  /** Whether the bundle registered a configuration of its own. */
  readonly configured: boolean
  readonly configure: RowConfigure
  readonly renderSlot: RenderConfig
  readonly onBack?: (() => void) | undefined
  readonly onUninstall: () => void
  readonly onSetRowEnabled: (row: PackageRow, enabled: boolean) => void
}): ReactNode {
  const { title, description, beta } = packageText(pkg, resolveText)
  const status = packageStatus(pkg)
  return (
    <div className={css.detail} data-plugin-detail={pkg.name}>
      <DetailTop
        crumbLabel={t('backToList')}
        crumbText={t('crumbRoot')}
        onBack={onBack}
        icon={<PackageArtwork key={pkg.meta?.icon} src={pkg.meta?.icon} />}
        actions={pkg.installed
          ? (
            <div className={css.detailActions}>
              <Button
                variant="outline"
                size="sm"
                className={css.danger}
                icon={<IconTrashOutline16 size={13} />}
                aria-label={t('uninstallLabel', { name: title })}
                disabled={busy || pkg.readOnlyReason !== undefined}
                onClick={onUninstall}
              >
                {t('uninstall')}
              </Button>
            </div>
          )
          : undefined}
      />
      <div className={css.detailMain}>
        <div className={css.titleRow}>
          <h3 className={css.detailTitle}>{title}</h3>
          {pkg.version === undefined ? null : <Tag className={css.versionTag} tone="neutral">{t('versionTag', { version: pkg.version })}</Tag>}
          {beta ? <Tag className={css.statusTag} tone="info">{t('statusBeta')}</Tag> : null}
          {status === 'problem' ? <Tag className={css.statusTag} tone="danger">{t('statusProblem')}</Tag> : null}
        </div>
        <p className={css.detailName}><code data-plugin-name>{pkg.name}</code></p>
        {description === undefined ? null : <p className={css.detailDesc}>{description}</p>}
      </div>
      <MetadataError error={pkg.meta?.error} t={t} />
      {pkg.error === undefined ? null : <p className={css.reason} role="status">{t('reasonLabel')}: {managementText(pkg.error, t)}</p>}
      {pkg.readOnlyReason === undefined ? null : <p className={css.reason} role="status">{managementText({ code: pkg.readOnlyReason }, t)}</p>}
      <div className={css.detailSections}>
        {configured
          ? (
            <section className={css.detailSection} data-plugin-config>
              {renderSlot('plugins.bundle.config', { view: 'page' }, { entryKey: pkg.name })}
            </section>
          )
          : null}
        <RowsSection
          rows={pkg.rows}
          t={t}
          resolveText={resolveText}
          toggle={pkg.enabled ? { busy: row => busy || rowBusy(row), onSetEnabled: onSetRowEnabled } : undefined}
          configure={configure}
        />
      </div>
    </div>
  )
}

/** Output lines an install run's terminal shows before its middle folds: the first and last six of a long pnpm log. */
const INSTALL_TERMINAL_LINES = 12

/** The install terminal's display copy, from the tab's dictionary. */
function terminalLabels(t: Translate): TerminalBlockLabels {
  return {
    /* v8 ignore next -- the Host reports a killed pnpm as a null exit code, never a signal name; the label interface needs one */
    signal: signal => t('terminalSignal', { signal }),
    exitCode: code => t('terminalExitCode', { code: String(code) }),
    noExitCode: t('terminalNoExitCode'),
    running: t('terminalRunning'),
    failed: t('terminalFailed'),
    done: t('terminalDone'),
    copy: t('terminalCopy'),
    copied: t('terminalCopied'),
    noOutput: t('terminalNoOutput'),
    collapseAria: t('terminalCollapseAria'),
    collapse: t('terminalCollapse'),
    expandAria: hidden => t('terminalExpandAria', { n: String(hidden) }),
    expand: hidden => t('terminalExpand', { n: String(hidden) }),
  }
}

/** The sentence under the field for a spec the check refused. */
const INPUT_PROBLEM_KEYS = {
  'invalid-spec': 'installProblemInvalid',
  'already-installed': 'installProblemInstalled',
  'shipped': 'installProblemShipped',
  'not-found': 'installProblemNotFound',
  'not-a-package': 'installProblemNotPackage',
  'not-a-bundle': 'installProblemNotBundle',
  'network': 'installProblemNetwork',
  'unknown': 'installProblemUnknown',
} satisfies Record<InstallInputError['problem'], PluginManagerLocaleKey>

/** One row of the install guide: a spec form's title, its example, and where the person finds it. */
interface GuideExample {
  readonly key: string
  readonly titleKey: PluginManagerLocaleKey
  readonly exampleKey: PluginManagerLocaleKey
  readonly hintKey: PluginManagerLocaleKey
}

/** The spec form the install guide shows, with an example the person can drop into the field. */
const GUIDE_EXAMPLES = [
  { key: 'id', titleKey: 'installGuideIdTitle', exampleKey: 'installGuideIdExample', hintKey: 'installGuideIdHint' },
] as const satisfies readonly GuideExample[]

/** The one-line reading of a classified pnpm failure. */
const FAILURE_KIND_KEYS = {
  'pnpm-missing': 'installFailurePnpmMissing',
  'timeout': 'installFailureTimeout',
  'not-found': 'installFailureNotFound',
  'no-matching-version': 'installFailureNoMatchingVersion',
  'network': 'installFailureNetwork',
  'disk-full': 'installFailureDiskFull',
  'permission': 'installFailurePermission',
  'build-blocked': 'installFailureBuildBlocked',
  'integrity': 'installFailureIntegrity',
  'unknown': 'installFailureGeneric',
} satisfies Record<PluginInstallFailureKind, PluginManagerLocaleKey>

/** The heading of each screen past the spec. */
const SCREEN_TITLE_KEYS = {
  starting: 'installStarting',
  running: 'installingTitle',
  cancelling: 'installCancelling',
  applying: 'installApplying',
  unconfirmed: 'installUnconfirmedTitle',
  unknown: 'installUnknownTitle',
  done: 'installedTitle',
  failed: 'installFailedTitle',
} satisfies Record<Exclude<InstallState['phase'], 'idle' | 'checking'>, PluginManagerLocaleKey>

/** What the spec's kind reads as when the package carries no description of its own. */
const SUBJECT_KIND_KEYS = {
  registry: undefined,
  path: 'installSubjectPath',
  git: 'installSubjectGit',
  tarball: 'installSubjectTarball',
} satisfies Record<InstallSubject['kind'], PluginManagerLocaleKey | undefined>

/** The registries asked, by name, in the dictionary's list form. */
function registryList(registries: readonly Registry[], t: Translate, resolved: string | null): string {
  return registries.map(registry => registryText(registry, t, resolved).name).join(t('registryListSeparator'))
}

/** An option's name with its host in tertiary text, unless the host is the name. */
function registryOption(registry: Registry, t: Translate, resolved: string | null): ReactNode {
  const { name, host } = registryText(registry, t, resolved)
  return name === host ? name : <>{name}{' '}<span className={css.registryHint}>{host}</span></>
}

/**
 * The failed screen's one line: a pnpm failure by its kind, a refusal by its
 * code, any other failure in the Host's words; the run's output stays behind the details.
 * A run the Host laid at the spec's own host says so; one it laid at a registry
 * names every registry asked when there were several.
 */
function failureText(failure: InstallState['failure'], t: Translate, install?: Pick<InstallState, 'attempts' | 'subject' | 'registries'>): string {
  if (failure === null) return t('installFailureGeneric')
  // A compatibility refusal is the package's own answer, whatever pnpm's exit classified the run as.
  if (failure.code === 'incompatible-version') {
    const incompatible = failure.incompatible === undefined ? {} : { incompatible: failure.incompatible }
    return managementText({ code: failure.code, installing: true, ...incompatible }, t)
  }
  // Blocked scripts the Host could not name leave the person to allow them in the profile's pnpm settings by hand.
  if (failure.kind === 'build-blocked' && !failure.pendingBuilds?.length) return t('installFailureBuildBlockedManual')
  const host = install?.subject?.host
  if (failure.failedAt === 'spec-host' && host !== undefined) return t('installFailureNetworkHost', { host })
  const asked = install?.attempts?.registries ?? []
  if (failure.failedAt === 'registry' && (failure.kind === 'network' || failure.kind === 'timeout') && asked.length > 1) {
    return t('installFailureNetworkAll', { registries: registryList(asked, t, install?.registries?.resolved ?? null) })
  }
  if (failure.kind !== undefined) return t(FAILURE_KIND_KEYS[failure.kind])
  if (failure.code !== undefined) return managementText({ code: failure.code, diagnostic: failure.reason }, t)
  return failure.reason === '' ? t('installFailureGeneric') : failure.reason
}

/** The package the install is about: its name, one-liner, and version, as the Host read them before installing. */
function SubjectCard({ subject, t }: { readonly subject: InstallSubject; readonly t: Translate }): ReactNode {
  const title = subject.name ?? subject.spec
  const kindKey = SUBJECT_KIND_KEYS[subject.kind]
  const description = subject.description ?? (kindKey === undefined ? undefined : t(kindKey))
  return (
    <div className={css.subject} data-install-subject={subject.spec}>
      <p className={css.subjectName}>{title}</p>
      {description === undefined ? null : <p className={css.subjectDesc}>{description}</p>}
      {subject.version === undefined ? null : <p className={css.subjectMeta}>{t('installVersion', { version: subject.version })}</p>}
    </div>
  )
}

/** Track one install field's composition, including Safari's 10ms post-composition Enter window. */
function useInstallComposition(active: boolean) {
  const composition = useRef({ active: false, until: 0 })
  useEffect(() => { composition.current = { active: false, until: 0 } }, [active])
  return {
    onCompositionStart: () => { composition.current.active = true },
    onCompositionEnd: () => { composition.current = { active: false, until: Date.now() + 10 } },
    onBlur: () => { composition.current = { active: false, until: 0 } },
    isComposing: (event: KeyboardEvent) => event.isComposing || Reflect.get(event, 'keyCode') === 229
      || composition.current.active || Date.now() < composition.current.until,
  }
}

/**
 * The install dialog: the spec and its check, then the installing, installed,
 * and failed screens over the same subject card. A failed run that left
 * install scripts undecided shows them for approval in place of plain retry.
 */
function InstallDialog({
  install, t, onClose, onEditSpec, onRun, onCancel, onReconcile, onToggleDetails, onEnableNow, onApproveBuilds,
  onToggleRegistry, onChooseRegistry, onChangeRegistry, onUseGithubMirror,
}: {
  readonly install: InstallState
  readonly t: Translate
  readonly onClose: () => void
  readonly onEditSpec: (text: string) => void
  readonly onRun: () => void
  readonly onCancel: () => void
  readonly onReconcile: () => void
  readonly onToggleDetails: () => void
  readonly onEnableNow: () => void
  readonly onApproveBuilds: () => void
  readonly onToggleRegistry: () => void
  readonly onChooseRegistry: (choice: RegistryChoice) => void
  /** From the failed screen: back to the spec with the registry options unfolded. */
  readonly onChangeRegistry: () => void
  readonly onUseGithubMirror: () => void
}): ReactNode {
  const errorId = useId()
  const templateHintId = useId()
  const guideId = useId()
  const approvalId = useId()
  const registryId = useId()
  const registryErrorId = useId()
  const [guideOpen, setGuideOpen] = useState(false)
  const [customRegistryDraft, setCustomRegistryDraft] = useState('')
  const { phase } = install
  // The registry options float over the dialog from their toggle, so unfolding them never adds to its height;
  // the store folds them when a run starts, so they show at the spec only.
  const registryToggleRef = useRef<HTMLButtonElement | null>(null)
  const registryPanelRef = useRef<HTMLFieldSetElement | null>(null)
  const registryCustomRef = useRef<HTMLInputElement | null>(null)
  const registryShown = install.registryOpen && phase === 'idle'
  const specComposition = useInstallComposition(install.open && phase === 'idle')
  const registryComposition = useInstallComposition(install.open && registryShown)
  const registryPosition = useAnchoredPosition({
    open: registryShown, anchorRef: registryToggleRef, panelRef: registryPanelRef, align: 'end', gap: 6, margin: 12,
  })
  const registryReady = registryShown && registryPosition !== null
  useEffect(() => {
    if (registryReady && install.registryError) registryCustomRef.current?.focus()
  }, [registryReady, install.registryError])
  // The hook only ever asks to close.
  useDismissOnOutsidePointer(registryToggleRef, registryShown, onToggleRegistry, registryPanelRef)
  useEffect(() => {
    if (!registryShown) return
    // Escape folds the options and goes no further: the dialog under them listens for the same key.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onToggleRegistry()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => { document.removeEventListener('keydown', onKeyDown, true) }
  }, [registryShown, onToggleRegistry])
  if (githubRecoveryRegistry(install) !== undefined) {
    const anotherWay = asksMirror(install)
    return (
      <Modal
        open={install.open}
        onClose={onClose}
        title={t(install.failure?.kind === 'timeout' ? 'installGithubTimeoutTitle' : 'installGithubFailedTitle')}
        closeLabel={t('close')}
        description={t('installGithubFailedDescription')}
        footer={(
          <>
            <Button variant="outline" onClick={onClose}>{t('cancel')}</Button>
            <Button
              variant="primary"
              autoFocus
              onClick={() => {
                // The mirror is already asked, so the form opens with the package-name guide.
                if (anotherWay) setGuideOpen(true)
                onUseGithubMirror()
              }}
            >
              {t(anotherWay ? 'installTryAnotherWay' : 'installUseGithubMirror')}
            </Button>
          </>
        )}
      />
    )
  }
  if (phase === 'idle' || phase === 'checking') {
    const checking = phase === 'checking'
    const empty = install.spec.trim() === ''
    const choice = install.registry
    const resolved = install.registries?.resolved ?? null
    const chosenTitle = choice.kind === 'custom' ? t('registryCustom') : registryText(choice.registry, t, resolved).name
    const inputProblem = install.inputError
    // A check no registry answered names every registry asked; any other refusal reads by its problem.
    const askedByCheck = inputProblem?.registries ?? []
    const inputSentence = inputProblem === null
      ? null
      : inputProblem.problem === 'network' && askedByCheck.length > 1
        ? t('installProblemNetworkAll', { registries: registryList(askedByCheck, t, resolved) })
        : t(INPUT_PROBLEM_KEYS[inputProblem.problem], { reason: inputProblem.reason })
    const templateHint = install.spec === INSTALL_GIT_EXAMPLE
      ? t('installGitTemplateHint')
      : install.spec === INSTALL_PATH_EXAMPLE ? t('installPathTemplateHint') : null
    return (
      <Modal
        open={install.open}
        onClose={onClose}
        title={t('installTitle')}
        closeLabel={t('close')}
        {...install.mirrorRecovery ? {} : { description: t('installDescription') }}
        className={css.installDialog as string}
        contentClassName={css.installContent as string}
        footer={(
          <div className={css.installFooter}>
            <p className={css.installSafety} role="note">
              <IconWarningOutline16 size={14} aria-hidden="true" />
              <span className={css.installSafetyText}>
                <span>{t('installGuideSafety')}</span>
                <span>{t('installUpgradeNotice')}</span>
              </span>
            </p>
            <Button variant="primary" className={css.wide} disabled={checking || empty} aria-busy={checking} onClick={onRun}>
              {checking ? <StateDot state="ongoing" /> : null}
              {t(checking ? 'installChecking' : 'installRun')}
            </Button>
          </div>
        )}
      >
        <div className={css.installBody}>
          <div className={css.installField}>
            <input
              type="text"
              autoFocus={install.mirrorRecovery === true}
              value={install.spec}
              placeholder={t('installSpecPlaceholder')}
              disabled={checking}
              aria-label={t(install.mirrorRecovery ? 'installPackageLabel' : 'installSpecLabel')}
              aria-invalid={install.inputError !== null}
              aria-describedby={inputSentence !== null ? errorId : templateHint !== null ? templateHintId : undefined}
              onChange={(event) => { onEditSpec(event.currentTarget.value) }}
              onCompositionStart={specComposition.onCompositionStart}
              onCompositionEnd={specComposition.onCompositionEnd}
              onBlur={specComposition.onBlur}
              onKeyDown={(event) => {
                if (specComposition.isComposing(event.nativeEvent)) return
                if (event.key === 'Enter' && !empty && !checking) onRun()
              }}
            />
          </div>
          {inputSentence === null
            ? null
            : <p id={errorId} className={css.inputError} role="alert">{inputSentence}</p>}
          {inputSentence === null && templateHint !== null
            ? <p id={templateHintId} className={css.templateHint} role="status">{templateHint}</p>
            : null}
          <div className={css.optionsRow}>
            <button
              type="button"
              className={css.guideToggle}
              aria-expanded={guideOpen}
              aria-controls={guideId}
              onClick={() => { setGuideOpen(open => !open) }}
            >
              <IconChevronDownOutline14 className={css.guideChevron} aria-hidden="true" />
              <span>{t(guideOpen ? 'installGuideHide' : 'installGuideToggle')}</span>
            </button>
            <button
              ref={registryToggleRef}
              type="button"
              className={css.registryToggle}
              aria-expanded={install.registryOpen}
              aria-controls={registryId}
              aria-haspopup="dialog"
              disabled={checking}
              onClick={onToggleRegistry}
            >
              <span>{t('registryToggle')}</span>
              {' '}
              <span className={css.registryChosen}>{chosenTitle}</span>
              <IconChevronDownOutline14 className={css.guideChevron} aria-hidden="true" />
            </button>
          </div>
          {guideOpen
            ? (
              <div id={guideId} className={css.guide} data-install-guide>
                <p className={css.guideIntro}>{t('installGuideIntro')}</p>
                <p className={css.guideNote}>{t('installGuideIdNote')}</p>
                <ol className={css.guideList}>
                  {GUIDE_EXAMPLES.map(({ key, titleKey, exampleKey, hintKey }) => (
                    <li key={key} className={css.guideItem}>
                      <div className={css.guideMain}>
                        <span className={css.guideTitle}>{t(titleKey)}</span>
                        <span className={css.guideHint}>{t(hintKey)}</span>
                        <span className={css.guideExample}>
                          <span className={css.guideExampleLabel}>{t('installGuideExampleLabel')}</span>
                          <code>{t(exampleKey)}</code>
                        </span>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={t('installGuideFillAria', { example: t(exampleKey) })}
                        disabled={checking}
                        onClick={() => { onEditSpec(t(exampleKey)) }}
                      >
                        {t('installGuideFill')}
                      </Button>
                    </li>
                  ))}
                </ol>
              </div>
            )
            : null}
          {registryShown
            ? createPortal(
              <fieldset
                ref={registryPanelRef}
                id={registryId}
                className={css.registry}
                style={registryPosition ?? { visibility: 'hidden', left: 0, top: 0 }}
                data-install-registry
                aria-label={t('registryLegend')}
                onKeyDown={(event) => {
                  if (event.key !== 'Tab' || event.ctrlKey || event.altKey || event.metaKey || event.nativeEvent.isComposing) return
                  event.preventDefault()
                  event.stopPropagation()
                  const radio = event.currentTarget.querySelector<HTMLInputElement>('input[type="radio"]:checked')
                  const field = registryCustomRef.current
                  if (event.shiftKey && event.target === field) radio?.focus()
                  else if (!event.shiftKey && event.target !== field) field?.focus()
                  else {
                    onToggleRegistry()
                    registryToggleRef.current?.focus()
                  }
                }}
              >
                {offeredRegistries(install.registries).map((registry) => {
                  const checked = choice.kind === 'offered' && choice.registry === registry
                  return (
                    <label key={registry ?? ''} className={css.registryOption} data-checked={checked}>
                      <input type="radio" name={registryId} checked={checked} onChange={() => {
                        if (choice.kind === 'custom') setCustomRegistryDraft(choice.url)
                        onChooseRegistry({ kind: 'offered', registry })
                      }} />
                      <span className={css.registryTitle}>{registryOption(registry, t, resolved)}</span>
                    </label>
                  )
                })}
                <div className={css.registryOption} data-checked={choice.kind === 'custom'}
                  onClick={(event) => {
                    // Keep label activation from moving focus back to the radio.
                    if (!(event.target instanceof HTMLInputElement)) event.preventDefault()
                    registryCustomRef.current?.focus()
                  }}>
                  <label className={css.registryCustomPick}>
                    <input
                      type="radio"
                      name={registryId}
                      checked={choice.kind === 'custom'}
                      onChange={() => {
                        onChooseRegistry({ kind: 'custom', url: customRegistryDraft })
                        registryCustomRef.current?.focus()
                      }}
                    />
                    <span className={css.registryTitle}><span>{t('registryCustom')}</span></span>
                  </label>
                  <input
                    ref={registryCustomRef}
                    type="text"
                    className={css.registryCustomField}
                    aria-label={t('registryCustom')}
                    placeholder={t('registryCustomPlaceholder')}
                    value={choice.kind === 'custom' ? choice.url : customRegistryDraft}
                    aria-invalid={install.registryError}
                    aria-describedby={install.registryError ? registryErrorId : undefined}
                    onFocus={() => {
                      if (pointerModality() && choice.kind !== 'custom') onChooseRegistry({ kind: 'custom', url: customRegistryDraft })
                    }}
                    onChange={(event) => { onChooseRegistry({ kind: 'custom', url: event.currentTarget.value }) }}
                    onCompositionStart={registryComposition.onCompositionStart}
                    onCompositionEnd={registryComposition.onCompositionEnd}
                    onBlur={registryComposition.onBlur}
                    onKeyDown={(event) => {
                      if (registryComposition.isComposing(event.nativeEvent)) return
                      if (event.key === 'Enter' && !empty) onRun()
                    }}
                  />
                  {install.registryError
                    ? <p id={registryErrorId} className={css.inputError} role="alert">{t('registryCustomInvalid')}</p>
                    : null}
                  <span className={css.registryHint}>{t('registryCustomHint')}</span>
                </div>
              </fieldset>,
              document.body,
            )
            : null}
        </div>
      </Modal>
    )
  }
  const heading = t(SCREEN_TITLE_KEYS[phase])
  const pending = isInstallPending(phase)
  const cancellable = phase === 'starting' || phase === 'running' || phase === 'unconfirmed'
  const stoppable = cancellable || phase === 'failed' || phase === 'unknown'
  const failure = install.failure
  const uncertainty = failure?.uncertainty
  const uncertaintyText = failure?.uncertainty === undefined ? null : t(({
    result: 'installResultUnconfirmed',
    cancellation: phase === 'applying' ? 'installApplyingCancellationError' : 'installCancelUnconfirmed',
    acceptance: 'installAwaitingAcceptance',
  } as const)[failure.uncertainty], { reason: failure.reason })
  const pendingBuilds = phase === 'failed' ? install.failure?.pendingBuilds ?? [] : []
  const approvable = pendingBuilds.length > 0
  const firstRun = install.runs[0]
  // The registries the Host asked, once there is more than one: the attempt under way while it runs, a badge on each run.
  const asked = install.attempts !== null && install.attempts.registries.length > 1 ? install.attempts : null
  const current = asked === null ? undefined : asked.registries.at(-1)
  const previous = asked === null ? undefined : asked.registries.at(-2)
  const resolved = install.registries?.resolved ?? null
  const attemptLine = pending && asked !== null && current !== undefined && previous !== undefined
    ? t('installAttempt', {
      previous: registryText(previous, t, resolved).name, registry: registryText(current, t, resolved).name,
      index: String(asked.registries.length), total: String(asked.total),
    })
    : null
  // Another registry is worth offering only for a failure the Host laid at the one it asked.
  const changeable = phase === 'failed' && !approvable && install.failure?.failedAt === 'registry'
  return (
    <Modal open={install.open} onClose={onClose} title={heading} headless className={css.installDialog as string}>
      <div className={css.wizard} data-install-phase={phase}>
        <div className={css.wizardHead}>
          {phase === 'done'
            ? <span />
            : (
              <button type="button" className={css.wizardBack} aria-label={t(pending ? 'installCancelAndEdit' : 'installEditAria')} disabled={!stoppable} onClick={onCancel}>
                <IconChevronLeftOutline14 aria-hidden="true" />
                <span>{t(pending ? 'installCancelAndEdit' : 'installEdit')}</span>
              </button>
            )}
          <button
            type="button"
            className={css.wizardClose}
            aria-label={t(cancellable ? 'installCloseCancels' : 'close')}
            onClick={onClose}
          >
            <IconCloseOutline16 size={14} />
          </button>
        </div>
        <div className={css.wizardScroll}>
          <div className={css.wizardHero}>
            <span className={css.wizardIcon} data-state={pending ? 'ongoing' : phase === 'done' ? 'done' : 'error'} aria-hidden="true">
              {pending
                ? <StateDot state="ongoing" size={28} />
                : phase === 'done' ? <IconCheckOutline16 size={28} /> : <IconWarningOutline16 size={28} />}
            </span>
            <h2 className={css.wizardTitle} role={phase === 'failed' ? 'alert' : 'status'}>{heading}</h2>
            {phase === 'failed' ? <p className={css.wizardSub}>{failureText(install.failure, t, install)}</p> : null}
            {attemptLine === null ? null : <p className={css.wizardSub}>{attemptLine}</p>}
            {uncertaintyText === null ? null : <p className={css.wizardSub} role="alert">{uncertaintyText}</p>}
            {phase === 'unknown' ? <p className={css.wizardSub}>{t('installUnknownDescription')}</p> : null}
          </div>
          {install.subject === null ? null : <SubjectCard subject={install.subject} t={t} />}
          {approvable
            ? (
              <section className={css.approval} role="group" aria-labelledby={approvalId} data-install-approval>
                <h3 id={approvalId} className={css.approvalTitle}>{t('installApprovalTitle')}</h3>
                <p className={css.approvalText}>{t('installApprovalDescription')}</p>
                <ul className={css.approvalList}>
                  {pendingBuilds.map(name => <li key={name}><code>{name}</code></li>)}
                </ul>
                <p className={css.approvalText}>{t('installApprovalConsequence')}</p>
                <p className={css.approvalCaution}>{t('installApprovalCaution')}</p>
                <Button variant="primary" className={css.wide} onClick={onApproveBuilds}>{t('installApproveAndRetry')}</Button>
              </section>
            )
            : null}
          {phase === 'done' && install.installed === null
            ? <p className={css.result} role="status">{t('installDoneNothing')}</p>
            : null}
          {phase === 'done' && install.restartRequired
            ? <p className={css.resultWarn} role="status">{t('installDoneRestart')}</p>
            : null}
          {phase === 'done' && install.approvedBuilds.length > 0
            ? <p className={css.result} role="status">{t('installDoneApproved', { names: install.approvedBuilds.join(', ') })}</p>
            : null}
          <div className={css.wizardFoot}>
            <button type="button" className={css.detailsToggle} aria-expanded={install.detailsOpen} onClick={onToggleDetails}>
              <span>{t(install.detailsOpen ? 'installDetailsHide' : 'installDetailsShow')}</span>
              <IconChevronDownOutline14 className={css.detailsChevron} aria-hidden="true" />
            </button>
            {uncertainty === 'result' ? <Button variant="outline" size="sm" className={css.footAction} onClick={onReconcile}>{t('installReconcile')}</Button> : null}
            {pending
              ? (
                <Button variant="outline" size="sm" className={css.footAction} disabled={!cancellable} onClick={onCancel}>
                  {t(phase === 'cancelling' ? 'installCancelling' : 'installCancel')}
                </Button>
              )
              : null}
            {phase === 'failed' && !approvable
              ? (
                <span className={css.wizardActions}>
                  {changeable
                    ? <Button variant="outline" size="sm" className={css.footAction} onClick={onChangeRegistry}>{t('installChangeRegistry')}</Button>
                    : null}
                  <Button variant="primary" size="sm" className={css.footAction} onClick={onRun}>{t('installRetry')}</Button>
                </span>
              )
              : null}
          </div>
          {install.detailsOpen
            ? (
              <div className={css.detailsBody}>
                <p className={css.installLocation}>{firstRun === undefined ? t('terminalNoOutput') : t('installLocation', { dir: firstRun.cwd })}</p>
                {install.runs.map((run, index) => {
                  const registry = asked?.registries[index]
                  return (
                    <div key={run.jobId} className={css.run}>
                      {registry === undefined
                        ? null
                        : <p className={css.attemptBadge}>{t('installAttemptBadge', { index: String(index + 1), registry: registryText(registry, t, resolved).name })}</p>}
                      <TerminalBlock
                        command={run.command}
                        output={run.output}
                        running={run.exitCode === undefined}
                        exitCode={run.exitCode}
                        maxLines={INSTALL_TERMINAL_LINES}
                        labels={{ ...terminalLabels(t), ...phase === 'cancelling' ? { failed: t('installCancelledShort') } : {} }}
                        className={css.terminal}
                      />
                    </div>
                  )
                })}
              </div>
            )
            : null}
          {phase !== 'done'
            ? null
            : install.installed !== null
              ? <Button variant="primary" className={css.wide} disabled={install.enabling} aria-busy={install.enabling} onClick={onEnableNow}>{t('installEnableNow')}</Button>
              : <Button variant="primary" className={css.wide} onClick={onClose}>{t('installClose')}</Button>}
        </div>
      </div>
    </Modal>
  )
}

/** The confirmation an uninstall waits on. */
function ConfirmDialog({ name, t, onConfirm, onCancel }: {
  readonly name: string
  readonly t: Translate
  readonly onConfirm: () => void
  readonly onCancel: () => void
}): ReactNode {
  return (
    <Modal
      open
      onClose={onCancel}
      title={t('confirmUninstallTitle', { name })}
      closeLabel={t('close')}
      description={t('confirmUninstallDescription')}
      footer={(
        <>
          <Button variant="outline" onClick={onCancel}>{t('cancel')}</Button>
          <Button variant="primary" className={css.dangerButton} onClick={onConfirm}>
            {t('confirmUninstall')}
          </Button>
        </>
      )}
    />
  )
}

/** Render the plugin manager: the official plugins and installed bundles, their pages, the install dialog, and the confirmation. */
export function PluginManagerPage(props: PluginManagerPageProps): ReactNode {
  const { t, resolveText, ensure, renderSlot, composition } = props
  const state = props.usePluginManager(snapshot => snapshot)
  const ledger = props.useConfigLedger(snapshot => snapshot)
  // What is expanded; a package that leaves the list (uninstalled) collapses back to the rows.
  const [view, setView] = useState<View>({ kind: 'list' })
  const [filter, setFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'enabled' | 'disabled' | 'pending'>('all')
  useEffect(() => { ensure() }, [ensure])
  // A package an install just enabled: scroll it into view and mark it for a moment.
  const { highlight, clearHighlight } = { highlight: state.highlight, clearHighlight: props.clearHighlight }
  useEffect(() => {
    if (highlight === null) return
    const card = document.querySelector(`[data-plugin-package="${highlight}"]`)
    if (card !== null && typeof card.scrollIntoView === 'function') card.scrollIntoView({ block: 'center', behavior: 'smooth' })
    const timer = setTimeout(clearHighlight, HIGHLIGHT_MS)
    return () => { clearTimeout(timer) }
  }, [highlight, clearHighlight])
  const noticeLine = state.notice === null || state.notice.kind === 'refresh-failed' ? null : noticeText(state.notice, t)

  // The page manages what the person installed, what the installation ships for them to switch on, and a
  // selected name the Host cannot read; the installation's other bundles are inspected in the Settings
  // Plugins section's Plugin list tab.
  const listed = state.packages.filter(pkg => !BUILTIN_PROFILE_BUNDLES.has(pkg.name)
    && (pkg.installed || pkg.optional || pkg.error !== undefined))
  const loaded = state.status === 'ready' || state.status === 'error'
  const refreshing = state.refreshStatus === 'refreshing'
  const openPkg = view.kind === 'package' || view.kind === 'row' ? listed.find(pkg => pkg.name === view.name) : undefined
  const openItem = view.kind === 'item' ? ledger.items.find(item => item.id === view.id) : undefined
  const openRow = view.kind === 'row' && openPkg !== undefined ? openPkg.rows.find(row => row.rowId === view.rowId) : undefined
  const setRowEnabled = (row: PackageRow, enabled: boolean): void => {
    /* v8 ignore next -- a row without a live entry has its switch disabled */
    if (row.entryId !== undefined) props.setRowEnabled(row.entryId, enabled)
  }
  const configure = (pkg: PackageView): RowConfigure => ({
    has: row => ledger.rows.has(rowConfigKey(pkg.name, row.rowId)),
    open: (row) => { setView({ kind: 'row', name: pkg.name, rowId: row.rowId }) },
  })

  // One list, one entity per row: the bundles the Host lists beside the official plugins that registered a page.
  type Entity = { readonly kind: 'package'; readonly pkg: PackageView } | { readonly kind: 'item'; readonly item: OfficialItem }
  const itemTitle = (item: OfficialItem): string => item.labelText === undefined ? item.label : resolveText(item.labelText) ?? item.label
  const itemEntry = (item: OfficialItem) => composition.entries.find(entry => entry.id === item.id)
  const entityTitle = (entity: Entity): string => entity.kind === 'package' ? packageText(entity.pkg, resolveText).title : itemTitle(entity.item)
  const entityPending = (entity: Entity): boolean => {
    if (entity.kind === 'package') {
      const row = composition.bundleRows.find(bundle => bundle.name === entity.pkg.name)
      return row !== undefined && row.desired !== row.observed
    }
    const entry = itemEntry(entity.item)
    return entry !== undefined && effective(entry.desired) !== effective(entry.observed)
  }
  const entityEnabled = (entity: Entity): boolean => entity.kind === 'package'
    ? entity.pkg.enabled
    : itemEntry(entity.item)?.live?.enabled === true
  const entities: readonly Entity[] = [
    ...listed.map((pkg): Entity => ({ kind: 'package', pkg })),
    ...ledger.items.map((item): Entity => ({ kind: 'item', item })),
  ].sort((a, b) => entityTitle(a).localeCompare(entityTitle(b)))
  const needle = filter.trim().toLowerCase()
  const matches = (entity: Entity): boolean => {
    if (statusFilter === 'pending' && !entityPending(entity)) return false
    if (statusFilter === 'enabled' && !entityEnabled(entity)) return false
    if (statusFilter === 'disabled' && entityEnabled(entity)) return false
    if (needle === '') return true
    const haystack = entity.kind === 'package'
      ? [entityTitle(entity), entity.pkg.name, packageText(entity.pkg, resolveText).description ?? '']
      : [entityTitle(entity), entity.item.id]
    return haystack.some(value => value.toLowerCase().includes(needle))
  }
  const shown = entities.filter(matches)

  const toggleLabel = (expanded: boolean, title: string) => expanded ? t('listCollapse', { name: title }) : t('openDetail', { name: title })
  const pendingTag = <Tag className={css.statusTag} tone="warning">{t('listPending')}</Tag>

  const packageRow = (pkg: PackageView): ReactNode => {
    const { title, description, beta } = packageText(pkg, resolveText)
    const status = packageStatus(pkg)
    const startup = composition.bundleRows.find(bundle => bundle.name === pkg.name)
    const expanded = openPkg?.name === pkg.name
    const busy = state.busy.includes(pkg.name)
    const stateKey = status === 'problem' ? 'problem' : pkg.enabled ? 'enabled' : pkg.installed ? 'idle' : 'available'
    return (
      <EntityRow
        key={`pkg:${pkg.name}`}
        icon={<PackageArtwork key={pkg.meta?.icon} src={pkg.meta?.icon} />}
        title={title}
        description={description}
        expanded={expanded}
        toggleLabel={toggleLabel(expanded, title)}
        onToggle={() => { setView(expanded ? { kind: 'list' } : { kind: 'package', name: pkg.name }) }}
        badges={(
          <>
            <Tag className={css.statusTag} tone="neutral">{t('listKindBundle')}</Tag>
            {beta ? <Tag className={css.statusTag} tone="info">{t('statusBeta')}</Tag> : null}
            {status === 'problem' ? <Tag className={css.statusTag} tone="danger">{t('statusProblem')}</Tag> : null}
            {status === 'problem' ? null : <Tag className={css.statusTag} tone={stateKey === 'enabled' ? 'success' : 'outline'}>{t(stateKey === 'enabled' ? 'listEnabled' : stateKey === 'available' ? 'listAvailable' : 'listIdle')}</Tag>}
            {startup !== undefined && startup.desired !== startup.observed ? pendingTag : null}
          </>
        )}
        attrs={{
          'data-plugin-package': pkg.name,
          'data-plugin-status': status,
          ...state.highlight === pkg.name ? { 'data-plugin-highlight': '' } : {},
        }}
        controls={(
          <>
            <EntityControl label={t('listCurrent')}>
              <EnableSwitch pkg={pkg} title={title} t={t} busy={busy} onSetEnabled={enabled => { props.setEnabled(pkg.name, enabled) }} />
            </EntityControl>
            {composition.persist
              ? (
                <EntityControl label={t('listStartup')}>
                  <input
                    type="checkbox"
                    className={css.startupCheck}
                    aria-label={t('listStartupBundle', { name: title })}
                    checked={startup?.desired ?? pkg.enabled}
                    onChange={event => { composition.setBundleDesired(pkg.name, event.target.checked) }}
                  />
                </EntityControl>
              )
              : null}
          </>
        )}
        detail={openRow !== undefined
          ? (
            <RowDetail
              pkg={pkg}
              row={openRow}
              t={t}
              resolveText={resolveText}
              renderSlot={renderSlot}
              onBack={() => { setView({ kind: 'package', name: pkg.name }) }}
            />
          )
          : (
            <PackageDetail
              pkg={pkg}
              t={t}
              resolveText={resolveText}
              busy={busy}
              rowBusy={row => row.entryId !== undefined && state.busy.includes(rowKey(row.entryId))}
              configured={ledger.bundles.has(pkg.name)}
              configure={configure(pkg)}
              renderSlot={renderSlot}
              onUninstall={() => { props.uninstall(pkg.name) }}
              onSetRowEnabled={setRowEnabled}
              onBack={() => { setView({ kind: 'list' }) }}
            />
          )}
      />
    )
  }

  const itemRow = (item: OfficialItem): ReactNode => {
    const title = itemTitle(item)
    const entry = itemEntry(item)
    const expanded = openItem?.id === item.id
    return (
      <EntityRow
        key={`item:${item.id}`}
        icon={itemArtwork(item.id)}
        title={title}
        description={renderSlot('plugins.item', { view: 'summary' }, { only: item.id })}
        expanded={expanded}
        toggleLabel={toggleLabel(expanded, title)}
        onToggle={() => { setView(expanded ? { kind: 'list' } : { kind: 'item', id: item.id }) }}
        badges={(
          <>
            <Tag className={css.statusTag} tone="neutral">{t('listKindItem')}</Tag>
            {entry?.live === undefined ? null : <Tag className={css.statusTag} tone={entry.live.enabled ? 'success' : 'outline'}>{t(entry.live.enabled ? 'listRunning' : 'listStopped')}</Tag>}
            {entry !== undefined && effective(entry.desired) !== effective(entry.observed) ? pendingTag : null}
          </>
        )}
        attrs={{ 'data-plugin-item': item.id }}
        controls={entry === undefined ? undefined : (
          <>
            {(() => {
              const liveEntry = entry.live
              return liveEntry === undefined
                ? <span className={css.entityControl}><span className={css.entityControlLabel}>{t('listCurrent')}</span><span className={css.entityNoLive}>{t('listNoLiveEntry')}</span></span>
                : (
                  <EntityControl label={t('listCurrent')}>
                    <Switch
                      checked={liveEntry.enabled}
                      label={t('listCurrentEnable', { name: title })}
                      disabled={liveEntry.readOnly}
                      onChange={enabled => { props.setRowEnabled(liveEntry.entryId, enabled) }}
                    />
                  </EntityControl>
                )
            })()}
            {composition.persist
              ? (
                <EntityControl label={t('listStartup')}>
                  <select
                    className={css.startupSelect}
                    aria-label={t('listStartupEntry', { name: title })}
                    value={entry.desired}
                    onChange={event => { composition.setEntryDesired(item.id, event.target.value as EntryChoice, entry.moduleName) }}
                  >
                    {ENTRY_CHOICES.map(choice => <option key={choice} value={choice}>{t(choice === 'default' ? 'listStartupDefault' : choice === 'on' ? 'listStartupOn' : 'listStartupOff')}</option>)}
                  </select>
                </EntityControl>
              )
              : null}
          </>
        )}
        detail={<ItemDetail item={item} t={t} resolveText={resolveText} renderSlot={renderSlot} onBack={() => { setView({ kind: 'list' }) }} />}
      />
    )
  }

  return (
    <section className={css.page} data-plugin-panel aria-busy={state.status === 'loading' || refreshing}>
      <header className={css.pageHead}>
        <div className={css.toolbar}>
          {loaded && entities.length > 4
            ? (
              <>
                <Input
                  type="search"
                  className={css.listFilter as string}
                  placeholder={t('listFilter')}
                  aria-label={t('listFilter')}
                  value={filter}
                  onChange={event => { setFilter(event.target.value) }}
                />
                <select className={css.statusFilter} aria-label={t('listStatusAll')} value={statusFilter} onChange={event => { setStatusFilter(event.target.value as typeof statusFilter) }}>
                  <option value="all">{t('listStatusAll')}</option>
                  <option value="enabled">{t('listStatusEnabled')}</option>
                  <option value="disabled">{t('listStatusDisabled')}</option>
                  <option value="pending">{t('listStatusPending')}</option>
                </select>
              </>
            )
            : null}
          <button type="button" className={css.iconButton} aria-label={t('refresh')} title={t('refresh')} aria-busy={refreshing} disabled={!loaded || refreshing} onClick={props.refresh}>
            <span className={css.iconWrap} aria-hidden="true">
              {refreshing ? <StateDot state="ongoing" size={18} /> : <IconRefreshOutline16 />}
            </span>
          </button>
          <Button variant="primary" size="sm" icon={<IconPlusOutline16 size={13} />} disabled={!loaded} onClick={props.openInstall}>{t(state.install.requestId === undefined ? 'addPlugin' : 'installViewTask')}</Button>
        </div>
      </header>
      {state.status === 'loading' ? <ListSkeleton label={t('loading')} /> : null}
      {state.status === 'unavailable' ? (
        <p className={`${css.status} ${css.statusWithDot}`} role="status">
          <StateDot state="idle" />{t('unavailable')}
        </p>
      ) : null}
      {state.notice === null || noticeLine === null
        ? null
        : (
          <Toast
            key={state.notice.seq}
            text={noticeLine}
            icon={<IconWarningOutline16 />}
            holdMs={toastHoldMs(noticeLine)}
            onDone={props.dismissNotice}
          />
        )}
      {loaded
        ? entities.length === 0 && state.status !== 'error'
          ? <p className={css.empty}>{t('empty')}</p>
          : (
            <>
              <ul className={css.entityList} data-plugin-list>
                {shown.map(entity => entity.kind === 'package' ? packageRow(entity.pkg) : itemRow(entity.item))}
              </ul>
              {shown.length === 0 && entities.length > 0 ? <p className={css.empty}>{t('listEmptyFiltered')}</p> : null}
              {/* A failed package read trails the list it left incomplete. */}
              {state.status === 'error' && !refreshing
                ? (
                  <div className={css.failure}>
                    <p className={css.statusWithDot} role="alert">
                      <StateDot state="error" />{t(state.refreshStatus === 'failed' ? 'refreshError' : 'error')}
                    </p>
                    <Button variant="outline" size="sm" onClick={props.refresh}>{t('retry')}</Button>
                  </div>
                )
                : null}
            </>
          )
        : null}
      <InstallDialog
        install={state.install}
        t={t}
        onClose={props.closeInstall}
        onEditSpec={props.editInstallSpec}
        onRun={props.runInstall}
        onCancel={props.cancelInstall}
        onReconcile={props.reconcileInstall}
        onToggleDetails={props.toggleInstallDetails}
        onEnableNow={props.enableInstalled}
        onApproveBuilds={props.approveBuildsAndRetry}
        onToggleRegistry={props.toggleRegistryOptions}
        onChooseRegistry={props.chooseRegistry}
        onChangeRegistry={props.changeRegistry}
        onUseGithubMirror={props.useGithubMirror}
      />
      {state.confirm === null
        ? null
        : (
          <ConfirmDialog
            name={packageText(
              state.packages.find(pkg => pkg.name === state.confirm?.packageName) ?? { name: state.confirm.packageName },
              props.resolveText,
            ).title}
            t={t}
            onConfirm={props.confirm}
            onCancel={props.cancelConfirm}
          />
        )}
    </section>
  )
}
