import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { TextThinkingParser } from '../src/text-thinking.ts'

function parsed(chunks: readonly string[]): { transformed: boolean; reasoning: string; text: string } {
  const parser = new TextThinkingParser()
  const parts = chunks.flatMap(chunk => parser.append(chunk).parts)
  const finish = parser.finish()
  parts.push(...finish.parts)
  return {
    transformed: finish.transformed,
    reasoning: parts.filter(part => part.type === 'reasoning').map(part => part.text).join(''),
    text: parts.filter(part => part.type === 'text').map(part => part.text).join(''),
  }
}

describe('TextThinkingParser', () => {
  it('waits for a complete prefix before classifying reasoning', () => {
    const parser = new TextThinkingParser()
    expect(parser.append('<thi')).toEqual({ parts: [], transformed: false })
    expect(parser.append('nking>plan')).toEqual({ parts: [], transformed: false })
    expect(parser.append('</thinking>answer')).toEqual({
      parts: [
        { type: 'reasoning', text: 'plan', complete: true },
        { type: 'text', text: 'answer', complete: false },
      ],
      transformed: true,
    })
    expect(parser.finish()).toEqual({ parts: [], transformed: true })
  })

  it('streams answer fragments appended after a tagged prefix was transformed', () => {
    const parser = new TextThinkingParser()
    expect(parser.append('<thinking>plan</thinking>ans')).toEqual({
      parts: [
        { type: 'reasoning', text: 'plan', complete: true },
        { type: 'text', text: 'ans', complete: false },
      ],
      transformed: true,
    })
    expect(parser.append('wer')).toEqual({
      parts: [{ type: 'text', text: 'wer', complete: false }],
      transformed: true,
    })
  })

  it('withholds formatting whitespace until the first token classifies the block', () => {
    const parser = new TextThinkingParser()
    expect(parser.append('\n  ')).toEqual({ parts: [], transformed: false })
    expect(parser.append('answer')).toEqual({
      parts: [{ type: 'text', text: '\n  answer', complete: false }],
      transformed: false,
    })
  })

  it.each(['analysis', 'think'])('recognizes the %s tag', (tag) => {
    const parser = new TextThinkingParser()
    expect(parser.append(`<${tag}>work</${tag}>done`)).toEqual({
      parts: [
        { type: 'reasoning', text: 'work', complete: true },
        { type: 'text', text: 'done', complete: false },
      ],
      transformed: true,
    })
  })

  it('keeps leading formatting in the reasoning block', () => {
    const parser = new TextThinkingParser()
    expect(parser.append('\n  <thinking>work</thinking>answer')).toEqual({
      parts: [
        { type: 'reasoning', text: '\n  work', complete: true },
        { type: 'text', text: 'answer', complete: false },
      ],
      transformed: true,
    })
  })

  it('preserves an unclosed tag as ordinary text', () => {
    const parser = new TextThinkingParser()
    expect(parser.append('<thinking>partial')).toEqual({ parts: [], transformed: false })
    expect(parser.finish()).toEqual({
      parts: [{ type: 'text', text: '<thinking>partial', complete: true }],
      transformed: false,
    })
  })

  it('preserves empty tagged content and ordinary XML', () => {
    const empty = new TextThinkingParser()
    expect(empty.append('<thinking></thinking>answer')).toEqual({
      parts: [{ type: 'text', text: '<thinking></thinking>answer', complete: false }],
      transformed: false,
    })

    const xml = new TextThinkingParser()
    expect(xml.append('<thinking-note>answer')).toEqual({
      parts: [{ type: 'text', text: '<thinking-note>answer', complete: false }],
      transformed: false,
    })
  })

  it('does not inspect tags after ordinary text or inside a code fence', () => {
    const ordinary = new TextThinkingParser()
    expect(ordinary.append('Answer: <thinking>work</thinking>')).toEqual({
      parts: [{ type: 'text', text: 'Answer: <thinking>work</thinking>', complete: false }],
      transformed: false,
    })

    const fenced = new TextThinkingParser()
    expect(fenced.append('```xml\n<thinking>work</thinking>\n```')).toEqual({
      parts: [{ type: 'text', text: '```xml\n<thinking>work</thinking>\n```', complete: false }],
      transformed: false,
    })
  })

  it('closes a transformed trailing text block at finish', () => {
    const parser = new TextThinkingParser()
    expect(parser.append('<thinking>work</thinking>')).toEqual({
      parts: [{ type: 'reasoning', text: 'work', complete: true }],
      transformed: true,
    })
    expect(parser.finish()).toEqual({ parts: [], transformed: true })
  })

  it('uses cumulative final text to recover a missing suffix', () => {
    const parser = new TextThinkingParser()
    expect(parser.append('ans')).toEqual({
      parts: [{ type: 'text', text: 'ans', complete: false }],
      transformed: false,
    })
    expect(parser.finish('answer')).toEqual({
      parts: [{ type: 'text', text: 'wer', complete: true }],
      transformed: false,
    })
  })

  it('keeps highly fragmented reasoning input lossless', () => {
    const parser = new TextThinkingParser()
    const body = 'x'.repeat(20_000)
    const parts = [...parser.append('<thinking>').parts]
    for (const fragment of body) parts.push(...parser.append(fragment).parts)
    parts.push(...parser.append('</thinking>answer').parts)
    parts.push(...parser.finish().parts)
    expect(parts).toEqual([
      { type: 'reasoning', text: body, complete: true },
      { type: 'text', text: 'answer', complete: false },
    ])
  })

  it('classifies the same content independently of stream chunk boundaries', () => {
    fc.assert(fc.property(fc.array(fc.string(), { minLength: 1 }), (chunks) => {
      expect(parsed(chunks)).toEqual(parsed([chunks.join('')]))
    }))
  })
})
