/** Pure draft-decoration projection shared by the input machine and shell. */

import type { InputState } from '../input/contract.ts'

/** Claim-token highlight range. */
export interface TokenRange { readonly start: number; readonly end: number }

/** Structured inline-reference render instruction. */
export interface ChipRender {
  readonly occurrenceId: number
  readonly offset: number
  readonly length: number
  readonly text: string
  readonly label: string
  readonly appearance?: 'session' | 'file' | 'folder'
  readonly invalid: boolean
}

/** Plain-text reference range. */
export interface TextRefRange {
  readonly start: number
  readonly end: number
  readonly trigger: '/' | '@'
  readonly appearance?: 'folder'
}

/** Decoration product consumed by the composer mirror layer. */
export interface DraftDecorations {
  readonly token: TokenRange | null
  readonly chips: readonly ChipRender[]
  readonly textRefs: readonly TextRefRange[]
  readonly hint: string | null
}

const TEXT_REF_RE = /(^|\s)([/@])([\w-]+)/g
const FOLDER_REF_RE = /(^|\s)(@(?:"[^"\n]*\/|[^\s"]+\/))/g

/**
 * Scan draft text against the trigger lexicons.
 * @param draft - draft text.
 * @param lexicon - per-trigger reference names.
 * @returns matched ranges in draft order.
 */
export function scanTextRefs(
  draft: string, lexicon: ReadonlyMap<'/' | '@', readonly string[]>,
): TextRefRange[] {
  if (draft === '') return []
  const out: TextRefRange[] = []
  if (lexicon.size > 0) {
    TEXT_REF_RE.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = TEXT_REF_RE.exec(draft)) !== null) {
      const trigger = match[2] as '/' | '@'
      const name = match[3] ?? ''
      if (lexicon.get(trigger)?.includes(name)) {
        const start = match.index + (match[1]?.length ?? 0)
        out.push({ start, end: start + 1 + name.length, trigger })
      }
    }
  }
  FOLDER_REF_RE.lastIndex = 0
  let folder: RegExpExecArray | null
  while ((folder = FOLDER_REF_RE.exec(draft)) !== null) {
    const token = folder[2] ?? ''
    const start = folder.index + (folder[1]?.length ?? 0)
    const end = start + token.length
    if (!out.some(range => range.start < end && range.end > start)) {
      out.push({ start, end, trigger: '@', appearance: 'folder' })
    }
  }
  return out.sort((left, right) => left.start - right.start)
}

const EMPTY_LEXICON: ReadonlyMap<'/' | '@', readonly string[]> = new Map()

/**
 * Derive mirror-layer decorations from input state.
 * @param state - published input state.
 * @param lexicon - optional trigger lexicons.
 * @returns token, chips, text references, and hint.
 */
export function deriveDecorations(
  state: InputState, lexicon: ReadonlyMap<'/' | '@', readonly string[]> = EMPTY_LEXICON,
): DraftDecorations {
  const { draft, claim, phase, occurrences } = state
  const claimActive = (phase === 'claimed' || phase === 'submitting')
    && claim !== undefined && draft.startsWith(claim.token)
  const token: TokenRange | null = claimActive ? { start: 0, end: claim.token.length } : null
  const chips = occurrences.map(o => ({
    occurrenceId: o.occurrenceId,
    offset: o.offset,
    length: o.length,
    text: draft.slice(o.offset, o.offset + o.length),
    label: o.label,
    ...o.appearance === undefined ? {} : { appearance: o.appearance },
    invalid: o.invalid === true,
  }))
  const hint = claimActive && claim.hint !== undefined && draft.slice(claim.token.length).trim() === ''
    ? claim.hint
    : null
  return { token, chips, textRefs: scanTextRefs(draft, lexicon), hint }
}
