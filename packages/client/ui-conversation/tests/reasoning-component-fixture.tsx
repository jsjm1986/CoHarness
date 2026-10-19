/** Child-renderer stubs for component units; registry behavior uses the real runtime fixture. */
import { createElement, type ComponentProps } from 'react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReasoningContentInput } from '../src/client/contract/slots.ts'
import { ReasoningContent } from '../src/client/chat/ReasoningContent.tsx'
import { zh } from '../src/client/locales.ts'

const t = makeTranslate(zh, commonZh)

function content(input: ReasoningContentInput) {
  // The component only reads these inputs; unused framework seats are exercised in assembly tests.
  return createElement(ReasoningContent, { ...input, t } as ComponentProps<typeof ReasoningContent>)
}

/** Supply the official component at the Factory call seam of a standalone component unit. */
export const renderReasoningFactory: PropsRenderFactories['renderFactorySlot'] = (name, input) => {
  if (name !== 'conversation.chat.reasoning.content') throw new Error(`unexpected Factory: ${name}`)
  return content(input as ReasoningContentInput)
}
