/** Project terminal authorization editor; user qualification lives on the user detail page. */
import { useMemo } from 'react'
import { getTerminalPolicy, setTerminalPolicy } from '../api.ts'
import { adminLanguage, translateCopy } from '../language.ts'
import { zh, en } from './permissions.copy.ts'
import { ResourcePermissions, type ResourcePermissionProjects } from './ResourcePermissions.tsx'

export function TerminalPermissions({ projects }: { projects?: ResourcePermissionProjects } = {}) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh, en }), [])
  return <ResourcePermissions name={t('terminalName')} read={getTerminalPolicy} write={setTerminalPolicy} kinds={['project']} projects={projects}
    description={t('terminalDescription')}
    saved={t('terminalSaved')} />
}
