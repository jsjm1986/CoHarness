import { useMemo } from 'react'
import type { ConversationArchiveDetail } from '../api.ts'
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
  const projection = useMemo(() => projectArchiveEvents(detail.events), [detail.events])
  const visibleMessages = projection.items.filter(item => item.kind === 'message').length
  const visibleTools = projection.items.filter(item => item.kind === 'tool').length

  return (
    <div className="archiveConversationReader">
      <section className="archiveConversation" aria-label="对话记录">
        <header className="archiveConversationHeader">
          <div>
            <h3>对话记录</h3>
            <p>以聊天方式显示用户、助手和工具交互；运行配置等内部事件已收起。</p>
          </div>
          <div className="archiveConversationStats" aria-label="对话统计">
            <span>{visibleMessages} 条消息</span>
            {visibleTools === 0 ? null : <span>{visibleTools} 个工具步骤</span>}
          </div>
        </header>
        {projection.items.length === 0 ? (
          <EmptyState
            title="暂无可读对话"
            detail={detail.events.length === 0
              ? '该会话的正文暂时不可用，稍后可以重试。'
              : '该归档只包含运行配置或内部事件。展开下方技术详情可查看完整记录。'}
          />
        ) : (
          <div className="archiveChatTimeline">
            {projection.items.map(item => <ArchiveTimelineItemView item={item} key={item.key} />)}
            {visibleMessages === 0 ? <p className="archiveConversationHint">未发现用户或助手消息，以上内容是会话运行状态摘要。</p> : null}
          </div>
        )}
        {detail.hasMore ? <p className="archiveConversationHint">当前只显示部分事件；导出记录可查看完整内容。</p> : null}
      </section>
      <details className="archiveRawDetails">
        <summary>
          <span>查看技术详情</span>
          <span className="archiveRawCount">{detail.events.length} 个原始事件</span>
        </summary>
        <div className="archiveTechnicalDetails">
          <section className="archiveDescendants" aria-label="子会话与分支">
            <h3>会话树</h3>
            {detail.descendants.length === 0 ? <p className="mutedText">没有可用的子会话记录。</p> : (
              <ul>{detail.descendants.map(entry => (
                <li key={entry.sessionId}>
                  <span>{entry.sessionId === detail.record.rootSessionId ? '根会话' : '子会话'}</span>
                  <strong>{entry.title}</strong>
                  <code>{entry.sessionId}</code>
                </li>
              ))}</ul>
            )}
          </section>
          <div className="archiveRawTimeline" aria-label="原始事件列表">
            {detail.events.length === 0 ? <p className="mutedText">没有可用的原始事件。</p> : detail.events.map(event => (
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
  if (item.kind === 'message') {
    return (
      <article className={`archiveChatMessage archiveChatMessage-${item.role}`}>
        <div className="archiveChatMessageMeta">
          <span>{item.role === 'user' ? '用户' : '助手'}</span>
          <time dateTime={new Date(item.time).toISOString()}>{formatTime(item.time)}</time>
        </div>
        <div className="archiveChatBubble">
          <div className="archiveMessageText">{item.text}</div>
          {item.interrupted ? <small className="archiveMessageNotice">回复在中途中断</small> : null}
        </div>
      </article>
    )
  }
  if (item.kind === 'tool') {
    return (
      <article className="archiveToolCard">
        <div className="archiveToolHeader">
          <span className="archiveEventRole archiveEventRole-tool">工具</span>
          <strong>{item.name}</strong>
          <time dateTime={new Date(item.time).toISOString()}>{formatTime(item.time)}</time>
        </div>
        {item.arguments === undefined ? null : (
          <details className="archiveInlineDetails">
            <summary>查看参数</summary>
            <pre>{formatArguments(item.arguments)}</pre>
          </details>
        )}
        {item.resultAvailable ? (
          <div className={`archiveToolResult ${item.error === undefined ? '' : 'archiveToolResult-error'}`.trim()}>
            <span>{item.error === undefined ? '结果' : '执行失败'}</span>
            <div className="archiveMessageText">{item.result ?? '工具已返回非文本结果，请查看技术详情。'}</div>
            {item.error === undefined ? null : <small>{item.error}</small>}
          </div>
        ) : <p className="archiveToolPending">尚未记录工具结果</p>}
      </article>
    )
  }
  return (
    <article className={`archiveSystemCard archiveSystemCard-${item.tone}`}>
      <span className="archiveEventRole archiveEventRole-system">系统</span>
      <div>
        <strong>{item.label}</strong>
        <span>{item.detail}</span>
      </div>
      <time dateTime={new Date(item.time).toISOString()}>{formatTime(item.time)}</time>
    </article>
  )
}

function projectArchiveEvents(events: readonly ArchiveEvent[]): { items: ArchiveTimelineItem[] } {
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
        name: stringValue(data?.name) ?? '工具调用',
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
      const error = errorText(data?.error) ?? (resultBlock?.isError === true ? '工具返回错误结果' : undefined)
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
          name: '工具结果',
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
  const data = record(event.data)
  switch (event.type) {
    case 'permission/preset': {
      const preset = stringValue(data?.preset)
      return { label: '权限设置', detail: preset === undefined ? '已更新权限策略' : `预设：${permissionPresetLabel(preset)}`, tone: 'neutral' }
    }
    case 'sandbox/mode': {
      const mode = stringValue(data?.mode)
      const labels: Record<string, string> = {
        'read-only': '只读',
        'workspace-write': '工作区可写',
        'danger-full-access': '完全访问',
      }
      return { label: '沙箱模式', detail: mode === undefined ? '已更新运行权限' : labels[mode] ?? humanizeIdentifier(mode), tone: 'neutral' }
    }
    case 'approval/policy': {
      const policy = stringValue(data?.policy)
      return { label: '审批策略', detail: policy === 'ask' ? '需要确认' : policy === 'never' ? '自动拒绝需审批操作' : policy === undefined ? '已更新审批策略' : humanizeIdentifier(policy), tone: 'neutral' }
    }
    case 'plan/mode':
      return { label: '计划模式', detail: data?.active === true ? '已开启' : '已关闭', tone: 'neutral' }
    case 'agent-preset/selected': {
      const preset = stringValue(data?.agentPreset)
      return { label: '助手配置', detail: preset === undefined ? '已选择运行配置' : humanizeIdentifier(preset), tone: 'neutral' }
    }
    case 'approval/asked': {
      const toolName = stringValue(data?.toolName)
      const reason = stringValue(data?.reason)
      return { label: '等待审批', detail: reason ?? (toolName === undefined ? '需要确认后继续' : `工具：${toolName}`), tone: 'warning' }
    }
    case 'approval/decided': {
      const outcome = stringValue(data?.outcome)
      return { label: '审批结果', detail: outcome === undefined ? '已完成审批' : approvalOutcomeLabel(outcome), tone: outcome === 'allowed-once' ? 'success' : 'warning' }
    }
    case 'turn/end': {
      const reason = record(data?.reason)
      if (reason?.kind !== 'error' && reason?.kind !== 'aborted') return undefined
      const failure = record(reason.error) ?? record(reason.failure)
      const message = stringValue(failure?.message)
      return { label: '运行结束', detail: message ?? (reason.kind === 'error' ? '执行失败' : '执行已中断'), tone: 'warning' }
    }
    case 'command/done': {
      if (stringValue(data?.kind) !== 'error') return undefined
      return { label: '命令失败', detail: stringValue(data?.text) ?? '命令执行失败', tone: 'warning' }
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
    if (object.type === 'image') return { text: '（图片）', hasReasoning: false, hasUnsupported: false }
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
  const labels: Record<string, string> = {
    'workspace-write': '工作区可写',
    'danger-full-access': '完全访问',
    'read-only': '只读',
    custom: '自定义',
  }
  return labels[value] ?? humanizeIdentifier(value)
}

function approvalOutcomeLabel(value: string): string {
  const labels: Record<string, string> = {
    'allowed-once': '本次允许',
    rejected: '已拒绝',
    cancelled: '已取消',
    unavailable: '无法完成审批',
  }
  return labels[value] ?? humanizeIdentifier(value)
}

function eventKey(event: ArchiveEvent): string {
  return `${event.sessionId}:${event.seq}`
}

function eventLabel(type: string): string {
  const labels: Record<string, string> = {
    'user/message': '用户消息',
    'assistant/message': '助手消息',
    'tool/call': '工具调用',
    'tool/result': '工具结果',
    'permission/preset': '权限设置',
    'sandbox/mode': '沙箱模式',
    'approval/policy': '审批策略',
    'approval/asked': '审批请求',
    'approval/decided': '审批结果',
    'plan/mode': '计划模式',
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
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(timestamp)
}
