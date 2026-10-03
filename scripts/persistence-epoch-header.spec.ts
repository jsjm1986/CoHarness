/** The current-format codec retains the native reader's retired-field refusal. */
import { expect, it } from 'vitest'
import { assertV7RowAdmission } from '@deepseek-ai/dsh-session-format-v6-to-v7'

it('rejects retired header.system in V7 request/header rows', () => {
  expect(() => {
    assertV7RowAdmission({
      type: 'request/header',
      data: { header: { system: 'retired text' } },
    })
  }).toThrow('format v7 request/header rejects retired header.system')
})
