// ask_user_question toolview: question-flavored summary row replacing the
// generic "Tool call" card, registered into the keyed
// 'tool.call.toolview' hole like todo-row. The row composes ToolRow
// (chrome, running sweep, whole-row expand) and swaps in the interaction
// outcome — `waiting` while pending, answered-count once settled, `cancelled`
// when the user dismissed the whole set — while settled and unanswered
// questions use a readable transcript card.

import { IconQuestionOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '../../contract/slots.ts'
import type { AskQuestionCardModel } from '../models/ask-question-card-model.ts'
import { singleResultText } from '../models/raw-tool-call.ts'
import { toolRowModel } from '../models/tool-call-model.ts'
import { ToolRow } from '../components/ToolRow.tsx'
import { CONVERSATION_NS as NS } from '../../locale.ts'

interface AnswerSummaryEntry { selected?: unknown; custom?: unknown }

function isAnswer(value: unknown): value is AnswerSummaryEntry {
  return typeof value === 'object' && value !== null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Answered-count summary from the result JSON (a skipped question has
 *  empty `selected` and no `custom`); null when answer fields are invalid. */
function answeredSummary(text: string, t: AskQuestionRowProps['t']): string | null {
  const parsed = parseJson(text)
  if (!isRecord(parsed)) return null
  const answers = (parsed as { answers?: unknown }).answers
  if (!Array.isArray(answers) || !answers.every(isAnswer)) return null
  const answered = answers.filter(a =>
    (Array.isArray(a.selected) && a.selected.length > 0)
    || (typeof a.custom === 'string' && a.custom !== '')).length
  return t('ask.answered', { answered, total: answers.length })
}

interface QuestionEntry { id: string; question: string }

interface ParsedAnswerEntry { id: string; selected: string[]; custom?: string }

/** Parse the question fields needed by the readable transcript card. */
function questionEntries(argsRaw: string): QuestionEntry[] | null {
  const parsed = parseJson(argsRaw)
  if (!isRecord(parsed) || !Array.isArray(parsed.questions) || parsed.questions.length === 0) return null
  const questions: QuestionEntry[] = []
  const ids = new Set<string>()
  for (const question of parsed.questions) {
    if (!isRecord(question) || typeof question.id !== 'string' || typeof question.question !== 'string' || ids.has(question.id)) {
      return null
    }
    ids.add(question.id)
    questions.push({ id: question.id, question: question.question })
  }
  return questions
}

/** Parse answer fields strictly enough to pair them with question ids. */
function answerEntries(text: string): ParsedAnswerEntry[] | null {
  const parsed = parseJson(text)
  if (!isRecord(parsed) || !Array.isArray(parsed.answers) || !parsed.answers.every(isRecord)) return null
  const answers: ParsedAnswerEntry[] = []
  for (const answer of parsed.answers) {
    if (typeof answer.id !== 'string'
      || !Array.isArray(answer.selected)
      || !answer.selected.every(item => typeof item === 'string')
      || (answer.custom !== undefined && typeof answer.custom !== 'string')) return null
    answers.push({
      id: answer.id,
      selected: answer.selected,
      ...(answer.custom === undefined ? {} : { custom: answer.custom }),
    })
  }
  return answers
}

/** Build a strict question/answer pairing, or null for ambiguous raw JSON. */
function answeredCard(argsRaw: string, text: string, skippedLabel: string): AskQuestionCardModel | null {
  const questions = questionEntries(argsRaw)
  const answers = answerEntries(text)
  if (questions === null || answers === null || questions.length !== answers.length) return null
  const byId = new Map<string, ParsedAnswerEntry>()
  for (const answer of answers) {
    if (byId.has(answer.id)) return null
    byId.set(answer.id, answer)
  }
  const paired: Array<{ id: string; question: string; answers: string[] }> = []
  for (const question of questions) {
    const answer = byId.get(question.id)
    if (answer === undefined) return null
    paired.push({
      id: question.id,
      question: question.question,
      answers: [...answer.selected, ...(answer.custom === undefined || answer.custom === '' ? [] : [answer.custom])],
    })
  }
  return { kind: 'answered', questions: paired, skippedLabel }
}

/** Full row props: the toolview runtime share plus the standard locale seat. */
type AskQuestionRowProps = ToolCallViewProps & PropsLocale<'conversation'>

/** One-line question-interaction row (the whole row toggles the call's
 *  Input/Output sections, ToolRow's unified expand). */
export function AskQuestionRow({ toolName, block, inspect, t }: AskQuestionRowProps) {
  const model = toolRowModel(toolName, block)
  // Composer verdicts settle the call as specific UserQuestionErrors
  // (apiproxy ask_user_question handler): 'ASK_CANCELLED' is the user's own
  // dismissal of the set, 'ASK_ABORTED' is a turn interrupt landing while the
  // question was pending. Both name their verdict instead of the generic
  // failed shape, and the abort keeps the shared stopped (amber) semantics of
  // any other interrupted tool call.
  const code = 'kind' in block ? block.error?.code : undefined
  const argsRaw = ('kind' in block ? block.call?.argsRaw : block.argsRaw) ?? ''
  let summary = model.summary
  let state = model.state
  let questionCard: AskQuestionCardModel | null = null
  if (code === 'ASK_CANCELLED') {
    summary = t('ask.cancelled')
    const questions = questionEntries(argsRaw)
    if (questions !== null) questionCard = { kind: 'unanswered', questions, verdict: t('ask.cancelledDetail') }
  } else if (code === 'ASK_ABORTED') {
    summary = t('ask.interrupted')
    state = 'stopped'
    const questions = questionEntries(argsRaw)
    if (questions !== null) questionCard = { kind: 'unanswered', questions, verdict: t('ask.interruptedDetail') }
  } else if (model.state === 'running') {
    summary = t('ask.waiting')
  } else if ('kind' in block && model.state === 'ok') {
    const text = singleResultText(block)
    if (text !== undefined) {
      const card = answeredCard(argsRaw, text, t('ask.skipped'))
      summary = answeredSummary(text, t) ?? model.summary
      if (card !== null) questionCard = card
    }
  }
  return (
    <ToolRow
      t={t}
      variant={model.variant}
      toolName={toolName}
      icon={<IconQuestionOutline14 />}
      title={t('ask.rowTitle')}
      summary={summary}
      bodyRaw={questionCard === null ? model.bodyRaw : null}
      output={questionCard === null ? model.output : null}
      askQuestion={questionCard}
      state={state}
      inspect={inspect}
    />
  )
}

/**
 * The ask-question row as a plain registrant plugin following the chat
 * toolview declaration across independent activation and reload lifetimes.
 */
export const askQuestionToolview = {
  name: 'ask-question-toolview',
  inject: ['slots'],
  /**
   * Register the ask-question row into the Tool-owned keyed view slot.
   * @param ctx - registrant context (disposal rides ctx.effect inside slots.register).
   */
  apply(ctx: Context): void {
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
      name: 'tool.call.toolview', key: 'ask_user_question', locale: NS,
    }, AskQuestionRow))
  },
}
