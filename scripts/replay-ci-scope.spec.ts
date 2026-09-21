import { expect, it } from 'vitest'
import { reducedConsumerRule } from './replay-ci-scope.ts'

it('accepts inert consumer documentation but refuses an unclaimed runtime reduction', () => {
  expect(reducedConsumerRule('gatewayMode', ['gateway/README.md', 'packages/util/timeout/src/index.ts'])).toBe('inert-consumer-documentation')
  expect(reducedConsumerRule('gatewayMode', ['gateway/src/server.ts'])).toBeUndefined()
  expect(reducedConsumerRule('pythonMode', ['python/sdk/session.py'])).toBeUndefined()
  expect(reducedConsumerRule('adminUiMode', ['gateway/admin-ui/README.md'])).toBe('inert-consumer-documentation')
})
