/** Preserve the module loader's opaque query while removing Gateway-only selection. */
import { expect, it } from 'vitest'
import { isExplicitScopeRequest, pinRuntimeRequestPath, runtimeRequestPath } from '../src/runtime-request-path.ts'
import type { RuntimeId } from '../src/runtime-catalog.ts'

const runtime = '10000000-0000-4000-8000-000000000001' as RuntimeId

it.each(['/plugins/@deepseek-ai/dsh-client-runtime/client.js??entry=a%2Fb&rev=one%20two', '/assets/a.js?x=%2f&empty=', '/api/session.list'])('preserves the original bytes of %s through node forwarding', path => {
  expect(runtimeRequestPath(pinRuntimeRequestPath(path, runtime))).toBe(path)
})

it('removes encoded selectors after authorization and retains unrelated arguments', () => {
  expect(runtimeRequestPath('/api/events?dsh%52untime=selected&scope=kept&dshTarget=personal&dshPrincipal=7&dshNode=node'))
    .toBe('/api/events?scope=kept')
  expect(pinRuntimeRequestPath(`/api/events?dshRuntime=${runtime}`, runtime)).toBe(`/api/events?dshRuntime=${runtime}`)
})

it.each(['/account/api/scope', '/account/runtime/start'])('treats a %s scope POST with dshRuntime as explicit', pathname => {
  expect(isExplicitScopeRequest('POST', new URL(`http://gateway${pathname}?dshRuntime=${runtime}`))).toBe(true)
  expect(isExplicitScopeRequest('POST', new URL(`http://gateway${pathname}`))).toBe(false)
  expect(isExplicitScopeRequest('GET', new URL(`http://gateway${pathname}?dshRuntime=${runtime}`))).toBe(false)
})
