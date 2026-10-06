/** Shared model identity and access-override pieces used by catalog and per-user editors. */
import { Sparkles } from 'lucide-react'
import { useMemo } from 'react'
import type { ModelGovernanceRow } from '../api.ts'
import { adminLanguage, translateCopy } from '../language.ts'
import { en as modelsEn, zh as modelsZh } from './models.copy.ts'

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
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: modelsZh, en: modelsEn }), [])
  return (
    <div className="roleDefaults">
      <span className={row.adminAllowed ? 'allowed' : 'denied'}>{t('roleAdmin')} {row.adminAllowed ? t('decisionAllow') : t('decisionDeny')}</span>
      <span className={row.userAllowed ? 'allowed' : 'denied'}>{t('roleUser')} {row.userAllowed ? t('decisionAllow') : t('decisionDeny')}</span>
    </div>
  )
}

export function OverrideSelect({ label, value, disabled, onChange }: {
  label: string
  value: boolean | undefined
  disabled: boolean
  onChange: (value: string) => void
}) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: modelsZh, en: modelsEn }), [])
  return (
    <select aria-label={label} className="select selectCompact overrideSelect" disabled={disabled} value={value === undefined ? 'inherit' : value ? 'allow' : 'deny'} onChange={event => onChange(event.target.value)}>
      <option value="inherit">{t('overrideInherit')}</option>
      <option value="allow">{t('overrideAllow')}</option>
      <option value="deny">{t('overrideDeny')}</option>
    </select>
  )
}
