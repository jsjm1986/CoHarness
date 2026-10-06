/** Project terminal authorization editor; user qualification lives on the user detail page. */
import { useMemo } from 'react'
import { getTerminalPolicy, setTerminalPolicy } from '../api.ts'
import { adminLanguage, translateCopy } from '../language.ts'
import { zh, en } from './permissions.copy.ts'
import { ResourcePermissions } from './ResourcePermissions.tsx'

export function TerminalPermissions() {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh, en }), [])
  return <ResourcePermissions name={t('terminalName')} read={getTerminalPolicy} write={setTerminalPolicy} kinds={['project']}
    description={t('terminalDescription')}
    saved={t('terminalSaved')} />
}
