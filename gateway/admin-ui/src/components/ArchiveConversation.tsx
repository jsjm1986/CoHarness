import { useMemo } from 'react'
import type { ConversationArchiveDetail } from '../api.ts'
import { adminLanguage, translateCopy } from '../language.ts'
import { zh as archiveConversationZh, en as archiveConversationEn } from './archive-conversation.copy.ts'
import { EmptyState } from './ui.tsx'

type ArchiveEvent = ConversationArchiveDetail['events'][number]

type MessageRole = 'user' | 'assistant'

type ArchiveTimelineItem =
  | {
      kind: 'message'
      role: MessageRole
      text: string
      time: number
      key: string
      interrupted: boolean
    }
  | {
      kind: 'tool'
      name: string
      callId?: string
      arguments?: string
      result?: string
      resultAvailable: boolean
      error?: string
      time: number
      key: string
    }
  | {
      kind: 'system'
      label: string
      detail: string
      tone: 'neutral' | 'warning' | 'success'
      time: number
      key: string
    }

type ToolItem = Extract<ArchiveTimelineItem, { kind: 'tool' }>

type ContentText = {
  text: string
  hasReasoning: boolean
  hasUnsupported: boolean
}

/** Render an archive event log as a readable conversation with an audit fallback. */
export function ArchiveConversation({ detail }: { detail: ConversationArchiveDetail }) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: archiveConversationZh, en: archiveConversationEn }), [])
  const projection = useMemo(() => projectArchiveEvents(detail.events), [detail.events])
  const visibleMessages = projection.items.filter(item => item.kind === 'message').length
  const visibleTools = projection.items.filter(item => item.kind === 'tool').length

  return (
    <div className="archiveConversationReader">
      <section className="archiveConversation" aria-label={t('conversationTitle')}>
        <header className="archiveConversationHeader">
          <div>
            <h3>{t('conversationTitle')}</h3>
            <p>{t('conversationDescription')}</p>
          </div>
          <div className="archiveConversationStats" aria-label={t('statsAria')}>
            <span>{t('messageCount', { count: String(visibleMessages) })}</span>
            {visibleTools === 0 ? null : <span>{t('toolStepsCount', { count: String(visibleTools) })}</span>}
          </div>
        </header>
        {projection.items.length === 0 ? (
          <EmptyState
            title={t('emptyTitle')}
            detail={detail.events.length === 0
              ? t('emptyBodyUnavailable')
              : t('emptyInternalOnly')}
          />
        ) : (
          <div className="archiveChatTimeline">
            {projection.items.map(item => <ArchiveTimelineItemView item={item} key={item.key} />)}
            {visibleMessages === 0 ? <p className="archiveConversationHint">{t('noMessagesHint')}</p> : null}
          </div>
        )}
        {detail.hasMore ? <p className="archiveConversationHint">{t('partialHint')}</p> : null}
      </section>
      <details className="archiveRawDetails">
        <summary>
          <span>{t('techDetails')}</span>
          <span className="archiveRawCount">{t('rawEventCount', { count: String(detail.events.length) })}</span>
        </summary>
        <div className="archiveTechnicalDetails">
          <section className="archiveDescendants" aria-label={t('descendantsAria')}>
            <h3>{t('sessionTree')}</h3>
            {detail.descendants.length === 0 ? <p className="mutedText">{t('noDescendants')}</p> : (
              <ul>{detail.descendants.map(entry => (
                <li key={entry.sessionId}>
                  <span>{entry.sessionId === detail.record.rootSessionId ? t('rootSession') : t('childSession')}</span>
                  <strong>{entry.title}</strong>
                  <code>{entry.sessionId}</code>
                </li>
              ))}</ul>
            )}
          </section>
          <div className="archiveRawTimeline" aria-label={t('rawListAria')}>
            {detail.events.length === 0 ? <p className="mutedText">{t('noRawEvents')}</p> : detail.events.map(event => (
              <details className="archiveRawEvent" key={`${event.sessionId}:${event.seq}`}>
                <summary>
                  <span>{eventLabel(event.type)}</span>
                  <time dateTime={new Date(event.time).toISOString()}>{formatTime(event.time)}</time>
                </summary>
                <div className="archiveRawEventMeta">
                  <span>{event.type}</span>
                  <span>seq {event.seq}</span>
                  <span className="codeText">{event.sessionId}</span>
                </div>
                <pre>{formatEvent(event.data)}</pre>
              </details>
            ))}
          </div>
        </div>
      </details>
    </div>
  )
}

