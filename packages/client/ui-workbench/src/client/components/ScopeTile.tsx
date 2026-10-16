/** Space identity tile shared by pane headers, the sidebar roster, and the picker. */
import { parseClientSessionKey, workspaceTitleOf } from '@deepseek-ai/dsh-client-runtime/client'
import { IconShieldOutline16, IconUserOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  ProjectUiPolicySnapshot, SessionId, SessionListState, WorkspaceListState,
} from '@deepseek-ai/dsh-client-runtime/client'
import css from './Workbench.module.css'

/** Space tone carried by a pane's tile: personal grey, project blue, steward amber. */
export type ScopeTone = 'personal' | 'project' | 'steward'

/** Per-pane identity: display title, space name, subtitle, and tile tone.
 * The tone follows the session's own encoded runtime — a workbench pane can
 * hold another space's conversation, so the page scope never applies. */
export interface PaneIdentity {
  readonly title: string
  /** Owning space name (project name or the personal space label). */
  readonly scopeName: string
  /** Workspace the session lives in; empty when nothing resolves. */
  readonly workspaceName: string
  readonly tone: ScopeTone
}

/**
 * Resolve one pane's identity from the session summary, workspace rows, and
 * the account scope policy.
 * @param sessionId - pane's runtime-aware Session key.
 * @param summary - session list summary, absent while the runtime has not surfaced it.
 * @param workspaces - workspace rows owning the session.
 * @param policy - account scope policy carrying the steward roster mirror.
 * @param personal - localized personal-space name.
 * @param untitled - localized untitled fallback.
 * @returns the pane's title, space, workspace, and tone.
 */
export function paneIdentity(
  sessionId: SessionId,
  summary: SessionListState['byId'][SessionId] | undefined,
  workspaces: WorkspaceListState,
  policy: ProjectUiPolicySnapshot,
  personal: string,
  untitled: string,
): PaneIdentity {
  const runtime = parseClientSessionKey(sessionId)?.runtime
  const tone: ScopeTone = runtime?.kind === 'personal' ? 'personal'
    : runtime?.kind === 'project'
      ? (policy.stewardProjectIds?.includes(runtime.projectId) === true ? 'steward' : 'project')
      : (policy.steward === true ? 'steward' : 'personal')
  const scopeName = summary?.workspaceName ?? (runtime?.kind === 'project' ? '' : personal)
  const workspaceName = workspaces.items.find(item => item.sessionIds.includes(sessionId))?.title
    ?? workspaceTitleOf(summary?.cwd ?? '')
  return { title: summary?.displayTitle ?? untitled, scopeName, workspaceName, tone }
}

/** Render a 20px tinted space tile with the scope's mark: the personal and
 * steward tiles carry the same user/shield icons the scope switcher draws;
 * only project tiles fall back to the name's initial.
 * @param props.name - scope display name; the first character renders on project tiles.
 * @param props.tone - personal / project / steward tint.
 * @param props.className - extra placement class.
 * @returns the tile element (decorative; pair with visible scope text). */
export function ScopeTile({ name, tone, className }: {
  name: string
  tone: ScopeTone
  className?: string | undefined
}) {
  const trimmed = name.trim()
  // Grapheme-safe: a code-unit slice would split surrogate pairs on the tile.
  const glyph = trimmed === '' ? '·'
    : (new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(trimmed)[Symbol.iterator]().next().value?.segment ?? '·').toUpperCase()
  return (
    <span className={className === undefined ? css.scopeTile : `${css.scopeTile} ${className}`} data-scope-tone={tone} aria-hidden="true">
      {tone === 'personal' ? <IconUserOutline16 size={12} />
        : tone === 'steward' ? <IconShieldOutline16 size={12} />
          : glyph}
    </span>
  )
}
