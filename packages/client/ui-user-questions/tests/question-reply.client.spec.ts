/** Late-reply conversation node: source matching and payload projection. */
import { describe, expect, it } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { messageDefinition } from '../../ui-conversation/src/client/conversation-nodes/message.ts'
import { en } from '../src/client/locales.ts'
import type { QuestionReplyData } from '../src/client/question-reply.ts'
import { questionReplyDefinition, replyAnswerValues, replyClipboardText, replyPairsOf } from '../src/client/question-reply.ts'

const answered = JSON.stringify({
  kind: 'answer_to_pending_question',
  tool: 'ask_user_question',
  callId: 'call-1',
  questions: [{
    id: 'scope', question: 'Which scope?', header: 'Scope', detail: 'Choose the smallest useful surface.',
    options: [{ label: 'Tool only', description: 'Keep the change narrow.' }], multiSelect: false,
  }, { id: 'notes', question: 'Any notes?' }],
  answers: [{ id: 'scope', selected: ['Tool only'], custom: 'note' }, { id: 'notes', selected: [] }],
})
const dismissed = JSON.stringify({
  kind: 'dismissed_pending_question',
  tool: 'ask_user_question',
  callId: 'call-1',
  questions: [{ id: 'scope', question: 'Which scope?' }],
  message: 'The user dismissed these pending questions without answering.',
})

function message(source: Record<string, unknown>, text: string, surfaceOp: string | null = 'append') {
  return {
    type: 'user/message',
    seq: SessionSeq(7),
    time: 7_000,
    ...(surfaceOp === null ? {} : { surfaceOp }),
    data: { id: 'msg-1', role: 'user', source, content: [{ type: 'text', text }] },
  } as never
}

const replySource = (outcome: string) => ({ kind: 'user-question-reply', callId: 'call-1', outcome })

describe('replyPairsOf', () => {
  it('reads question and answer pairs, tolerating a payload without answers', () => {
    expect(replyPairsOf(answered)).toEqual({
      questions: [{
        id: 'scope', question: 'Which scope?', header: 'Scope', detail: 'Choose the smallest useful surface.',
        options: [{ label: 'Tool only', description: 'Keep the change narrow.' }], multiSelect: false,
      }, { id: 'notes', question: 'Any notes?' }],
      answers: [{ id: 'scope', selected: ['Tool only'], custom: 'note' }, { id: 'notes', selected: [] }],
    })
    expect(replyPairsOf(dismissed)).toEqual({ questions: [{ id: 'scope', question: 'Which scope?' }], answers: [] })
  })

  it('keeps only the well-formed options of a question and drops the rest', () => {
    const text = JSON.stringify({
      questions: [{ id: 'scope', question: 'Which scope?', options: [{ label: 'Tool only', description: 1 }, 'nope', { description: 'no label' }] }],
      answers: [],
    })
    expect(replyPairsOf(text).questions).toEqual([{ id: 'scope', question: 'Which scope?', options: [{ label: 'Tool only' }] }])
  })

  it('renders nothing structured for text it cannot read', () => {
    expect(replyPairsOf('not json')).toEqual({ questions: [], answers: [] })
    expect(replyPairsOf('{"questions":"nope"}')).toEqual({ questions: [], answers: [] })
    expect(replyPairsOf('{"questions":[{"id":1}],"answers":[{"id":"x"}]}')).toEqual({ questions: [], answers: [] })
  })
})

const t = makeTranslate(en)
const replyData = (overrides: Partial<QuestionReplyData> = {}): QuestionReplyData => ({
  callId: 'call-1',
  outcome: 'answered',
  questions: [{
    id: 'scope', question: 'Which scope?', header: 'Scope',
    options: [{ label: 'Tool only', description: 'Keep the change narrow.' }, { label: 'Whole package' }],
  }, { id: 'notes', question: 'Any notes?' }],
  answers: [{ id: 'scope', selected: ['Tool only'], custom: 'note' }, { id: 'notes', selected: [] }],
  text: answered,
  time: 7_000,
  ...overrides,
})

describe('replyAnswerValues', () => {
  it('orders selected labels before a non-blank custom answer', () => {
    const data = replyData()
    expect(replyAnswerValues(data, 'scope')).toEqual(['Tool only', 'note'])
    expect(replyAnswerValues(data, 'notes')).toEqual([])
    expect(replyAnswerValues(data, 'absent')).toEqual([])
    expect(replyAnswerValues(replyData({ answers: [{ id: 'scope', selected: [], custom: '  ' }] }), 'scope')).toEqual([])
    expect(replyAnswerValues(replyData({ answers: [{ id: 'scope', selected: [], custom: 'free text' }] }), 'scope'))
      .toEqual(['free text'])
  })
})

