import { useMemo, useSyncExternalStore } from 'react'
import { Context } from '@deepseek-ai/cordis'
import { ModelsSection } from '../../../../packages/client/ui-settings-models/src/client/ModelsSection.tsx'
import type { ModelDiscoveryProbe } from '../../../../packages/client/ui-settings-models/src/client/ModelListEditor.tsx'
import {
  ModelsSettingsStore,
  type ModelsSettingsState,
} from '../../../../packages/client/ui-settings-models/src/client/store.ts'
import { en, zh } from '../../../../packages/client/ui-settings-models/src/client/locales.ts'
import { createSettingsSchemaOperations } from '../../../../packages/client/ui-settings-models/src/client/schema-operations.ts'
import { SettingsSchemaService } from '../../../../packages/client/ui-settings/src/client/schema.ts'
import { createOrganizationModelsMirror } from '../model-settings-api.ts'
import { adminLanguage } from '../language.ts'

const ORGANIZATION_PROVIDER_PATTERN = /^org-[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

const organizationCopyZh = {
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

const organizationCopyEn = {
  ...en,
  title: 'Organization providers and models',
  intro: 'Configure the providers, API keys, and the complete model catalog the organization holds; saved settings take effect through the role, user, and project default rules, with per-model exceptions.',
  customAdd: 'Add an organization provider',
  customTitle: 'Organization provider',
  customTag: 'Organization',
  customRouteHint: 'An organization provider ID must start with org- followed by lowercase letters, digits, and dashes.',
  customRouteInvalid: 'An organization provider ID must match org-name, for example org-primary.',
  create: 'Create the organization provider',
  creating: 'Creating the organization provider…',
  advancedHint: 'The remaining provider fields stay in the complete profile.',
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
  const { schema, describeFace, api } = useMemo(() => {
    // The admin surface reuses the shared editor outside the Cordis client
    // plugin graph, so it must provide the same schema and settings mirror
    // faces that ui-settings-models receives from its host plugin.
    const schemaService = new SettingsSchemaService(new Context())
    return {
      schema: createSettingsSchemaOperations(schemaService),
      ...createOrganizationModelsMirror({ onChanged }),
    }
  }, [onChanged])
  const controller = useMemo(
    () => new ModelsSettingsStore(api as never, schema, describeFace),
    [api, describeFace, schema],
  )
  const useSnapshot = useMemo(() => bindSnapshot(controller), [controller])
  const t = useMemo(() => {
    const copy = adminLanguage() === 'en' ? organizationCopyEn : organizationCopyZh
    return (key: keyof typeof copy) => copy[key]
  }, [])
  // The shared section probes a provider endpoint through this page's own
  // facade so discovery stays inside the organization REST surface.
  const discoverModels = useMemo<ModelDiscoveryProbe>(() => async (settingsNs, request) => {
    const response = await api.llm.discoverModels({ settingsNs, ...request })
    return response.result.ok
      ? { ok: true, value: response.result.value.models }
      : { ok: false, error: { message: response.result.error.message } }
  }, [api])

  // The organization facade exposes only configured org-* profiles. The
  // shared section therefore keeps only its declaration action when no
  // dormant adapter route can be adopted.
  return (
    <div className="organizationModelsEditor">
      <ModelsSection
        controller={controller}
        useSnapshot={useSnapshot as never}
        api={api as never}
        discoverModels={discoverModels}
        schema={schema}
        t={t}
        managementScope="organization"
        providerIdPattern={ORGANIZATION_PROVIDER_PATTERN}
      />
    </div>
  )
}
