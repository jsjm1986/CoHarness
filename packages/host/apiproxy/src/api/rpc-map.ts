/**
 * RPC method registry and signature-derived generics. The map
 * registers only client-request methods (respond is a client-response, so it is absent);
 * map keys are the wire path segments (POST /api/session.list).
 */

import type { DesktopApi } from './desktop.ts'
import type { SessionsApi } from './sessions.ts'
import type { HostApi } from './host.ts'
import type { WorkspaceApi } from './workspace.ts'
import type { WorkspaceFilesApi } from './workspace-files.ts'
import type { WorkspaceChangesApi } from './workspace-changes.ts'
import type { AgentPresetsApi } from './agent-presets.ts'
import type { SkillsApi } from './skills.ts'
import type { SettingsApi } from './settings.ts'
import type { CredentialsApi } from './credentials.ts'
import type { LlmApi } from './llm.ts'
import type { SubagentsApi } from './subagents.ts'
import type { RpcResponse } from './rpc.ts'

/**
 * Method name → method signature. Signatures are the single source of truth; payload/value
 * types are always derived from here. A method may declare a trailing AbortSignal after the
 * request; the carrier passes its request signal, never a wire field.
 */
export interface RpcMethodMap {
  'desktop.status': DesktopApi['status']
  'desktop.confirm': DesktopApi['confirm']
  'session.list': SessionsApi['list']
  'session.search': SessionsApi['search']
  'session.create': SessionsApi['create']
  'session.history': SessionsApi['history']
  'session.historyIndex': SessionsApi['historyIndex']
  'session.models': SessionsApi['models']
  'session.selectModel': SessionsApi['selectModel']
  'session.rename': SessionsApi['rename']
  'session.fork': SessionsApi['fork']
  'session.prompt': SessionsApi['prompt']
  'session.attachment': SessionsApi['attachment']
  'session.updateQueue': SessionsApi['updateQueue']
  'session.cancel': SessionsApi['cancel']
  'subagent.history': SubagentsApi['history']
  'host.describe': HostApi['describe']
  'host.pickDirectory': HostApi['pickDirectory']
  'host.listDirectory': HostApi['listDirectory']
  'host.createDirectory': HostApi['createDirectory']
  'host.openPath': HostApi['openPath']
  'workspace.list': WorkspaceApi['list']
  'workspace.create': WorkspaceApi['create']
  'workspace.rename': WorkspaceApi['rename']
  'workspace.delete': WorkspaceApi['delete']
  'workspace.insertBefore': WorkspaceApi['insertBefore']
  'workspace.insertSessionBefore': WorkspaceApi['insertSessionBefore']
  'workspace.archiveSession': WorkspaceApi['archiveSession']
  'workspace.unarchiveSession': WorkspaceApi['unarchiveSession']
  'workspaceChanges.summary': WorkspaceChangesApi['summary']
  'workspaceChanges.diff': WorkspaceChangesApi['diff']
  'workspaceFiles.list': WorkspaceFilesApi['list']
  'workspaceFiles.renderOffice': WorkspaceFilesApi['renderOffice']
  'workspaceFiles.stat': WorkspaceFilesApi['stat']
  'workspaceFiles.read': WorkspaceFilesApi['read']
  'workspaceFiles.readBytes': WorkspaceFilesApi['readBytes']
  'skill.list': SkillsApi['list']
  'agentPreset.openDocument': AgentPresetsApi['openDocument']
  'settings.describe': SettingsApi['describe']
  'settings.openDocument': SettingsApi['openDocument']
  'settings.update': SettingsApi['update']
  'settings.replace': SettingsApi['replace']
  'settings.mutate': SettingsApi['mutate']
  'credentials.describe': CredentialsApi['describe']
  'credentials.set': CredentialsApi['set']
  'credentials.unset': CredentialsApi['unset']
  'llm.providers': LlmApi['providers']
  'llm.models': LlmApi['models']
  'llm.discoverModels': LlmApi['discoverModels']
}

/** Business request payload of method K (reaches through the RpcRequest narrow form to payload). */
export type RequestPayload<K extends keyof RpcMethodMap> = Parameters<RpcMethodMap[K]>[0]['payload']

/** Business return value of method K (reaches through the RpcResponse narrow form to infer the ok value of result). */
export type ResponseValue<K extends keyof RpcMethodMap> =
  Awaited<ReturnType<RpcMethodMap[K]>> extends RpcResponse<infer T> ? T : never
