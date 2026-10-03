/** Schema-owned profile settings with explicit defaults, revision conflicts and write-only secrets. */
import { useEffect, useMemo, useState } from 'react'
import { Context } from '@deepseek-ai/cordis'
import { SettingsSchemaService, type SchemaNode } from '../../../../packages/client/ui-settings/src/client/schema.ts'
import type { SettingsNamespaceView, SettingsPathOpView } from '../../../../packages/host/apiproxy/src/api/settings.ts'
import { Button, ErrorBanner, StatusBadge } from '../components/ui.tsx'
import { adminLanguage, type AdminLanguage } from '../language.ts'
import { translatePlugin, type Translate } from './presentation.ts'
import type { PluginManagerLocaleKey } from './locales.ts'
import type { ProfileSettingsController } from './settings-store.ts'

interface Field { path: string[]; node: SchemaNode; secret: boolean; configured: boolean }
interface Draft { operation: 'set' | 'unset'; text: string }
const identity = (path: readonly string[]) => JSON.stringify(path)
const isPrefix = (prefix: readonly string[], path: readonly string[]) => prefix.every((part, index) => path[index] === part)
const format = (value: unknown) => value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2)

type SettingsOwner = NonNullable<SettingsNamespaceView['owner']>
export const SETTINGS_OWNER_KEYS: Record<SettingsOwner, PluginManagerLocaleKey> = {
  account: 'ownerAccount', project: 'ownerProject', organization: 'ownerOrganization', deployment: 'ownerDeployment',
}

function fieldsFor(schema: SettingsSchemaService, view: SettingsNamespaceView): Field[] {
  const root = schema.rehydrate(view.schema), fields: Field[] = []
  const walk = (node: SchemaNode, path: string[]) => {
    if (node.meta.hidden === true) return
    const slot = view.secrets.find(secret => identity(secret.path) === identity(path))
    const secret = node.meta.role === 'secret' || slot !== undefined
    if (secret) { fields.push({ node, path, secret: true, configured: slot?.set === true }); return }
    if (node.type === 'object' && node.dict !== undefined && Object.keys(node.dict).length > 0) {
      for (const [key, child] of Object.entries(node.dict)) walk(child, [...path, key])
      return
    }
    // Container edits must not replace redacted credentials with missing values.
    const protectedChildren = view.secrets.filter(item => isPrefix(path, item.path) && item.path.length > path.length)
    if (protectedChildren.length > 0 && (node.type === 'array' || node.type === 'dict') && node.inner !== undefined) {
      const value = schema.getPath(view.value, path)
      const keys = new Set([...Object.keys(typeof value === 'object' && value !== null ? value : {}),
        ...protectedChildren.map(item => item.path[path.length]!)])
      for (const key of keys) walk(node.inner, [...path, key])
      return
    }
    if (protectedChildren.length > 0) throw new Error('Cannot replace a container with redacted credentials')
    fields.push({ node, path, secret: false, configured: false })
  }
  walk(root, [])
  return fields
}
function parsed(field: Field, text: string): unknown {
  if (field.secret || field.node.type === 'string') return text
  return JSON.parse(text)
}
function label(field: Field, t: Translate): string { return field.path.join(' / ') || t('fieldFallback') }
function description(field: Field, language: AdminLanguage): string {
  const text = field.node.meta.description
  return typeof text === 'string' ? text : text?.[language] ?? text?.zh ?? text?.en ?? ''
}

/** Compact constraint summary for one field: default plus declared bounds. */
function constraints(field: Field, inherited: unknown, t: Translate): string {
  const parts = [t('metaDefault', { value: format(inherited) || t('metaUndeclared') })]
  if (field.node.meta.min !== undefined) parts.push(t('metaMin', { value: `${field.node.meta.min}` }))
  if (field.node.meta.max !== undefined) parts.push(t('metaMax', { value: `${field.node.meta.max}` }))
  if (field.node.meta.step !== undefined) parts.push(t('metaStep', { value: `${field.node.meta.step}` }))
  return parts.join(' · ')
}

