/** Shared model identity and access-override pieces used by catalog and per-user editors. */
import { Sparkles } from 'lucide-react'
import type { ModelGovernanceRow } from '../api.ts'

export function modelKey(row: { provider: string; model: string }): string {
  return `${row.provider}\0${row.model}`
}

export function ModelIdentity({ row }: { row: ModelGovernanceRow }) {
  return (
    <div className="modelIdentity">
      <span className="itemIcon"><Sparkles aria-hidden="true" /></span>
      <span className="modelIdentityText"><strong>{row.displayName}</strong><span className="codeText">{row.provider}/{row.model}</span></span>
    </div>
  )
}

export function RoleDefaults({ row }: { row: ModelGovernanceRow }) {
  return (
    <div className="roleDefaults">
      <span className={row.adminAllowed ? 'allowed' : 'denied'}>管理员 {row.adminAllowed ? '允许' : '拒绝'}</span>
      <span className={row.userAllowed ? 'allowed' : 'denied'}>用户 {row.userAllowed ? '允许' : '拒绝'}</span>
    </div>
  )
}

export function OverrideSelect({ label, value, disabled, onChange }: {
  label: string
  value: boolean | undefined
  disabled: boolean
  onChange: (value: string) => void
}) {
  return (
    <select aria-label={label} className="select selectCompact overrideSelect" disabled={disabled} value={value === undefined ? 'inherit' : value ? 'allow' : 'deny'} onChange={event => onChange(event.target.value)}>
      <option value="inherit">继承角色</option>
      <option value="allow">允许</option>
      <option value="deny">拒绝</option>
    </select>
  )
}