function ArchiveTimelineItemView({ item }: { item: ArchiveTimelineItem }) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: archiveConversationZh, en: archiveConversationEn }), [])
  if (item.kind === 'message') {
    return (
      <article className={`archiveChatMessage archiveChatMessage-${item.role}`}>
        <div className="archiveChatMessageMeta">
          <span>{item.role === 'user' ? t('roleUser') : t('roleAssistant')}</span>
          <time dateTime={new Date(item.time).toISOString()}>{formatTime(item.time)}</time>
        </div>
        <div className="archiveChatBubble">
          <div className="archiveMessageText">{item.text}</div>
          {item.interrupted ? <small className="archiveMessageNotice">{t('interrupted')}</small> : null}
        </div>
      </article>
    )
  }
  if (item.kind === 'tool') {
    return (
      <article className="archiveToolCard">
        <div className="archiveToolHeader">
          <span className="archiveEventRole archiveEventRole-tool">{t('roleTool')}</span>
          <strong>{item.name}</strong>
          <time dateTime={new Date(item.time).toISOString()}>{formatTime(item.time)}</time>
        </div>
        {item.arguments === undefined ? null : (
          <details className="archiveInlineDetails">
            <summary>{t('viewArguments')}</summary>
            <pre>{formatArguments(item.arguments)}</pre>
          </details>
        )}
        {item.resultAvailable ? (
          <div className={`archiveToolResult ${item.error === undefined ? '' : 'archiveToolResult-error'}`.trim()}>
            <span>{item.error === undefined ? t('resultLabel') : t('runFailed')}</span>
            <div className="archiveMessageText">{item.result ?? t('nonTextResult')}</div>
            {item.error === undefined ? null : <small>{item.error}</small>}
          </div>
        ) : <p className="archiveToolPending">{t('toolResultPending')}</p>}
      </article>
    )
  }
  return (
    <article className={`archiveSystemCard archiveSystemCard-${item.tone}`}>
      <span className="archiveEventRole archiveEventRole-system">{t('roleSystem')}</span>
      <div>
        <strong>{item.label}</strong>
        <span>{item.detail}</span>
      </div>
      <time dateTime={new Date(item.time).toISOString()}>{formatTime(item.time)}</time>
    </article>
  )
}

function projectArchiveEvents(events: readonly ArchiveEvent[]): { items: ArchiveTimelineItem[] } {
  const t = translateCopy(adminLanguage(), { zh: archiveConversationZh, en: archiveConversationEn })
  const items: ArchiveTimelineItem[] = []
  const tools = new Map<string, { index: number; item: ToolItem }>()
  let previousSystem: { label: string; detail: string } | undefined

  for (const event of events) {
    if (event.type === 'user/message' || event.type === 'assistant/message') {
      const data = record(event.data)
      const content = event.type === 'user/message' ? data?.content : record(data?.message)?.content
      const extracted = contentText(content ?? data?.content)
      if (extracted.text !== '') {
        items.push({
          kind: 'message',
          role: event.type === 'user/message' ? 'user' : 'assistant',
          text: extracted.text,
          time: event.time,
          key: eventKey(event),
          interrupted: event.type === 'assistant/message' && data?.interrupted === true,
        })
      }
      continue
    }

    if (event.type === 'tool/call') {
      const data = record(event.data)
      const callId = stringValue(data?.callId)
      const item: ToolItem = {
        kind: 'tool',
        name: stringValue(data?.name) ?? t('toolCall'),
        ...(callId === undefined ? {} : { callId }),
        ...(stringValue(data?.arguments) === undefined ? {} : { arguments: stringValue(data?.arguments) }),
        resultAvailable: false,
        time: event.time,
        key: eventKey(event),
      }
      const index = items.push(item) - 1
      if (callId !== undefined) tools.set(callId, { index, item })
      continue
    }

    if (event.type === 'tool/result') {
      const data = record(event.data)
      const message = record(data?.message)
      const resultBlock = firstToolResultBlock(message?.content ?? data?.content)
      const callId = stringValue(resultBlock?.toolCallId) ?? stringValue(record(message?.source)?.callId) ?? stringValue(data?.callId)
      const extracted = contentText(resultBlock?.content ?? message?.content ?? data?.content)
      const error = errorText(data?.error) ?? (resultBlock?.isError === true ? t('toolErrorFallback') : undefined)
      const existing = callId === undefined ? undefined : tools.get(callId)
      if (existing !== undefined && callId !== undefined) {
        const updated: ToolItem = {
          ...existing.item,
          result: extracted.text === '' ? undefined : extracted.text,
          resultAvailable: true,
          ...(error === undefined ? {} : { error }),
          time: existing.item.time,
        }
        items[existing.index] = updated
        tools.set(callId, { index: existing.index, item: updated })
      } else {
        items.push({
          kind: 'tool',
          name: t('toolResult'),
          ...(callId === undefined ? {} : { callId }),
          result: extracted.text === '' ? undefined : extracted.text,
          resultAvailable: true,
          ...(error === undefined ? {} : { error }),
          time: event.time,
          key: eventKey(event),
        })
      }
      continue
    }

    const system = readableSystemEvent(event)
    if (system !== undefined) {
      if (previousSystem?.label === system.label && previousSystem.detail === system.detail) continue
      previousSystem = system
      items.push({ ...system, kind: 'system', time: event.time, key: eventKey(event) })
    }
  }

  return { items }
}