/** Render one namespace using its authoritative schema; saving never sends an entire redacted section. */
export function PluginConfiguration({ view, controller }: { view: SettingsNamespaceView; controller: ProfileSettingsController }) {
  const language = adminLanguage()
  const t = useMemo(() => translatePlugin(language), [language])
  const owner = useMemo(() => { const context = new Context(); return { context, schema: new SettingsSchemaService(context) } }, [])
  useEffect(() => () => { void owner.context.fiber.dispose() }, [owner])
  const [base, setBase] = useState(view)
  const [draft, setDraft] = useState<Record<string, Draft>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')
  const dirty = Object.keys(draft).length > 0
  const conflict = dirty && base.revision !== view.revision
  useEffect(() => { if (!dirty) setBase(view) }, [dirty, view])
  const form = useMemo(() => {
    try { return { fields: fieldsFor(owner.schema, base), error: '' } }
    catch { return { fields: [], error: t('schemaError') } }
  }, [owner, base, t])
  const invalid = new Map<string, string>()
  const ops: SettingsPathOpView[] = []
  for (const field of form.fields) {
    const key = identity(field.path), edit = draft[key]
    if (edit === undefined) continue
    if (edit.operation === 'unset') { ops.push({ op: 'unset', path: field.path }); continue }
    try {
      const value = parsed(field, edit.text)
      if (field.secret && edit.text === '') throw new Error('credential replacement requires a value')
      const failure = owner.schema.validate(field.node, value)
      if (failure !== undefined) throw new Error(failure)
      ops.push({ op: 'set', path: field.path, value })
    } catch (cause) { invalid.set(key, field.secret ? t('secretInvalid') : cause instanceof Error ? cause.message : t('valueInvalid')) }
  }
  const disabled = saving || view.writable === false || form.error !== ''
  const edit = (path: string[], operation: 'set' | 'unset', text = '') => {
    setSaved(''); setError(''); setDraft(current => ({ ...current, [identity(path)]: { operation, text } }))
  }
  const discard = () => { setBase(view); setDraft({}); setError(''); setSaved('') }
  const save = async () => {
    if (disabled || !dirty || conflict || invalid.size > 0) return
    setSaving(true); setError(''); setSaved('')
    const result = await controller.save(base.ns, ops, base.revision)
    setSaving(false)
    if (!result.ok) { setError(result.error.message); return }
    setBase(result.value); setDraft({})
    setSaved(result.value.applies === 'restart' ? t('savedRestart') : t('savedNow'))
  }
  const ownerLabel = t(SETTINGS_OWNER_KEYS[view.owner ?? 'deployment'])
  return <section className="sectionBody configPanel" aria-label={t('configAria', { ns: view.ns })}>
    <div className="configHead">
      <StatusBadge>{t('ownerBadge', { owner: ownerLabel })}</StatusBadge>
      <StatusBadge tone={view.applies === 'restart' ? 'warning' : 'info'}>{view.applies === 'restart' ? t('appliesRestart') : t('appliesNow')}</StatusBadge>
    </div>
    <p className="muted configExplain">{t('configExplain', { owner: ownerLabel })}</p>
    {view.writable === false ? <p role="status">{t('configReadonly')}</p> : null}
    {conflict ? <p role="alert">{t('configConflict')}</p> : null}
    <ErrorBanner message={error || form.error} />
    {form.fields.map(field => {
      const key = identity(field.path), change = draft[key]
      const effective = owner.schema.getPath(base.value, field.path)
      const inherited = owner.schema.getPath(base.base, field.path) ?? field.node.meta.default
      const value = change?.operation === 'unset' ? inherited : effective
      const text = change?.operation === 'set' ? change.text : format(value)
      const overridden = owner.schema.hasPath(base.user, field.path)
      const info = description(field, language)
      const fieldDisabled = disabled || field.node.meta.disabled === true
      const head = <div className="configFieldHead">
        <span className="configFieldLabel"><code>{label(field, t)}</code>{field.node.meta.required === true ? <span className="muted">{t('requiredMark')}</span> : null}</span>
        {field.secret ? <StatusBadge tone={field.configured ? 'success' : 'neutral'}>{field.configured ? t('secretConfigured') : t('secretUnconfigured')}</StatusBadge> : <span className="configFieldState">
          {change?.operation === 'unset' ? <StatusBadge tone="warning">{t('willInherit')}</StatusBadge>
            : overridden || change?.operation === 'set' ? <StatusBadge tone="info">{t('overriddenBadge')}</StatusBadge> : null}
          {change?.operation !== 'unset' && (overridden || change?.operation === 'set')
            ? <button type="button" className="linkButton" aria-label={t('restoreInheritField', { field: label(field, t) })} disabled={fieldDisabled}
              onClick={() => edit(field.path, 'unset')}>{t('restoreInherit')}</button> : null}
        </span>}
      </div>
      return <div key={key} className="configField">
        {head}
        {info ? <p className="muted configFieldHint">{info}</p> : null}
        {field.secret ? <>
          <p className="muted">{field.configured ? t('secretSetHint') : t('secretUnsetHint')}</p>
          <select className="select" aria-label={t('secretOpsAria', { field: label(field, t) })} value={change?.operation ?? 'retain'} disabled={fieldDisabled} onChange={event => {
            if (event.target.value === 'retain') setDraft(current => { const next = { ...current }; delete next[key]; return next })
            else edit(field.path, event.target.value as 'set' | 'unset')
          }}><option value="retain">{t('secretRetain')}</option><option value="set">{t('secretReplace')}</option><option value="unset">{t('secretUnset')}</option></select>
          {change?.operation === 'set' ? <input className="input configFieldControl" type="password" autoComplete="new-password" aria-label={t('secretNewAria', { field: label(field, t) })} value={change.text}
            disabled={fieldDisabled} onChange={event => edit(field.path, 'set', event.target.value)} /> : null}
        </> : <>
          {field.node.type === 'boolean' ? <select className="select" aria-label={label(field, t)} value={text} disabled={fieldDisabled} onChange={event => edit(field.path, 'set', event.target.value)}>
            {text === '' ? <option value="">{t('boolUnset')}</option> : null}<option value="true">{t('boolOn')}</option><option value="false">{t('boolOff')}</option>
          </select> : field.node.type === 'string' || field.node.type === 'number' ? <input className="input configFieldControl" aria-label={label(field, t)}
            type={field.node.type === 'number' ? 'number' : 'text'} value={text} min={field.node.meta.min} max={field.node.meta.max} step={field.node.meta.step ?? 'any'}
            disabled={fieldDisabled} onChange={event => edit(field.path, 'set', event.target.value)} /> : <textarea className="input configFieldControl" aria-label={label(field, t)} rows={6} value={text}
              disabled={fieldDisabled} onChange={event => edit(field.path, 'set', event.target.value)} />}
          <p className="muted configFieldMeta">{constraints(field, inherited, t)}</p>
        </>}
        {invalid.has(key) ? <p role="alert" className="configFieldInvalid">{invalid.get(key)}</p> : null}
      </div>
    })}
    <div className="formActions"><Button disabled={disabled || !dirty || conflict || invalid.size > 0} onClick={() => { void save() }}>{saving ? t('configSaving') : t('configSave')}</Button>
      <Button disabled={saving || !dirty} onClick={discard}>{t('configDiscard')}</Button></div>
    {saved ? <p role="status">{saved}</p> : null}
  </section>
}
