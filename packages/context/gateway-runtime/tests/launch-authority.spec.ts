/** Launch identity belongs to one application and is released by that application's disposal. */
import { generateKeyPairSync } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it } from 'vitest'
import { launchAuthorityOf, type LaunchAuthority } from '../src/launch-authority.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

function application(): Context {
  const ctx = new Context(); contexts.push(ctx)
  return ctx
}

function authority(organization: string): LaunchAuthority {
  const { publicKey } = generateKeyPairSync('ed25519')
  return { credential: { version: 1, gatewayUrl: 'http://127.0.0.1:8899', organization,
    runtime: { kind: 'user', id: 7, generation: 1 }, token: 'synthetic-token',
    principalPublicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() }, publicKey }
}

it('retains one authority per application independently of provider scope', () => {
  const first = application(), second = application(), original = authority('first'), other = authority('second')
  expect(launchAuthorityOf(first.extend({}), () => original)).toBe(original)
  expect(launchAuthorityOf(first.extend({}), () => { throw new Error('The launch pipe must not be reread.') })).toBe(original)
  expect(launchAuthorityOf(second, () => other)).toBe(other)
})

it('allows a failed initial read to be repaired before retaining identity', () => {
  const ctx = application(), current = authority('repaired')
  expect(() => launchAuthorityOf(ctx, () => { throw new Error('private channel unavailable') })).toThrow('private channel unavailable')
  expect(launchAuthorityOf(ctx, () => current)).toBe(current)
})

it('removes its private retained credential when the owning application closes', async () => {
  const ctx = application(), current = authority('closing')
  const retained = () => Reflect.ownKeys(ctx).some(key => Object.getOwnPropertyDescriptor(ctx, key)?.value === current)
  launchAuthorityOf(ctx, () => current)
  expect(retained()).toBe(true)
  expect(Object.getOwnPropertyDescriptor(ctx, Symbol.for('dsh.gateway-runtime.launch-authority'))?.enumerable).toBe(false)
  await ctx.fiber.dispose()
  expect(retained()).toBe(false)
})