describe('replyClipboardText', () => {
  it('pairs every question with its answer and names the questions the user skipped', () => {
    expect(replyClipboardText(replyData(), t)).toBe(
      'Scope — Which scope?\nAnswer: Tool only, note\n\nAny notes?\nSkipped',
    )
  })

  it('drops a header that repeats its question', () => {
    const data = replyData({
      questions: [{ id: 'scope', question: 'Which scope?', header: 'Which scope?' }],
      answers: [{ id: 'scope', selected: ['Tool only'] }],
    })
    expect(replyClipboardText(data, t)).toBe('Which scope?\nAnswer: Tool only')
  })

  it('marks every question skipped for a dismissed reply', () => {
    const data = replyData({ outcome: 'dismissed' })
    expect(replyClipboardText(data, t)).toBe('Scope — Which scope?\nSkipped\n\nAny notes?\nSkipped')
  })

  it('falls back to the model-facing text when the payload carried no questions', () => {
    expect(replyClipboardText(replyData({ questions: [], text: 'not json' }), t)).toBe('not json')
  })
})

describe('questionReplyDefinition', () => {
  it('claims only appended user messages carrying the reply source', () => {
    expect(questionReplyDefinition.match(message(replySource('answered'), answered))).toEqual({ id: 'msg-1', role: 'start' })
    expect(questionReplyDefinition.match(message({ kind: 'user' }, answered))).toBeNull()
    expect(questionReplyDefinition.match(message({ kind: 'plugin', plugin: 'user-questions' }, answered))).toBeNull()
    expect(questionReplyDefinition.match(message(replySource('answered'), answered, null))).toBeNull()
  })

  it.each(['answered', 'dismissed'])('shares the message id with the generic projection for %s replies', (outcome) => {
    const event = message(replySource(outcome), outcome === 'answered' ? answered : dismissed)
    expect(messageDefinition.match(event)).toEqual({ id: 'msg-1', role: 'start' })
    expect(questionReplyDefinition.match(event)).toEqual(messageDefinition.match(event))
  })

  it('projects the outcome from the source and the pairs from the text into its own node', () => {
    const event = message(replySource('dismissed'), dismissed)
    const state = questionReplyDefinition.start({} as never, { event, id: 'msg-1', role: 'start' } as never, {} as never)
    expect(state).toMatchObject({
      seq: 7, time: 7_000, callId: 'call-1', outcome: 'dismissed',
      questions: [{ id: 'scope', question: 'Which scope?' }], answers: [], text: dismissed,
    })

    const node = questionReplyDefinition.buildViewNode!({ state, key: 'reply:1', id: 'msg-1', start: undefined } as never)
    expect(node).toMatchObject({
      key: 'reply:1', kind: 'question-reply', id: 'msg-1', target: 'chat', anchorSeq: 7, visibility: 'visible',
      location: { kind: 'unresolved' },
      data: { callId: 'call-1', outcome: 'dismissed', text: dismissed },
    })
    expect(node).not.toHaveProperty('data.seq')
    expect(questionReplyDefinition.update({ state } as never, {} as never)).toBe(state)
    expect(questionReplyDefinition.buildViewNode!({ state: undefined } as never)).toBeNull()
  })

  it('starts an empty record for a message without a reply source or text', () => {
    const untyped = {
      type: 'user/message', seq: SessionSeq(8), time: 8_000, surfaceOp: 'append',
      data: { id: 'msg-2', role: 'user', source: { kind: 'user' }, content: [{ type: 'image', source: { kind: 'inline', data: '', mediaType: 'image/png' } }] },
    } as never
    const state = questionReplyDefinition.start({} as never, { event: untyped, id: 'msg-2', role: 'start' } as never, {} as never)
    expect(state).toEqual({ seq: 8, time: 8_000, callId: '', outcome: 'answered', text: '', questions: [], answers: [] })
  })

  it('falls back to an answered outcome when the source carries an unknown one', () => {
    const event = message({ kind: 'user-question-reply', callId: 'call-1' }, answered)
    const state = questionReplyDefinition.start({} as never, { event, id: 'msg-1', role: 'start' } as never, {} as never)
    expect(state.outcome).toBe('answered')
    expect(() => questionReplyDefinition.start({} as never, {
      event: { ...(event as object), type: 'tool/call' }, id: 'x', role: 'start',
    } as never, {} as never)).toThrow(/requires user\/message/)
  })
})
