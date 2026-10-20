/** Project memory-write grant editor for one project; user qualification lives on the user detail page. */
import { useMemo } from 'react'
import { getMemoryPolicy, setMemoryPolicy } from '../api.ts'
import { adminLanguage, translateCopy } from '../language.ts'
import { zh, en } from './permissions.copy.ts'
import { ResourcePermissions } from './ResourcePermissions.tsx'

export function MemoryPermissions({ projectId }: { projectId: number }) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh, en }), [])
  return <ResourcePermissions name={t('memoryName')} read={getMemoryPolicy} write={setMemoryPolicy} kinds={['project']}
    owner={{ kind: 'project', id: projectId }}
    description={t('memoryDescription')}
    saved={t('memorySaved')} />
}
