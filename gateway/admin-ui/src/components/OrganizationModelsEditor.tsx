import { useMemo, useSyncExternalStore } from 'react'
import { ModelsSection } from '../../../../packages/client/ui-settings-models/src/client/ModelsSection.tsx'
import {
  ModelsSettingsStore,
  type ModelsSettingsState,
} from '../../../../packages/client/ui-settings-models/src/client/store.ts'
import { zh } from '../../../../packages/client/ui-settings-models/src/client/locales.ts'
import { createOrganizationModelsApi } from '../model-settings-api.ts'

const ORGANIZATION_PROVIDER_PATTERN = /^org-[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

const organizationCopy = {
  ...zh,
  title: '组织 Provider 与模型',
  intro: '配置组织统一持有的 Provider、API 密钥和完整模型目录；保存后再向角色、用户或项目分配具体模型。',
  customAdd: '添加组织 Provider',
  customTitle: '组织 Provider',
  customRouteHint: '组织 Provider ID 必须以 org- 开头，后续只能使用小写字母、数字和短横线。',
  customRouteInvalid: '组织 Provider ID 必须匹配 org-名称，例如 org-primary。',
  create: '创建组织 Provider',
  creating: '正在创建组织 Provider…',
  advancedHint: '其余 Provider 字段会保留在完整 profile 中。',
}

type SnapshotHook = <S>(
  selector: (state: ModelsSettingsState) => S,
  equal?: (left: S, right: S) => boolean,
) => S

function bindSnapshot(controller: ModelsSettingsStore): SnapshotHook {
  return function useSnapshot<S>(selector: (state: ModelsSettingsState) => S): S {
    const snapshot = useSyncExternalStore(
      controller.store.subscribe,
      controller.store.getSnapshot,
      controller.store.getSnapshot,
    )
    return selector(snapshot)
  }
}

/** Shared Models settings plugin mounted against the organization REST facade. */
export function OrganizationModelsEditor({ onChanged }: { onChanged: () => void }) {
  const api = useMemo(() => createOrganizationModelsApi({ onChanged }), [onChanged])
  const controller = useMemo(() => new ModelsSettingsStore(api as never), [api])
  const useSnapshot = useMemo(() => bindSnapshot(controller), [controller])
  const t = useMemo(() => (key: keyof typeof zh) => organizationCopy[key], [])

  return (
    <div className="organizationModelsEditor">
      <ModelsSection
        controller={controller}
        useSnapshot={useSnapshot as never}
        api={api as never}
        t={t}
        managementScope="organization"
        providerIdPattern={ORGANIZATION_PROVIDER_PATTERN}
      />
    </div>
  )
}
