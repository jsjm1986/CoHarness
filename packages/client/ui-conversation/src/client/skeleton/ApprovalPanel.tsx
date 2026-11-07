// Pending approvals occupy the composer until the resolved frame arrives.
// The tool name, justification, and paired shell command or non-shell arguments
// stay inspectable in a capped scroll region; decisions remain outside it.
// A rejected answer receipt restores the controls with an inline error.

import { useMemo, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RunningToolCall } from '@deepseek-ai/dsh-client-runtime/client'
import { PendingApproval, type ApprovalComposerProps } from '../contract/slots.ts'
import { rootToolCall } from '../tool-node-reader.ts'
import css from './ApprovalPanel.module.css'

/** Extract the shell command from an approval's paired running call (bash-family args carry `command`); undefined hides the line. */
export function commandOf(call: RunningToolCall | undefined): string | undefined {
  // A preparing call's arguments are still streaming; the paired command line
  // appears only once the dispatched call exists.
  if (call === undefined || call.phase !== 'start') return undefined
  try {
    const args = JSON.parse(call.argsRaw) as Record<string, unknown>
    return typeof args.command === 'string' ? args.command : undefined
  } catch {
    // Unparseable model args: the panel still renders, just without the command line.
    return undefined
  }
}

/**
 * Composer takeover boundary: mints the domain face on the carrier's stable
 * identity and remounts the flow per request key, so the one-shot answered
 * latch never leaks to the next pending approval.
 * @param props - the selector-matched pending approval carrier plus the framework standard kit.
 * @returns The approval prompt for this request.
 */
export function ApprovalPanel(props: ApprovalComposerProps) {
  const approval = useMemo(() => new PendingApproval(props.matched), [props.matched])
  const call = props.useSession((snapshot) => {
    if (approval.callId === undefined) return undefined
    const root = rootToolCall(snapshot, approval.callId)
    if (root === undefined) return undefined
    return root.callId === approval.callId && !('kind' in root) ? root : undefined
  })
  const command = commandOf(call)
  const parameters = useMemo(() => {
    if (call === undefined || call.phase !== 'start' || command !== undefined) return undefined
    try {
      const parsed: unknown = JSON.parse(call.argsRaw)
      return JSON.stringify(parsed, null, 2)
    } catch {
      // A malformed model argument string remains inspectable as received.
      return call.argsRaw
    }
  }, [call, command])
  const reason = approval.displayReason === undefined ? approval.reason : props.resolveReason(approval.displayReason)
  return <ApprovalFlow key={approval.key} pending={approval} reason={reason} t={props.t}
    {...command === undefined ? {} : { command }} {...parameters === undefined ? {} : { parameters }} />
}

function ApprovalFlow({ pending, reason, command, parameters, t }: {
  pending: PendingApproval
  reason: string | undefined
  command?: string
  parameters?: string
  t: ApprovalComposerProps['t']
}) {
  // Local one-shot latch: the panel leaves only when the resolved frame
  // lands; until then the buttons must not re-fire and the strip echoes the
  // recorded decision. An answer failure (rejected receipt / transport)
  // re-arms them for retry.
  const [answered, setAnswered] = useState<'allowed-once' | 'rejected' | null>(null)
  const [failed, setFailed] = useState(false)
  const answer = (outcome: 'allowed-once' | 'rejected'): void => {
    setFailed(false)
    setAnswered(outcome)
    void pending.answer(outcome).catch(() => { setAnswered(null); setFailed(true) })
  }
  return (
    <div className={css.root} data-approval-key={pending.key}>
      <div className={css.card} data-answered={answered ?? undefined}>
        <div className={css.strip}>
          <span className={css.dot} />
          {answered === null
            ? t('approval.waiting')
            : t(answered === 'allowed-once' ? 'approval.allowedEcho' : 'approval.rejectedEcho')}
        </div>
        {/* Tab stop: the region scrolls once the command passes the cap and
            holds nothing focusable of its own, so without one a keyboard-only
            user cannot reach the command's tail before answering. */}
        <div className={css.body} data-approval-scroll="" tabIndex={0} role="group" aria-label={t('approval.detail.aria')}>
          <div className={css.headline}>{t('approval.escalation', { toolName: pending.toolName })}</div>
          {reason !== undefined && <div className={css.reason}>{reason}</div>}
          {command !== undefined && <div className={css.command}>{command}</div>}
          {parameters !== undefined && <pre className={css.parameters} aria-label={t('approval.arguments')}>{parameters}</pre>}
        </div>
        {failed && <div className={css.feedback} role="alert">{t('approval.failed')}</div>}
        <div className={css.actionRow}>
          <Button variant="outline" className={css.reject} disabled={answered !== null} onClick={() => { answer('rejected') }}>
            {t('approval.reject')}
          </Button>
          <Button variant="primary" disabled={answered !== null} onClick={() => { answer('allowed-once') }}>
            {t('approval.allowOnce')}
          </Button>
        </div>
      </div>
    </div>
  )
}
