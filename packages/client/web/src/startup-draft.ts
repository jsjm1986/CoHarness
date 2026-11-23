/** Native boot input stays in its original document until a qualified composer accepts it. */

import { managedSelectionStorageKey, type StartupDraft } from '@deepseek-ai/dsh-client-ui-slots'
import { remoteEntryUrl, type RemoteEntrySelection } from './remote-entry.ts'
import css from './boot-page.module.css'

const text = {
  en: { label: 'Unsent draft', waiting: 'Opening your workspace. You can write a draft now.', retained: 'Unsent draft retained',
    failed: 'The workspace did not open. You can keep or copy your draft.', full: 'Open full workspace in a new tab' },
  zh: { label: '未发送的草稿', waiting: '正在打开工作区。可以先写草稿。', retained: '草稿已保留',
    failed: '工作区暂未打开。可以保留或复制草稿。', full: '在新标签页打开完整工作区' },
} as const

function restoredSelection(entry: RemoteEntrySelection): string | undefined {
  try {
    const key = managedSelectionStorageKey(entry.principalId, entry.runtimeId, entry.scope)
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null')
    return typeof value === 'object' && value !== null && 'sessionId' in value
      && typeof value.sessionId === 'string' && !('subagentAddress' in value) ? value.sessionId : undefined
  } catch {
    // A disabled store or invalid selection contains no usable Session pointer.
    return undefined
  }
}

/** One early text surface and its synchronous adoption handshake. */
export class StartupDraftView implements StartupDraft {
  readonly principalId: number
  readonly runtimeId: string
  readonly nodeId: string
  readonly scope: RemoteEntrySelection['scope']
  readonly savedSessionId: string | undefined
  private readonly root = document.createElement('section')
  private readonly input = document.createElement('textarea')
  private readonly status = document.createElement('p')
  private readonly fullIndex = document.createElement('a')
  private readonly words: (typeof text)[keyof typeof text]
  private readonly listeners = new Set<() => void>()
  private retained: HTMLDetailsElement | undefined
  private guarding = false
  private done = false

  /** @param entry - the authenticated entry target, accepted before loading Runtime plugins. */
  constructor(private readonly entry: RemoteEntrySelection) {
    this.principalId = entry.principalId
    this.runtimeId = entry.runtimeId
    this.nodeId = entry.nodeId
    this.scope = entry.scope
    this.savedSessionId = restoredSelection(entry)
    this.words = text[entry.language]
    this.root.className = css.startupDraft ?? ''
    this.root.dataset.dshStartupDraft = ''
    this.root.lang = entry.language
    this.status.setAttribute('role', 'status')
    this.status.textContent = this.words.waiting
    const label = document.createElement('label')
    label.append(`${this.words.label} · ${entry.nodeName}`, this.input)
    this.input.rows = 4
    this.input.autocomplete = 'off'
    this.input.setAttribute('aria-label', `${this.words.label} · ${entry.nodeName}`)
    this.input.addEventListener('input', this.changed)
    this.fullIndex.href = remoteEntryUrl(entry, 'full').href
    this.fullIndex.target = '_blank'
    this.fullIndex.rel = 'noopener'
    this.fullIndex.textContent = this.words.full
    this.root.append(this.status, label, this.fullIndex)
  }

  /**
   * Move the same draft view into the startup surface, preserving its input.
   * @param location - parent of the startup surface before the renderer mounts.
   */
  attach(location: HTMLElement): void { location.append(this.root) }

  private readonly beforeUnload = (event: BeforeUnloadEvent): void => {
    if (this.input.value !== '') event.preventDefault()
  }

  private readonly changed = (): void => {
    const wanted = this.input.value !== ''
    if (wanted !== this.guarding) {
      this.guarding = wanted
      if (wanted) window.addEventListener('beforeunload', this.beforeUnload)
      else window.removeEventListener('beforeunload', this.beforeUnload)
    }
    for (const listener of [...this.listeners]) listener()
  }

  read(): string { return this.done ? '' : this.input.value }

  subscribe(listener: () => void): () => void {
    if (!this.done) this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  transfer(adopt: (value: string) => boolean): boolean {
    const value = this.read()
    if (value === '' || !adopt(value)) return false
    this.dispose()
    return true
  }

  /** Preserve input while the mounted UI completes account and Session verification. */
  retainAtMount(): void {
    if (this.done || this.input.value === '') { this.dispose(); return }
    this.status.textContent = this.words.retained
    this.fullIndex.hidden = true
    const focused = document.activeElement === this.input
    const details = document.createElement('details')
    const summary = document.createElement('summary')
    summary.textContent = `${this.words.label} · ${this.entry.nodeName}`
    details.open = true
    details.className = css.retainedDraft ?? ''
    details.append(summary, this.root)
    this.retained = details
    document.body.append(details)
    if (focused) this.input.focus()
  }

  /** Keep the full index available if startup or the renderer handoff fails. */
  showUnavailable(): void {
    if (this.done) return
    this.status.textContent = this.words.failed
    this.fullIndex.hidden = false
  }

  /** Withdraw input when its owning document is disposed or the account changes. */
  dispose(): void {
    if (this.done) return
    this.done = true
    this.input.value = ''
    this.input.removeEventListener('input', this.changed)
    window.removeEventListener('beforeunload', this.beforeUnload)
    this.root.remove()
    this.retained?.remove()
    for (const listener of [...this.listeners]) listener()
    this.listeners.clear()
  }
}
