/**
 * The one home of this application's forwarded-Host-event allowlist. Both
 * compiler faces list this file, so the Host forwarding loop and the consumer
 * `ctx.remote.$on` key face read one declaration instead of two copies that
 * could drift; `./types.ts` derives the type projection from it and stays
 * type-only.
 */

import type {} from '@deepseek-ai/dsh-agent-preset-registry/types'
import type {} from '@deepseek-ai/dsh-commands/types'
import type {} from '@deepseek-ai/dsh-cordis-host-runner/types'
import type {} from '@deepseek-ai/dsh-credentials/types'
import type {} from '@deepseek-ai/dsh-goal/types'
import type {} from '@deepseek-ai/dsh-llm/types'
import type {} from '@deepseek-ai/dsh-memory/client'
import type {} from '@deepseek-ai/dsh-permission-presets/types'
import type {} from '@deepseek-ai/dsh-plugin-manager/types'
import type {} from '@deepseek-ai/dsh-plugin-market/types'
import type {} from '@deepseek-ai/dsh-schedule/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-settings/types'
import type { TypertForwardableEventEntry } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-user-approval/types'
import type {} from '@deepseek-ai/dsh-user-questions/types'

/**
 * Host events this application forwards without renaming. The explicit mode is
 * both the Host dispatch strategy and the legal key set of `ctx.remote.$on`.
 * An `emit` entry declares readers of the resources its payload carries, or
 * none to touch the built-in `global` resource; it reaches a non-owner Peer
 * only when access control allows it. Each notification names one resource
 * identity or none, and collection changes travel on follow streams instead.
 */
export const API_REMOTE_FORWARDED_EVENTS = [
  { event: 'agent-preset/selected', mode: 'emit', resources: { session: (sessionId): SessionId => sessionId } },
  { event: 'approval/request', mode: 'waterfall' },
  { event: 'commands/change', mode: 'emit' },
  { event: 'credentials/record-updated', mode: 'emit' },
  { event: 'credentials/reference-updated', mode: 'emit' },
  { event: 'cordis/request-run', mode: 'emit', resources: { session: (request): SessionId => request.agentId } },
  { event: 'cordis/request-run-resolved', mode: 'emit' },
  { event: 'cordis/dynamic-package', mode: 'emit' },
  { event: 'cordis/dynamic-retract', mode: 'emit' },
  { event: 'cordis/inspect-query', mode: 'emit', resources: { session: (request): SessionId => request.agentId } },
  { event: 'cordis/inspect-query-resolved', mode: 'emit' },
  { event: '@deepseek-ai/cordis/request-run', mode: 'emit', resources: { session: (request): SessionId => request.agentId } },
  { event: '@deepseek-ai/cordis/request-run-resolved', mode: 'emit' },
  { event: '@deepseek-ai/cordis/dynamic-package', mode: 'emit' },
  { event: '@deepseek-ai/cordis/dynamic-retract', mode: 'emit' },
  { event: '@deepseek-ai/cordis/inspect-query', mode: 'emit', resources: { session: (request): SessionId => request.agentId } },
  { event: '@deepseek-ai/cordis/inspect-query-resolved', mode: 'emit' },
  { event: 'goal/activation-changed', mode: 'emit', resources: { session: (payload): SessionId => payload.sessionId } },
  { event: 'llm/adapters-updated', mode: 'emit' },
  { event: 'memory/changed', mode: 'emit' },
  { event: 'permission-presets/catalog-changed', mode: 'emit' },
  { event: 'plugin-manager/changed', mode: 'emit' },
  { event: 'plugin-manager/install-log', mode: 'emit' },
  { event: 'plugin-manager/install-state', mode: 'emit' },
  { event: 'plugin-market/changed', mode: 'emit' },
  { event: 'schedule/changed', mode: 'emit' },
  { event: 'settings/document-updated', mode: 'emit' },
  { event: 'user-questions/request', mode: 'waterfall' },
] as const satisfies readonly TypertForwardableEventEntry[]
