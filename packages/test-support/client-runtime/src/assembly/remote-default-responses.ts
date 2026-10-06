/**
 * Default responses for the API and Remote endpoints the web assembly calls
 * while booting and rendering with no sessions, no workspaces, and default
 * settings. The comment above each row names the plugin that calls it;
 * endpoints boot never touches stay absent so a new call fails loud.
 * `host.describe` and the `events.*` streams are built into `RemoteMock`.
 * @module @deepseek-ai/dsh-client-test-runtime/src/assembly/remote-default-responses
 */
import { ok, type RemoteTable } from '@deepseek-ai/dsh-remote-mock'

/** Default responses of the boot-time endpoints; a spec loads it first and layers its own table on top. */
export const remoteDefaultResponses: RemoteTable = {
  unary: {
    // client-runtime SessionManager refresh on `onConnected`.
    'session.list': ok({ items: [] }),
    // client-runtime WorkspaceManager refresh on `onConnected`.
    'workspace.list': ok({ items: [], archivedSessionIds: [] }),
    // ui-settings `mirror.ensure()` at apply and again on `connection/reset`.
    'settings.describe': ok({ writable: true, hasDocument: false, namespaces: [] }),
    // ui-model-selection catalog mirrors.
    'llm.models': ok({ groups: [], failures: [] }),
    'llm.providers': ok({ providers: [] }),
    'session.models': ok({
      current: { provider: 'deepseek-official', model: 'deepseek-flash' },
      routable: false,
      groups: [],
      failures: [],
    }),
    // ui-skill catalog reads.
    'skill.list': ok({ skills: [] }),
    // Desktop confirmation status probe; no host confirms under the mock.
    'desktop.status': ok(null),
    // ui-agent-preset hero chip and header label on first mount.
    'agentPresets/list': ok({ presets: [], authorable: false, modeSelectionEnabled: false }),
    // cordis-client-runner `ClientCordisInspectRegistry.sync` at apply and on `connection/reset`.
    'dynamicCordisRunner/syncInspectManifest': ok(null),
    // ui-cordis inventory at apply and on `connection/reset`.
    'dynamicCordisRunner/inventory': ok([]),
    // ui-plugin-inventory snapshot on first read.
    'pluginInventory/list': ok({ entries: [] }),
    // ui-permission-presets `PermissionCatalogDirectory` on its first read for a connection generation.
    'permissionPresets/catalog': ok({ options: [] }),
    // command palette's descriptor pull before the first submission.
    'commands/list': ok([]),
    // subagent catalog of an opened session's turn area.
    'subagents/list': ok({ entries: [], parentAvailable: false }),
    // goal panel state of an opened session.
    'goals/get': ok(undefined),
    // ui-settings-plugins web-search card `readCredential()` when the settings mirror first publishes.
    'credentials.describe': ok({ credentials: {} }),
    // llm Remote readers (ui-model-selection's configurable provider table).
    'llm/listProviders': ok([]),
    'llm/listConfigurableProviders': ok([]),
  },
  // Stream endpoints the roster opens later than boot; declared so a spec that forgets the script gets a stream miss.
  streams: [],
  stream: {},
}
