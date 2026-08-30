import {
  createSnapshotStore, settingsControlState,
  type SettingsControlState, type SettingsScope, type SettingsScopeSnapshot, type SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ConversationSettings } from '../submission-settings.ts'
import {
  CHAT_CONTENT_WIDTH_RANGE, CHAT_FONT_SIZE_RANGE, DEFAULT_CHAT_CONTENT_WIDTH, DEFAULT_CHAT_FONT_SIZE,
} from '../submission-settings.ts'

/** Render-facing conversation display preference snapshot. */
export interface ConversationDisplaySettingsSnapshot {
  readonly chatContentWidth: number
  readonly chatFontSize: number
  readonly settings: SettingsControlState
}

/** Settings-backed display preferences shared by the shell and General row. */
export class ConversationDisplaySettings {
  private readonly store: SnapshotStore<ConversationDisplaySettingsSnapshot>
  private readonly unsubscribe: (() => void) | undefined
  private pendingWidth: number | undefined
  private pendingFontSize: number | undefined
  private disposed = false

  /** @param scope - settings scope for the conversation namespace. */
  constructor(private readonly scope?: SettingsScope<ConversationSettings>) {
    this.store = createSnapshotStore(this.snapshot(scope?.getSnapshot()))
    if (scope !== undefined) {
      this.unsubscribe = scope.subscribe(() => { this.adopt(scope.getSnapshot()) })
      this.adopt(scope.getSnapshot())
    }
  }

  /**
   * Read the current display preference snapshot.
   * @returns the current width, font size, and settings write state.
   */
  getSnapshot(): ConversationDisplaySettingsSnapshot { return this.store.getSnapshot() }

  /**
   * Subscribe to display preference and write-state changes.
   * @param listener - called after a preference or write-state change.
   * @returns an unsubscribe function.
   */
  subscribe(listener: () => void): () => void { return this.store.subscribe(listener) }

  /**
   * Read the current transcript width.
   * @returns the current width, clamped to the supported range.
   */
  width(): number { return this.getSnapshot().chatContentWidth }

  /**
   * Read the current transcript font size.
   * @returns the current font size, clamped to the supported range.
   */
  fontSize(): number { return this.getSnapshot().chatFontSize }

  /**
   * Persist a transcript width after clamping it to the supported range.
   * @param value - requested width in pixels.
   */
  setWidth(value: number): void {
    const width = clamp(value, CHAT_CONTENT_WIDTH_RANGE.min, CHAT_CONTENT_WIDTH_RANGE.max)
    if (width === this.width()) return
    this.pendingWidth = width
    this.store.set({ ...this.getSnapshot(), chatContentWidth: width })
    if (this.scope === undefined) {
      this.pendingWidth = undefined
      return
    }
    void this.scope.set('chatContentWidth', width)
  }

  /**
   * Persist a transcript font size after clamping it to the supported range.
   * @param value - requested font size in pixels.
   */
  setFontSize(value: number): void {
    const fontSize = clamp(value, CHAT_FONT_SIZE_RANGE.min, CHAT_FONT_SIZE_RANGE.max)
    if (fontSize === this.fontSize()) return
    this.pendingFontSize = fontSize
    this.store.set({ ...this.getSnapshot(), chatFontSize: fontSize })
    if (this.scope === undefined) {
      this.pendingFontSize = undefined
      return
    }
    void this.scope.set('chatFontSize', fontSize)
  }

  /** Release the settings subscription. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe?.()
  }

  private adopt(snapshot: SettingsScopeSnapshot<ConversationSettings>): void {
    if (this.disposed) return
    const value = snapshot.value
    const remoteWidth = clamp(
      value?.chatContentWidth ?? DEFAULT_CHAT_CONTENT_WIDTH,
      CHAT_CONTENT_WIDTH_RANGE.min,
      CHAT_CONTENT_WIDTH_RANGE.max,
    )
    const remoteFontSize = clamp(
      value?.chatFontSize ?? DEFAULT_CHAT_FONT_SIZE,
      CHAT_FONT_SIZE_RANGE.min,
      CHAT_FONT_SIZE_RANGE.max,
    )
    if (snapshot.write.status === 'idle') {
      if (this.pendingWidth === remoteWidth) this.pendingWidth = undefined
      if (this.pendingFontSize === remoteFontSize) this.pendingFontSize = undefined
    } else if (snapshot.write.status === 'error' || snapshot.write.status === 'blocked') {
      this.pendingWidth = undefined
      this.pendingFontSize = undefined
    }
    this.store.set({
      chatContentWidth: snapshot.write.status === 'saving' && this.pendingWidth !== undefined
        ? this.pendingWidth
        : remoteWidth,
      chatFontSize: snapshot.write.status === 'saving' && this.pendingFontSize !== undefined
        ? this.pendingFontSize
        : remoteFontSize,
      settings: settingsControlState(snapshot),
    })
  }

  private snapshot(snapshot?: SettingsScopeSnapshot<ConversationSettings>): ConversationDisplaySettingsSnapshot {
    return {
      chatContentWidth: DEFAULT_CHAT_CONTENT_WIDTH,
      chatFontSize: DEFAULT_CHAT_FONT_SIZE,
      settings: snapshot === undefined
        ? { status: 'ready', writable: true, writableReason: undefined, write: { status: 'idle' } }
        : settingsControlState(snapshot),
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? Math.round(value) : min))
}
