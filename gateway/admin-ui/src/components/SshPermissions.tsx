/** Project SSH qualification editor; user qualification lives on the user detail page. */
import { useMemo } from 'react'
import { getSshPolicy, setSshPolicy } from '../api.ts'
import { adminLanguage, translateCopy } from '../language.ts'
import { zh, en } from './permissions.copy.ts'
import { ResourcePermissions, type ResourcePermissionProjects } from './ResourcePermissions.tsx'

export function SshPermissions({ projects }: { projects?: ResourcePermissionProjects } = {}) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh, en }), [])
  return <ResourcePermissions name={t('sshName')} read={getSshPolicy} write={setSshPolicy} kinds={['project']} projects={projects}
    description={t('sshDescription')}
    saved={t('sshSaved')} />
}
