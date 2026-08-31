// PartialAccumulator: assistant/chunk accumulator.
// Folds the six StreamChunk variants into AssistantBlock[] keyed by block index;
// block-level immutability (a delta only swaps that block's reference).

import type { StreamChunk } from '@deepseek-ai/dsh-llm/types'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { AssistantBlock, PartialAssistant } from './conversation.ts'
import { sanitizeAssistantText, toAssistantBlock } from './conversation.ts'

interface TextSlot {
  readonly mutable: true
  readonly kind: 'text'
  rawText: string
  version: number
  snapshotVersion: number
  snapshot?: AssistantBlock
}

interface ReasoningSlot {
  readonly mutable: true
  readonly kind: 'reasoning'
  text: string
  version: number
  snapshotVersion: number
  snapshot?: AssistantBlock
}

interface ToolCallSlot {
  readonly mutable: true
  readonly kind: 'tool-call'
  callId: string
  name: string
  argumentsText: string
  version: number
  snapshotVersion: number
  snapshot?: AssistantBlock
}

interface OtherSlot {
  readonly mutable: true
  readonly kind: 'other'
  readonly block: unknown
  version: number
  snapshotVersion: number
  snapshot?: AssistantBlock
}

type MutableSlot = TextSlot | ReasoningSlot | ToolCallSlot | OtherSlot
type Slot = AssistantBlock | MutableSlot | undefined

function isMutableSlot(value: AssistantBlock | MutableSlot): value is MutableSlot {
  return 'mutable' in value
}

function newSlot(blockType: string): MutableSlot {
  switch (blockType) {
    case 'text': return { mutable: true, kind: 'text', rawText: '', version: 0, snapshotVersion: -1 }
    case 'reasoning': return { mutable: true, kind: 'reasoning', text: '', version: 0, snapshotVersion: -1 }
    case 'tool-call': return {
      mutable: true, kind: 'tool-call', callId: '', name: '', argumentsText: '', version: 0, snapshotVersion: -1,
    }
    default: return { mutable: true, kind: 'other', block: null, version: 0, snapshotVersion: -1 }
  }
}

function materializeSlot(value: AssistantBlock | MutableSlot): AssistantBlock {
  if (!isMutableSlot(value)) return value
  if (value.snapshot !== undefined && value.snapshotVersion === value.version) return value.snapshot
  let snapshot: AssistantBlock
  switch (value.kind) {
    case 'text': snapshot = { kind: 'text', text: sanitizeAssistantText(value.rawText) }; break
    case 'reasoning': snapshot = { kind: 'reasoning', text: value.text }; break
    case 'tool-call': snapshot = {
      kind: 'tool-call', callId: value.callId, name: value.name, argsRaw: value.argumentsText,
    }; break
    case 'other': snapshot = { kind: 'other', block: value.block }; break
  }
  value.snapshot = snapshot
  value.snapshotVersion = value.version
  return snapshot
}

/**
 * Incremental assistant block accumulator shared by Chat, Trajectory, and
 * partial-stream consumers. Delta admission is constant work; text is joined
 * and sanitized only when a consumer requests a published snapshot.
 */
export class IncrementalAssistantBlocks {
  private slots: Slot[]
  private dirty: boolean
  private value: AssistantBlock[]

  /** @param initialBlocks - materialized blocks already present in the window. */
  constructor(initialBlocks: readonly AssistantBlock[] = []) {
    this.slots = [...initialBlocks]
    this.value = [...initialBlocks]
    this.dirty = false
  }

  /**
   * Start one sparse block slot.
   * @param index - stream block index.
   * @param blockType - provider block type.
   */
  start(index: number, blockType: string): void {
    this.slots[index] = newSlot(blockType)
    this.dirty = true
  }

  /**
   * Append one text delta without copying the accumulated prefix.
   * @param index - stream block index.
   * @param text - delta text.
   */
  textDelta(index: number, text: string): void {
    const previous = this.slots[index]
    const slot = previous !== undefined && isMutableSlot(previous) && previous.kind === 'text'
      ? previous
      : newSlot('text') as TextSlot
    if (previous?.kind === 'text' && !isMutableSlot(previous)) slot.rawText = previous.text
    slot.rawText += text
    slot.version++
    this.slots[index] = slot
    this.dirty = true
  }

  /**
   * Append one reasoning delta without copying the accumulated prefix.
   * @param index - stream block index.
   * @param text - delta text.
   */
  reasoningDelta(index: number, text: string): void {
    const previous = this.slots[index]
    const slot = previous !== undefined && isMutableSlot(previous) && previous.kind === 'reasoning'
      ? previous
      : newSlot('reasoning') as ReasoningSlot
    if (previous?.kind === 'reasoning' && !isMutableSlot(previous)) slot.text = previous.text
    slot.text += text
    slot.version++
    this.slots[index] = slot
    this.dirty = true
  }

