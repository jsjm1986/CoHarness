/** Project plugin-management authorization editor; user qualification lives on the user detail page. */
import { useMemo } from 'react'
import { getPluginPolicy, setPluginPolicy } from '../api.ts'
import { adminLanguage, translateCopy } from '../language.ts'
import { zh, en } from './permissions.copy.ts'
import { ResourcePermissions, type ResourcePermissionProjects } from './ResourcePermissions.tsx'

export function PluginPermissions({ projects }: { projects?: ResourcePermissionProjects } = {}) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh, en }), [])
  return <ResourcePermissions name={t('pluginName')} read={getPluginPolicy} write={setPluginPolicy} kinds={['project']} projects={projects}
    description={t('pluginDescription')}
    saved={t('pluginSaved')} />
}
