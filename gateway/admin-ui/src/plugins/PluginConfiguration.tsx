/** Schema-owned profile settings with explicit defaults, revision conflicts and write-only secrets. */
import { useEffect, useMemo, useState } from 'react'
import { Context } from '@deepseek-ai/cordis'
import { SettingsSchemaService, type SchemaNode } from '../../../../packages/client/ui-settings/src/client/schema.ts'
import type { SettingsNamespaceView, SettingsPathOpView } from '../../../../packages/host/apiproxy/src/api/settings.ts'
import { Button, ErrorBanner } from '../components/ui.tsx'
import type { ProfileSettingsController } from './settings-store.ts'

interface Field { path: string[]; node: SchemaNode; secret: boolean; configured: boolean }
interface Draft { operation: 'set' | 'unset'; text: string }
const identity = (path: readonly string[]) => JSON.stringify(path)
const isPrefix = (prefix: readonly string[], path: readonly string[]) => prefix.every((part, index) => path[index] === part)
const format = (value: unknown) => value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2)
export const SETTINGS_OWNER_LABELS = { account: '账户', project: '项目', organization: '组织', deployment: '部署' }

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
function label(field: Field): string { return field.path.join(' / ') || '配置值' }
function description(field: Field): string {
  const text = field.node.meta.description
  return typeof text === 'string' ? text : text?.zh ?? text?.en ?? ''
}

/** Render one namespace using its authoritative schema; saving never sends an entire redacted section. */
export function PluginConfiguration({ view, controller }: { view: SettingsNamespaceView; controller: ProfileSettingsController }) {
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
    catch { return { fields: [], error: '无法读取此插件的配置定义，请更新插件或重新读取实例。' } }
  }, [owner, base])
  const invalid = new Map<string, string>()
  const ops: SettingsPathOpView[] = []
  for (const field of form.fields) {
    const key = identity(field.path), edit = draft[key]
    if (edit === undefined) continue
    if (edit.operation === 'unset') { ops.push({ op: 'unset', path: field.path }); continue }
    try {
      const value = parsed(field, edit.text)
      if (field.secret && edit.text === '') throw new Error('替换凭据时必须填写新值；保留原值请选择“保留”。')
      const failure = owner.schema.validate(field.node, value)
      if (failure !== undefined) throw new Error(failure)
      ops.push({ op: 'set', path: field.path, value })
    } catch (cause) { invalid.set(key, field.secret ? '请输入新凭据，或选择保留。' : cause instanceof Error ? cause.message : '值无效') }
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
    setSaved(result.value.applies === 'restart' ? '配置已保存，重启实例后生效。' : '即时配置已保存。')
  }
  return <section className="sectionBody" aria-label={`${view.ns} 配置`}>
    <p className="muted">归属：{SETTINGS_OWNER_LABELS[view.owner ?? 'deployment']} · 版本：{view.revision} · {view.applies === 'restart' ? '保存后需重启实例' : '即时配置'}</p>
    <p className="muted">当前值由默认值、部署配置和本层覆盖共同决定。恢复继承只移除本层覆盖，不修改部署默认值。</p>
    {view.writable === false ? <p role="status">此配置当前只读。</p> : null}
    {conflict ? <p role="alert">配置已在其他位置更新。请放弃草稿、核对新值后重新编辑。</p> : null}
    <ErrorBanner message={error || form.error} />
    {form.fields.map(field => {
      const key = identity(field.path), change = draft[key]
      const effective = owner.schema.getPath(base.value, field.path)
      const inherited = owner.schema.getPath(base.base, field.path) ?? field.node.meta.default
      const value = change?.operation === 'unset' ? inherited : effective
      const text = change?.operation === 'set' ? change.text : format(value)
      const overridden = owner.schema.hasPath(base.user, field.path)
      const info = description(field)
      return <fieldset key={key} className="sectionBody" disabled={disabled || field.node.meta.disabled === true}>
        <legend>{label(field)}{field.node.meta.required === true ? '（必填）' : ''}</legend>
        {info ? <p className="muted">{info}</p> : null}
        {field.secret ? <>
          <p>{field.configured ? '已配置；不显示原值。' : '尚未配置。'}</p>
          <select className="select" aria-label={`${label(field)} 凭据操作`} value={change?.operation ?? 'retain'} onChange={event => {
            if (event.target.value === 'retain') setDraft(current => { const next = { ...current }; delete next[key]; return next })
            else edit(field.path, event.target.value as 'set' | 'unset')
          }}><option value="retain">保留</option><option value="set">替换</option><option value="unset">移除本层值并恢复继承</option></select>
          {change?.operation === 'set' ? <input className="input" type="password" autoComplete="new-password" aria-label={`${label(field)} 新凭据`} value={change.text}
            onChange={event => edit(field.path, 'set', event.target.value)} /> : null}
        </> : <>
          {field.node.type === 'boolean' ? <select className="select" aria-label={label(field)} value={text} onChange={event => edit(field.path, 'set', event.target.value)}>
            {text === '' ? <option value="">未设置</option> : null}<option value="true">开启</option><option value="false">关闭</option>
          </select> : field.node.type === 'string' || field.node.type === 'number' ? <input className="input" aria-label={label(field)}
            type={field.node.type === 'number' ? 'number' : 'text'} value={text} min={field.node.meta.min} max={field.node.meta.max} step={field.node.meta.step ?? 'any'}
            onChange={event => edit(field.path, 'set', event.target.value)} /> : <textarea className="input" aria-label={label(field)} rows={6} value={text}
              onChange={event => edit(field.path, 'set', event.target.value)} />}
          <p className="muted">{overridden ? '已有本层覆盖' : '继承值'} · 默认／基础值：{format(inherited) || '未声明'}
            {field.node.meta.min === undefined ? '' : ` · 最小 ${field.node.meta.min}`}{field.node.meta.max === undefined ? '' : ` · 最大 ${field.node.meta.max}`}
            {field.node.meta.step === undefined ? '' : ` · 步长 ${field.node.meta.step}`}</p>
          <Button onClick={() => edit(field.path, 'unset')}>恢复继承：{label(field)}</Button>
        </>}
        {invalid.has(key) ? <p role="alert">{invalid.get(key)}</p> : null}
      </fieldset>
    })}
    <div className="formActions"><Button disabled={disabled || !dirty || conflict || invalid.size > 0} onClick={() => { void save() }}>{saving ? '正在保存' : '保存配置'}</Button>
      <Button disabled={saving || !dirty} onClick={discard}>放弃草稿</Button></div>
    {saved ? <p role="status">{saved}</p> : null}
  </section>
}