  /**
   * Append one tool-call argument delta without copying the argument prefix.
   * @param index - stream block index.
   * @param id - provider tool-call id.
   * @param name - optional tool name update.
   * @param argumentsDelta - raw JSON argument fragment.
   */
  toolCallDelta(index: number, id: string, name: string | undefined, argumentsDelta: string): void {
    const previous = this.slots[index]
    const slot = previous !== undefined && isMutableSlot(previous) && previous.kind === 'tool-call'
      ? previous
      : newSlot('tool-call') as ToolCallSlot
    if (previous?.kind === 'tool-call' && !isMutableSlot(previous)) {
      slot.callId = previous.callId
      slot.name = previous.name
      slot.argumentsText = previous.argsRaw
    }
    if (slot.callId === '') slot.callId = id
    if (name !== undefined) slot.name = name
    slot.argumentsText += argumentsDelta
    slot.version++
    this.slots[index] = slot
    this.dirty = true
  }

  /**
   * Set one completed provider block.
   * @param index - stream block index.
   * @param block - completed provider content block.
   */
  end(index: number, block: ContentBlock): void {
    this.slots[index] = toAssistantBlock(block)
    this.dirty = true
  }

  /**
   * Replace the complete accumulator with finalized blocks.
   * @param blocks - finalized UI blocks.
   */
  replace(blocks: readonly AssistantBlock[]): void {
    this.slots = [...blocks]
    this.value = [...blocks]
    this.dirty = false
  }

  /**
   * Materialize a stable snapshot, joining only slots changed since the last call.
   * @returns the current immutable block array.
   */
  snapshot(): AssistantBlock[] {
    if (!this.dirty) return this.value
    this.value = this.slots.flatMap(slot => slot === undefined ? [] : [materializeSlot(slot)])
    this.dirty = false
    return this.value
  }
}

/**
 * Whether a stream chunk changes the partial assistant projection shown by the UI.
 * @param type - Stream chunk discriminant.
 * @returns Whether publishing the accumulated partial can change the visible snapshot.
 */
export function isVisibleAssistantChunk(type: string): boolean {
  return type === 'block-start'
    || type === 'text-delta'
    || type === 'reasoning-delta'
    || type === 'tool-call-delta'
    || type === 'block-end'
}

/** assistant/chunk accumulator: folds StreamChunks into AssistantBlock[] with block-level immutability. */
export class PartialAccumulator {
  private readonly accumulator: IncrementalAssistantBlocks
  private changed = true
  private snapshot: PartialAssistant

  /**
   * @param turn - Owning agent turn.
   * @param step - Owning model step.
   * @param initialBlocks - Materialized prefix when accumulation begins after history replay.
   */
  constructor(
    readonly turn: number,
    readonly step: number,
    initialBlocks: readonly AssistantBlock[] = [],
  ) {
    this.accumulator = new IncrementalAssistantBlocks(initialBlocks)
    this.snapshot = { turn, step, blocks: [...initialBlocks] }
  }

  /**
   * Fold one chunk.
   * @param chunk - the stream chunk.
   * @returns whether it caused a visible change (usage/finish return false, skipping notification).
   */
  push(chunk: StreamChunk): boolean {
    switch (chunk.type) {
      case 'block-start': {
        this.accumulator.start(chunk.index, chunk.blockType)
        this.changed = true
        return true
      }
      case 'text-delta': {
        this.accumulator.textDelta(chunk.index, chunk.text)
        this.changed = true
        return true
      }
      case 'reasoning-delta': {
        this.accumulator.reasoningDelta(chunk.index, chunk.text)
        this.changed = true
        return true
      }
      case 'tool-call-delta': {
        this.accumulator.toolCallDelta(chunk.index, String(chunk.id), chunk.name, chunk.argumentsDelta)
        this.changed = true
        return true
      }
      case 'block-end': {
        this.accumulator.end(chunk.index, chunk.block)
        this.changed = true
        return true
      }
      default:
        // usage / finish / merge-extensible unknown variants: no visible block change
        // (finish is immediately followed by the assistant/message that supersedes the partial).
        return false
    }
  }

  /**
   * Current partial projection.
   * @returns the cached snapshot (the blocks array reference only changes after a mutation).
   */
  toPartial(): PartialAssistant {
    if (this.changed) {
      this.snapshot = { turn: this.turn, step: this.step, blocks: this.accumulator.snapshot() }
      this.changed = false
    }
    return this.snapshot
  }
}

/**
 * Create the empty client projection for one streamed Assistant block kind.
 * @param blockType - wire block kind.
 * @returns empty projected block ready to receive deltas.
 */
export function emptyAssistantBlock(blockType: string): AssistantBlock {
  switch (blockType) {
    case 'text': return { kind: 'text', text: '' }
    case 'reasoning': return { kind: 'reasoning', text: '' }
    case 'tool-call': return { kind: 'tool-call', callId: '', name: '', argsRaw: '' }
    default: return { kind: 'other', block: null }
  }
}
