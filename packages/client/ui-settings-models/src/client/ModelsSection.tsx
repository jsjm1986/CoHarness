/**
 * Models settings section: the provider rows joined from the configurable
 * directory, settings namespaces, and credential states, with one editor
 * card at a time. Rows expose only confirmed API-key state through accessible
 * solid configured or missing dots. A whole-section provider without a
 * configured key renders as its open setup card instead of a row, but only in
 * the first-run posture — no provider on the page can serve requests yet — and
 * only until the user closes that card; the add flow is a card carrying the
 * dormant-provider select. Each card kind owns its own open state, so closing
 * one never discards a draft in another. Every mutation writes through the
 * wire, while a provider removal first requires confirmation; the page
 * re-renders from pushed invalidations or the post-apply reload.
 */

import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import { Button, IconPlusOutline16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import { CustomProviderCard } from './CustomProviderCard.tsx'
import { deriveKeyRef, messageOf, protocolChoices, providerUsable } from './store.ts'
import type { ModelsSettingsStore, ProviderRow } from './store.ts'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import { ProviderEditor, type ProviderEditorProps } from './ProviderEditor.tsx'
import type { ProjectModelsApi } from './project-store.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Project Provider ids are persisted in a slug column and become runtime route suffixes. */
const PROJECT_PROVIDER_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/** Injected dependencies of {@link ModelsSection} (slot `inject`). */
export interface ModelsSectionInjected {
  /** The page store (loaded on mount, refreshed on pushed invalidations). */
  controller: ModelsSettingsStore
  hooks: {
    /** Page snapshot bound by the UI renderer as useSnapshot. */
    snapshot: ModelsSettingsStore['store']
  }
  /** Wire faces the editor writes through. */
  api: Pick<IApiClient, 'settings' | 'credentials' | 'llm'>
  /** Settings schema and immutable path callbacks. */
  schema: SettingsSchemaOperations
  /** Section copy. */
  t: (key: keyof typeof en) => string
  /** Which ownership layer this surface edits. Personal is the default. */
  managementScope?: 'personal' | 'organization' | 'project'
  /** Project id paired with project-owned Provider settings. */
  projectId?: number
  /** Resolve a cached project-owned Models binding for the requested scope. */
  projectBinding?: (projectId: number) => {
    controller: ModelsSettingsStore
    api: ProjectModelsApi
  } | undefined
  /** Route pattern used by the custom-provider creation card. */
  providerIdPattern?: RegExp
}

/**
 * Props delivered by the slot outlet: the inject face spread flat (the
 * renderer erases the share boundary at the render call).
 */
export type ModelsSectionProps = Partial<SettingsSectionOwnerProps> & Partial<InjectFace<ModelsSectionInjected>>

type ModelsSectionFace = InjectFace<ModelsSectionInjected> & Partial<SettingsSectionOwnerProps>

/** Provider identity shared by row actions and confirmation copy. */
export interface ProviderIdentity {
  /** Stable provider route id. */
  provider: string
  /** Human-facing provider name. */
  displayName: string
}

/** One existing row or dormant directory entry addressed by an editor action. */
interface EditorTarget extends ProviderIdentity {
  settingsNs: string
  settingsPath: readonly string[]
  /** Writable credential identified under this page's conventional reference. */
  credentialRef?: string
  /** The adapter reports this route as one it does not ship (see {@link ProviderEditorProps.declared}). */
  declared?: boolean
}

/** Values that vary around the shared provider-editor rendering. */
interface ProviderEditorRenderProps extends Pick<
  ProviderEditorProps,
  'namespace' | 'schema' | 'api' | 't' | 'readOnly' | 'credentialScope' | 'projectId' | 'onClose'
> {
  target: EditorTarget
}

/** Render an editor for either the setup posture or an expanded provider row. */
function renderProviderEditor({ target, ...props }: ProviderEditorRenderProps): ReactNode {
  return (
    <ProviderEditor
      provider={target.provider}
      displayName={target.displayName}
      settingsPath={target.settingsPath}
      {...target.declared === true ? { declared: true } : {}}
      {...props}
    />
  )
}

/**
 * Remove one user-added provider and its page-managed credential. Credential
 * removal comes first so a second-step failure leaves the provider row visible
 * and the whole operation safely retryable; both unsets are idempotent.
 * The settings removal names the profile rather than rebuilding its whole
 * namespace from a partial view.
 * @param api - settings and credential wire faces.
 * @param controller - the page store to refresh.
 * @param target - the provider's settings address and optional managed credential.
 * @returns the failure message, or undefined once the write and reload landed.
 */
export async function removeProviderProfile(
  api: Pick<IApiClient, 'settings' | 'credentials'>,
  controller: ModelsSettingsStore,
  target: { settingsNs: string; settingsPath: readonly string[]; credentialRef?: string },
): Promise<string | undefined> {
  try {
    if (target.credentialRef !== undefined) {
      const credential = await api.credentials.unset({ ref: target.credentialRef })
      if (!credential.result.ok) return credential.result.error.message
    }
    const response = await api.settings.mutate({
      ns: target.settingsNs,
      ops: [{ op: 'unset', path: [...target.settingsPath] }],
    })
    if (!response.result.ok) return response.result.error.message
  } catch (error) {
    // The transport rejected rather than answering; the caller must be able
    // to retry the idempotent operation instead of the row silently staying.
    return messageOf(error)
  }
  await controller.load()
  return undefined
}

/**
 * Whether a whole-section provider still needs its first key: an unconfigured
 * credential opens the setup card instead of showing a row. This is the
 * first-run posture alone — a user who can already reach some provider gets an
 * ordinary row with the missing-key dot, since nothing here is blocking them.
 * @param row - the joined provider row.
 * @param anyUsable - whether any joined row can already serve requests.
 * @returns whether to render the setup card.
 */
export function needsSetup(row: ProviderRow, anyUsable: boolean): boolean {
  if (anyUsable) return false
  if (row.entry.settingsPath.length > 0) return false
  return row.credential?.configured !== true
}

function targetOf(row: ProviderRow, managementScope: 'personal' | 'organization' | 'project', projectId?: number): EditorTarget {
  const managedRef = deriveKeyRef(row.entry.provider, managementScope, projectId)
  const credentialRef = row.apiKeyEnv !== undefined
    && row.credential?.configured === true
    && row.credential.writable
    && (managementScope !== 'personal' || row.apiKeyEnv === managedRef)
    ? row.apiKeyEnv
    : undefined
  return {
    provider: row.entry.provider,
    displayName: row.entry.displayName,
    settingsNs: row.entry.settingsNs,
    settingsPath: row.entry.settingsPath,
    ...credentialRef === undefined ? {} : { credentialRef },
    // Absent is not "shipped": an adapter that answers nothing leaves the
    // route-level fields only a declared route owns off the card, exactly as
    // it leaves the custom tag off the row.
    ...row.entry.declared === true ? { declared: true } : {},
  }
}

/** Stable visible and accessible identity for one provider target. */
export function providerTargetLabel(target: ProviderIdentity): string {
  return target.provider === target.displayName
    ? target.provider
    : `${target.displayName} (${target.provider})`
}

/** Replace the one provider placeholder in localized destructive-action copy. */
export function providerCopy(template: string, target: ProviderIdentity): string {
  return template.replace('{provider}', () => providerTargetLabel(target))
}

/**
 * Render the Models section content column.
 * @param props - slot-delivered injected dependencies.
 * @returns the section, or null while the shell has not injected yet.
 */
export function ModelsSection(props: ModelsSectionProps): ReactNode {
  const { controller, useSnapshot, api, schema, t } = props
  if (
    controller === undefined || useSnapshot === undefined || api === undefined
    || schema === undefined || t === undefined
  ) return null
  return (
    <Loaded
      injected={{
        close: props.close ?? (() => {}),
        controller,
        useSnapshot,
        api,
        schema,
        t,
        ...props.managementScope === undefined ? {} : { managementScope: props.managementScope },
        ...props.projectId === undefined ? {} : { projectId: props.projectId },
        ...props.projectBinding === undefined ? {} : { projectBinding: props.projectBinding },
        ...props.settingsScope === undefined ? {} : { settingsScope: props.settingsScope },
        ...props.providerIdPattern === undefined ? {} : { providerIdPattern: props.providerIdPattern },
      }}
    />
  )
}

function Loaded({ injected }: { injected: ModelsSectionFace }): ReactNode {
  const projectRequested = injected.settingsScope === 'project'
  const binding = projectRequested && injected.projectId !== undefined
    ? injected.projectBinding?.(injected.projectId)
    : undefined
  const controller = binding?.controller ?? injected.controller
  const api = binding?.api ?? injected.api
  const { schema, t } = injected
  const managementScope = injected.settingsScope === 'project'
    ? 'project'
    : injected.managementScope ?? 'personal'
  const projectId = injected.projectId
  // The slot's baked hook points at the personal controller because the
  // registration is root-scoped. Project navigation selects a different
  // controller at render time, so subscribe to that controller directly;
  // otherwise the project editor would display and mutate two different
  // snapshots.
  const state = useSyncExternalStore(
    listener => controller.store.subscribe(listener),
    () => controller.store.getSnapshot(),
    () => controller.store.getSnapshot(),
  )
  const projectUnavailable = projectRequested && (binding === undefined
    || state.error === 'project-model-settings-unsupported'
    || state.error === 'project-model-settings-unavailable')
  const [editing, setEditing] = useState<EditorTarget | undefined>(undefined)
  const [adding, setAdding] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<EditorTarget | undefined>(undefined)
  const [deleting, setDeleting] = useState(false)
  const [deleteFailure, setDeleteFailure] = useState<string | undefined>(undefined)
  const [savedTarget, setSavedTarget] = useState<ProviderIdentity | undefined>(undefined)
  const [declaring, setDeclaring] = useState(false)
  const [dismissedSetup, setDismissedSetup] = useState<ReadonlySet<string>>(() => new Set())

  useEffect(() => {
    setEditing(undefined)
    setAdding(false)
    setDeleteTarget(undefined)
    setDeclaring(false)
    setDismissedSetup(new Set())
  }, [managementScope, projectId])

  const announceSaved = (target: ProviderIdentity): void => {
    // Announced only once the refreshed directory is in the snapshot the
    // notice reads its name from: an apply can rename the route, and the
    // target captured when the card opened still carries the old name.
    void controller.load().then(() => { setSavedTarget(target) })
  }

  const closeEditor = (changed: boolean, target: ProviderIdentity): void => {
    setEditing(undefined)
    setAdding(false)
    setDeclaring(false)
    if (changed) announceSaved(target)
  }

  /**
   * Close a setup card, which owns none of the state above: the row-editor,
   * add, and declare cards each own one of those, so clearing them here would
   * discard a draft the user opened beside this card. Dismissal is this card's
   * own — the provider falls back to an ordinary row for the rest of the
   * session, and reopens through Edit.
   */
  const closeSetup = (changed: boolean, target: ProviderIdentity): void => {
    setDismissedSetup(previous => new Set([...previous, target.provider]))
    if (changed) announceSaved(target)
  }

  const closeDelete = (): void => {
    if (deleting) return
    setDeleteTarget(undefined)
    setDeleteFailure(undefined)
  }

  const confirmDelete = (): void => {
    /* v8 ignore next -- the action only renders with a target and is disabled while a deletion is pending */
    if (deleteTarget === undefined || deleting) return
    setDeleting(true)
    setDeleteFailure(undefined)
    void removeProviderProfile(api, controller, deleteTarget)
      .then((failure) => {
        if (failure !== undefined) {
          setDeleteFailure(failure)
          return
        }
        setDeleteTarget(undefined)
      })
      .finally(() => { setDeleting(false) })
  }

  if (projectUnavailable) {
    return (
      <div className={styles['section']}>
        <h2 className={styles['title']}>{t('projectTitle')}</h2>
        <p className={styles['notice']} role="status">{t('projectUnavailable')}</p>
      </div>
    )
  }
  if (state.status === 'idle') void controller.load()
  if (state.status === 'error') {
    /* v8 ignore next -- an error status always carries text; the fallback satisfies the nullable type */
    const errorText = state.error ?? ''
    return (
      <div className={styles['section']}>
        <p className={styles['error']}>{`${t('loadFailed')}: ${errorText}`}</p>
        <button type="button" className={styles['secondaryButton']} onClick={() => { void controller.load() }}>
          {t('retry')}
        </button>
      </div>
    )
  }

  // The saved provider as the directory currently names it. The route id is
  // what the apply cannot change, so it is what the notice is keyed by; a row
  // the same apply removed keeps the captured identity, since nothing newer
  // exists to name it with.
  const savedRow = savedTarget === undefined
    ? undefined
    : state.rows.find(row => row.entry.provider === savedTarget.provider)
  const savedIdentity = savedRow === undefined
    ? savedTarget
    : { provider: savedRow.entry.provider, displayName: savedRow.entry.displayName }

  // One fact decides both first-run postures on this page and the onboarding
  // step: whether the user already has a provider to talk to.
  const scopedRows = state.rows.filter(row => row.entry.management === managementScope)
  const anyUsable = scopedRows.some(providerUsable)
  const organization = managementScope === 'personal'
    ? state.rows.filter(row => row.entry.management === 'organization')
    : []
  const configured = scopedRows.filter(row => row.configured)
  const addable = scopedRows.filter(row => !row.configured)
  // Organization routes are created as new `org-*` profiles. The shared
  // personal directory may still expose dormant adapter routes, but when no
  // such route is addable there is no valid target for the generic action.
  const canAdoptProvider = addable.length > 0
  const addTarget = adding ? editing : undefined
  const addNamespace = addTarget === undefined ? undefined : state.namespaces.get(addTarget.settingsNs)
  // Hand-declared routes live in the pi-ai namespace, which is also the only
  // one whose schema names the protocols one may speak; without it mounted
  // there is nothing to declare and the entry point stays disabled.
  const protocols = protocolChoices(state.namespaces.get('llm-pi-ai'), schema)

  return (
    <div className={styles['section']}>
      <h2 className={styles['title']}>{managementScope === 'project' ? t('projectTitle') : t('title')}</h2>
      <p className={styles['intro']}>{managementScope === 'project' ? t('projectIntro') : t('intro')}</p>
      {!state.writable && state.status === 'ready' ? (
        <p className={styles['notice']}>
          {state.writableReason === 'project' ? t('readOnlyProject')
            : state.writableReason === 'account' ? t('readOnlyAccount')
              : state.writableReason === 'organization' ? t('readOnlyOrganization')
                : state.writableReason === 'deployment' ? t('readOnlyDeployment') : t('readOnly')}
        </p>
      ) : null}
      {savedIdentity === undefined
        ? null
        : (
          <p className={styles['savedNotice']} role="status" aria-live="polite">
            {providerCopy(t('savedProvider'), savedIdentity)}
          </p>
        )}
      {organization.length === 0 ? null : (
        <section className={styles['organizationSection']} aria-labelledby="organization-models-title">
          <div className={styles['organizationHeading']}>
            <h3 id="organization-models-title">{t('organizationTitle')}</h3>
            <span>{t('organizationManaged')}</span>
          </div>
          <ul className={styles['organizationRows']}>
            {organization.map(row => (
              <li key={row.entry.provider} className={styles['organizationCard']}>
                <div className={styles['organizationProvider']}>
                  <span>
                    <strong>{row.entry.displayName}</strong>
                    <code>{row.entry.provider}</code>
                  </span>
                </div>
                {row.catalogFailure === undefined ? (
                  row.models.length === 0
                    ? <p className={styles['organizationEmpty']}>{t('organizationNoModels')}</p>
                    : (
                      <ul className={styles['organizationModels']}>
                        {row.models.map(model => (
                          <li key={model.id}>
                            <span>{model.name}</span>
                            <code>{model.id}</code>
                          </li>
                        ))}
                      </ul>
                    )
                ) : <p className={styles['organizationFailure']}>{t('organizationCatalogFailed')}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}
      <ul className={styles['rows']}>
        {configured.map((row) => {
          const target = targetOf(row, managementScope, projectId)
          const namespace = state.namespaces.get(target.settingsNs)
          /* v8 ignore next -- the join marks a row configured only when its namespace resolved */
          if (namespace === undefined) return null
          if (needsSetup(row, anyUsable) && !dismissedSetup.has(row.entry.provider)) {
            // First-run posture: the provider exists but has no key — the
            // setup card IS its presence on the page, until the user closes it.
            return (
              <li key={row.entry.provider} className={styles['setupCard']}>
                {renderProviderEditor({
                  target,
                  namespace,
                  schema,
                  api,
                  t,
                  readOnly: !state.writable,
                  credentialScope: managementScope,
                  ...projectId === undefined ? {} : { projectId },
                  onClose: (changed) => { closeSetup(changed, target) },
                })}
              </li>
            )
          }
          const open = !adding && editing?.provider === row.entry.provider
          const credentialConfigured = row.credential?.configured === true
          const credentialMissing = !credentialConfigured
            && row.apiKeyEnv !== undefined
            && row.credential?.configured === false
          return (
            <li key={row.entry.provider} className={styles['rowCard']}>
              <div className={styles['rowHead']}>
                <span className={styles['rowIdentity']}>
                  <span className={styles['rowName']}>{row.entry.displayName}</span>
                  {/* Only the adapter can tell a hand-declared route from a
                      shipped one it also has a stored profile for, so the tag
                      follows its answer and stays off when it gives none. */}
                  {row.entry.declared === true
                    ? <span className={styles['rowTag']}>{t('customTag')}</span>
                    : null}
                  {credentialConfigured
                    ? (
                      <span
                        className={`${styles['credentialDot']} ${styles['credentialDotConfigured']}`}
                        role="img"
                        aria-label={t('credentialConfigured')}
                        title={t('credentialConfigured')}
                      />
                    )
                    : credentialMissing
                      ? (
                        <span
                          className={`${styles['credentialDot']} ${styles['credentialDotMissing']}`}
                          role="img"
                          aria-label={t('credentialMissing')}
                          title={t('credentialMissing')}
                        />
                      )
                      : null}
                </span>
                <span className={styles['rowActions']}>
                  <button
                    type="button"
                    className={styles['secondaryButton']}
                    aria-label={providerCopy(t('editProvider'), target)}
                    onClick={() => {
                      setSavedTarget(undefined)
                      // One card at a time: leaving `declaring` set would show
                      // the create card beside this editor, and closing either
                      // one discards the other's draft.
                      setDeclaring(false)
                      setAdding(false)
                      setEditing(open ? undefined : target)
                    }}
                  >
                    {t('edit')}
                  </button>
                  {row.removable
                    ? (
                      <button
                        type="button"
                        className={styles['dangerButton']}
                        aria-label={providerCopy(t('removeProvider'), target)}
                        disabled={!state.writable}
                        onClick={() => {
                          setSavedTarget(undefined)
                          setDeleteFailure(undefined)
                          setDeleteTarget(target)
                        }}
                      >
                        {t('remove')}
                      </button>
                    )
                    : null}
                </span>
              </div>
              {open
                ? renderProviderEditor({
                  target,
                  namespace,
                  schema,
                  api,
                  t,
                  readOnly: !state.writable,
                  credentialScope: managementScope,
                  ...projectId === undefined ? {} : { projectId },
                  onClose: (changed) => { closeEditor(changed, target) },
                })
                : null}
            </li>
          )
        })}
      </ul>
      <div className={styles['addBlock']}>
        {addTarget !== undefined && addNamespace !== undefined
          ? (
            <div className={styles['addCard']}>
              <div className={styles['field']}>
                <span className={styles['fieldLabel']}>{t('provider')}</span>
                <select
                  className={`${styles['input']} ${styles['selectInput']}`}
                  value={addTarget.provider}
                  aria-label={t('provider')}
                  onChange={(event) => {
                    const row = addable.find(candidate => candidate.entry.provider === event.target.value)
                    /* v8 ignore next -- the select only lists addable rows */
                    if (row === undefined) return
                    setEditing(targetOf(row, managementScope, projectId))
                  }}
                >
                  {addable.map(row => (
                    <option key={row.entry.provider} value={row.entry.provider}>{row.entry.displayName}</option>
                  ))}
                </select>
              </div>
              <ProviderEditor
                key={addTarget.provider}
                provider={addTarget.provider}
                displayName={addTarget.displayName}
                hideTitle
                namespace={addNamespace}
                schema={schema}
                settingsPath={addTarget.settingsPath}
                api={api}
                t={t}
                readOnly={!state.writable}
                credentialScope={managementScope}
                {...projectId === undefined ? {} : { projectId }}
                onClose={(changed) => { closeEditor(changed, addTarget) }}
              />
            </div>
          )
          : declaring
            ? (
              <div className={styles['addCard']}>
                <CustomProviderCard
                  taken={scopedRows.map(row => row.entry.provider)}
                  protocols={protocols}
                  {...(managementScope === 'project'
                    ? { routePattern: PROJECT_PROVIDER_PATTERN }
                    : injected.providerIdPattern === undefined
                      ? {}
                      : { routePattern: injected.providerIdPattern })}
                  /* v8 ignore next -- the card only opens from a button disabled without this namespace */
                  revision={state.namespaces.get('llm-pi-ai')?.revision ?? 0}
                  api={api}
                  t={t}
                  readOnly={!state.writable}
                  credentialScope={managementScope}
                  {...projectId === undefined ? {} : { projectId }}
                  onClose={(changed) => {
                    setDeclaring(false)
                    if (changed) void controller.load()
                  }}
                />
              </div>
            )
            : (
              // When a dormant adapter route exists, the user can adopt it or
              // declare a new route. Organization facades expose only the
              // latter, so do not paint an unreachable disabled sibling.
              <div className={`${styles['addActions']} ${canAdoptProvider ? '' : styles['addActionsSingle']}`}>
                {canAdoptProvider && (
                  <button
                    type="button"
                    className={styles['addButton']}
                    disabled={!state.writable}
                    onClick={() => {
                      const first = addable[0]
                      /* v8 ignore next -- the button is rendered only while an entry is addable */
                      if (first === undefined) return
                      setSavedTarget(undefined)
                      setDeclaring(false)
                      setAdding(true)
                      setEditing(targetOf(first, managementScope, projectId))
                    }}
                  >
                    {/* Same glyph as the composer's attach button. */}
                    <IconPlusOutline16 size={14} />
                    {t('add')}
                  </button>
                )}
                <button
                  type="button"
                  className={`${styles['addButton']} ${canAdoptProvider ? '' : styles['addButtonFull']}`}
                  disabled={protocols.length === 0 || !state.writable}
                  onClick={() => {
                    setSavedTarget(undefined)
                    setAdding(false)
                    setEditing(undefined)
                    setDeclaring(true)
                  }}
                >
                  <IconPlusOutline16 size={14} />
                  {t('customAdd')}
                </button>
              </div>
            )}
      </div>
      <Modal
        open={deleteTarget !== undefined}
        onClose={closeDelete}
        title={deleteTarget === undefined ? '' : providerCopy(t('deleteTitle'), deleteTarget)}
        closeLabel={t('close')}
        description={deleteTarget === undefined
          ? ''
          : providerCopy(
            deleteTarget.credentialRef === undefined
              ? t('deleteDescription')
              : t('deleteDescriptionWithCredential'),
            deleteTarget,
          )}
        className={styles['deleteDialog'] as string}
        footer={(
          <>
            <Button variant="outline" autoFocus disabled={deleting} onClick={closeDelete}>
              {t('cancel')}
            </Button>
            <Button
              variant="outline"
              className={styles['deleteConfirm']}
              disabled={deleting}
              onClick={confirmDelete}
            >
              {deleteTarget === undefined
                ? ''
                : providerCopy(deleting ? t('deleting') : t('deleteConfirm'), deleteTarget)}
            </Button>
          </>
        )}
      >
        {deleteFailure === undefined ? null : <p className={styles['error']}>{deleteFailure}</p>}
      </Modal>
    </div>
  )
}
