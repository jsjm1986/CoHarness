import { useMemo, useSyncExternalStore } from 'react'
import { Context } from '@deepseek-ai/cordis'
import { ModelsSection } from '../../../../packages/client/ui-settings-models/src/client/ModelsSection.tsx'
import {
  ModelsSettingsStore,
  type ModelsSettingsState,
} from '../../../../packages/client/ui-settings-models/src/client/store.ts'
import { zh } from '../../../../packages/client/ui-settings-models/src/client/locales.ts'
import { createSettingsSchemaOperations } from '../../../../packages/client/ui-settings-models/src/client/schema-operations.ts'
import { SettingsSchemaService } from '../../../../packages/client/ui-settings/src/client/schema.ts'
import { SettingsDescribeMirror } from '../../../../packages/client/ui-settings/src/client/settings-mirror.ts'
import { createOrganizationModelsApi } from '../model-settings-api.ts'

const ORGANIZATION_PROVIDER_PATTERN = /^org-[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

const organizationCopy = {
  ...zh,
  title: '组织 Provider 与模型',
  intro: '配置组织统一持有的 Provider、API 密钥和完整模型目录；保存后按角色、用户和项目的默认规则生效，也可设置单模型例外。',
  customAdd: '添加组织 Provider',
  customTitle: '组织 Provider',
  customTag: '组织',
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
    const snapshot = useSyncExternalStore<ModelsSettingsState>(
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
  const { schema, describeFace } = useMemo(() => {
    // The admin surface reuses the shared editor outside the Cordis client
    // plugin graph, so it must provide the same schema and settings mirror
    // faces that ui-settings-models receives from its host plugin.
    const schemaService = new SettingsSchemaService(new Context())
    return {
      schema: createSettingsSchemaOperations(schemaService),
      describeFace: new SettingsDescribeMirror(api as never),
    }
  }, [api])
  const controller = useMemo(
    () => new ModelsSettingsStore(api as never, schema, describeFace),
    [api, describeFace, schema],
  )
  const useSnapshot = useMemo(() => bindSnapshot(controller), [controller])
  const t = useMemo(() => (key: keyof typeof zh) => organizationCopy[key], [])

  // The organization facade exposes only configured org-* profiles. The
  // shared section therefore keeps only its declaration action when no
  // dormant adapter route can be adopted.
  return (
    <div className="organizationModelsEditor">
      <ModelsSection
        controller={controller}
        useSnapshot={useSnapshot as never}
        api={api as never}
        schema={schema}
        t={t}
        managementScope="organization"
        providerIdPattern={ORGANIZATION_PROVIDER_PATTERN}
      />
    </div>
  )
}