function readableSystemEvent(event: ArchiveEvent): Omit<Extract<ArchiveTimelineItem, { kind: 'system' }>, 'kind' | 'key' | 'time'> | undefined {
  const t = translateCopy(adminLanguage(), { zh: archiveConversationZh, en: archiveConversationEn })
  const data = record(event.data)
  switch (event.type) {
    case 'permission/preset': {
      const preset = stringValue(data?.preset)
      return { label: t('permissionPresetLabel'), detail: preset === undefined ? t('permissionPresetUpdated') : t('presetDetail', { name: permissionPresetLabel(preset) }), tone: 'neutral' }
    }
    case 'sandbox/mode': {
      const mode = stringValue(data?.mode)
      const labels: Record<string, string> = {
        'read-only': t('sandboxReadOnly'),
        'workspace-write': t('sandboxWorkspaceWrite'),
        'danger-full-access': t('sandboxFullAccess'),
      }
      return { label: t('sandboxMode'), detail: mode === undefined ? t('sandboxUpdated') : labels[mode] ?? humanizeIdentifier(mode), tone: 'neutral' }
    }
    case 'approval/policy': {
      const policy = stringValue(data?.policy)
      return { label: t('approvalPolicy'), detail: policy === 'ask' ? t('approvalAsk') : policy === 'never' ? t('approvalNever') : policy === undefined ? t('approvalPolicyUpdated') : humanizeIdentifier(policy), tone: 'neutral' }
    }
    case 'plan/mode':
      return { label: t('planMode'), detail: data?.active === true ? t('planOn') : t('planOff'), tone: 'neutral' }
    case 'agent-preset/selected': {
      const preset = stringValue(data?.agentPreset)
      return { label: t('agentPreset'), detail: preset === undefined ? t('agentPresetSelected') : humanizeIdentifier(preset), tone: 'neutral' }
    }
    case 'approval/asked': {
      const toolName = stringValue(data?.toolName)
      const reason = stringValue(data?.reason)
      return { label: t('approvalAsked'), detail: reason ?? (toolName === undefined ? t('approvalAwaitDetail') : t('toolNameDetail', { name: toolName })), tone: 'warning' }
    }
    case 'approval/decided': {
      const outcome = stringValue(data?.outcome)
      return { label: t('approvalResult'), detail: outcome === undefined ? t('approvalDecidedDone') : approvalOutcomeLabel(outcome), tone: outcome === 'allowed-once' ? 'success' : 'warning' }
    }
    case 'turn/end': {
      const reason = record(data?.reason)
      if (reason?.kind !== 'error' && reason?.kind !== 'aborted') return undefined
      const failure = record(reason.error) ?? record(reason.failure)
      const message = stringValue(failure?.message)
      return { label: t('turnEnd'), detail: message ?? (reason.kind === 'error' ? t('runFailed') : t('runAborted')), tone: 'warning' }
    }
    case 'command/done': {
      if (stringValue(data?.kind) !== 'error') return undefined
      return { label: t('commandFailed'), detail: stringValue(data?.text) ?? t('commandFailedDetail'), tone: 'warning' }
    }
    default:
      return undefined
  }
}

function firstToolResultBlock(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) return undefined
  for (const block of value) {
    const recordBlock = record(block)
    if (recordBlock?.type === 'tool-result') return recordBlock
  }
  return undefined
}

function contentText(value: unknown): ContentText {
  if (typeof value === 'string') return { text: value.trim(), hasReasoning: false, hasUnsupported: false }
  if (!Array.isArray(value)) {
    const object = record(value)
    if (object === undefined) return { text: '', hasReasoning: false, hasUnsupported: value !== undefined }
    if (object.type === 'reasoning') return { text: '', hasReasoning: true, hasUnsupported: false }
    if (typeof object.text === 'string') return { text: object.text.trim(), hasReasoning: false, hasUnsupported: false }
    if (object.type === 'image') return { text: translateCopy(adminLanguage(), { zh: archiveConversationZh, en: archiveConversationEn })('imagePlaceholder'), hasReasoning: false, hasUnsupported: false }
    if (object.content !== undefined) return contentText(object.content)
    return { text: '', hasReasoning: false, hasUnsupported: true }
  }
  const parts: string[] = []
  let hasReasoning = false
  let hasUnsupported = false
  for (const block of value) {
    const extracted = contentText(block)
    if (extracted.text !== '') parts.push(extracted.text)
    hasReasoning ||= extracted.hasReasoning
    hasUnsupported ||= extracted.hasUnsupported
  }
  return { text: parts.join('\n').trim(), hasReasoning, hasUnsupported }
}

function errorText(value: unknown): string | undefined {
  const error = record(value)
  if (error === undefined) return typeof value === 'string' && value !== '' ? value : undefined
  return stringValue(error.message) ?? stringValue(error.code)
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function humanizeIdentifier(value: string): string {
  return value.replaceAll(/[-_]+/gu, ' ').replace(/\s+/gu, ' ').trim()
}

function permissionPresetLabel(value: string): string {
  const t = translateCopy(adminLanguage(), { zh: archiveConversationZh, en: archiveConversationEn })
  const labels: Record<string, string> = {
    'workspace-write': t('sandboxWorkspaceWrite'),
    'danger-full-access': t('sandboxFullAccess'),
    'read-only': t('sandboxReadOnly'),
    custom: t('presetCustom'),
  }
  return labels[value] ?? humanizeIdentifier(value)
}

function approvalOutcomeLabel(value: string): string {
  const t = translateCopy(adminLanguage(), { zh: archiveConversationZh, en: archiveConversationEn })
  const labels: Record<string, string> = {
    'allowed-once': t('outcomeAllowedOnce'),
    rejected: t('outcomeRejected'),
    cancelled: t('outcomeCancelled'),
    unavailable: t('outcomeUnavailable'),
  }
  return labels[value] ?? humanizeIdentifier(value)
}

function eventKey(event: ArchiveEvent): string {
  return `${event.sessionId}:${event.seq}`
}

function eventLabel(type: string): string {
  const t = translateCopy(adminLanguage(), { zh: archiveConversationZh, en: archiveConversationEn })
  const labels: Record<string, string> = {
    'user/message': t('eventUserMessage'),
    'assistant/message': t('eventAssistantMessage'),
    'tool/call': t('toolCall'),
    'tool/result': t('toolResult'),
    'permission/preset': t('permissionPresetLabel'),
    'sandbox/mode': t('sandboxMode'),
    'approval/policy': t('approvalPolicy'),
    'approval/asked': t('eventApprovalAsked'),
    'approval/decided': t('approvalResult'),
    'plan/mode': t('planMode'),
  }
  return labels[type] ?? type
}

function formatArguments(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}

function formatEvent(data: unknown): string {
  if (typeof data === 'string') return data
  try { return JSON.stringify(data, null, 2) } catch { return String(data) }
}

function formatTime(timestamp: number): string {
  const t = translateCopy(adminLanguage(), { zh: archiveConversationZh, en: archiveConversationEn })
  return new Intl.DateTimeFormat(t('dateLocale'), { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(timestamp)
}
