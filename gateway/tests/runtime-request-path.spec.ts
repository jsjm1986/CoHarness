/** Preserve the module loader's opaque query while removing Gateway-only selection. */
import { expect, it } from 'vitest'
import { isDelegatablePersonalRead, isExplicitScopeRequest, isImmutableRuntimeAssetRequest, isPersonalExecutionWriteRequest, isReadyRuntimeInteractive, isReadyRuntimeRead, isRuntimeAssetRequest, pinRuntimeRequestPath, runtimeRequestPath, withoutRuntimeAssetPreload } from '../src/runtime-request-path.ts'
import type { RuntimeId } from '../src/runtime-catalog.ts'

const runtime = '10000000-0000-4000-8000-000000000001' as RuntimeId

it.each([
  '/plugins/combo.js??@deepseek-ai/dsh-client-runtime/client.js&rev=012345abcdef',
  '/plugins/combo.js??@deepseek-ai/dsh-client-runtime/client.js.map,fixture/client.js.map&rev=012345abcdef',
  `/plugins/@deepseek-ai/dsh-client-runtime/client.lazy-chunk.js?rev=${'a'.repeat(64)}`,
  '/plugins/fixture/client.lazy.js.map?rev=012345abcdef',
  '/assets/index-abcdEF12.js',
  '/assets/index-abcdEF12.css.map',
])('admits only GET and HEAD for the immutable resource protocol %s', path => {
  for (const selected of [path, pinRuntimeRequestPath(path, runtime) + '&dshTarget=personal']) {
    expect(isImmutableRuntimeAssetRequest('GET', selected)).toBe(true)
    expect(isImmutableRuntimeAssetRequest('HEAD', selected)).toBe(true)
    expect(isImmutableRuntimeAssetRequest('POST', selected)).toBe(false)
  }
})

it.each([
  '/', '/favicon.svg', '/plugins/events?rev=012345abcdef', '/api/session.list?rev=012345abcdef',
  '/plugins/combo.js', '/plugins/combo.js??fixture/client.js&rev=',
  '/plugins/combo.js??fixture/client.js&rev=012345abcdef&rev=012345abcdef',
  '/plugins/combo.js??fixture/client.js&rev=012345abcdef&extra=1',
  '/plugins/combo.js??fixture/settings.js&rev=012345abcdef',
  '/plugins/combo.js??../client.js&rev=012345abcdef',
  '/plugins/combo.js??fixture/client.js,fixture/client.js.map&rev=012345abcdef',
  '/plugins/combo.js??fixture/client.js&rev=not-a-revision',
  '/plugins/fixture/client.js?rev=012345abcdef',
  '/plugins/fixture/client.lazy.js?rev=012345abcdef&extra=1',
  '/plugins/fixture/client.lazy.js?rev=012345abcdef&rev=012345abcdef',
  '/assets/index.js', '/assets/index-abcdEF12.js?extra=1', '/assets/path/index-abcdEF12.js',
])('keeps nonimmutable or malformed resource requests out of read-only admission: %s', path => {
  expect(isImmutableRuntimeAssetRequest('GET', path)).toBe(false)
  expect(isImmutableRuntimeAssetRequest('HEAD', path)).toBe(false)
})

it.each(['/assets/index-12345678.js', '/favicon.svg', '/plugins/combo.js', '/plugins/runtime/client.js', '/plugins/runtime/client.css.map'])(
  'treats %s as observation-only browser resource traffic', pathname => {
    expect(isRuntimeAssetRequest('GET', pathname)).toBe(true)
    expect(isRuntimeAssetRequest('HEAD', pathname)).toBe(true)
    expect(isRuntimeAssetRequest('POST', pathname)).toBe(false)
  },
)

it.each(['/', '/plugins/events', '/plugins/runtime/settings', '/api/prepare/v1/session.create', '/api/events.mux'])(
  'keeps %s on its existing operation route', pathname => {
    expect(isRuntimeAssetRequest('GET', pathname)).toBe(false)
    expect(isRuntimeAssetRequest(undefined, pathname)).toBe(false)
  },
)

it.each(['/plugins/@deepseek-ai/dsh-client-runtime/client.js??entry=a%2Fb&rev=one%20two', '/assets/a.js?x=%2f&empty=', '/api/session.list'])('preserves the original bytes of %s through node forwarding', path => {
  expect(runtimeRequestPath(pinRuntimeRequestPath(path, runtime))).toBe(path)
})

it('removes only the scheduling hint on the node hop, and preserves original combo and Runtime selection bytes', () => {
  const batch = '/plugins/combo.js??@deepseek-ai/fixture/client.js,second/client.js&rev=012345abcdef'
  const selection = `&dsh%52untime=${runtime}&dshTarget=project%3a5`
  const marked = `${batch}&dshAssetPreload=1${selection}`
  expect(withoutRuntimeAssetPreload('GET', marked)).toBe(batch + selection)
  expect(runtimeRequestPath(marked, 'GET')).toBe(batch)
  expect(isImmutableRuntimeAssetRequest('GET', marked)).toBe(true)
  expect(isImmutableRuntimeAssetRequest('HEAD', marked)).toBe(false)
  expect(isImmutableRuntimeAssetRequest('POST', marked)).toBe(false)
})

it.each([
  '/api/session.list', '/assets/index-abcdEF12.js',
  '/plugins/combo.js??a/client.js&rev=012345abcdef',
  '/plugins/combo.js??a/client.js.map,b/client.js.map&rev=012345abcdef',
  '/plugins/combo.js??a/client.js,b/client.js&rev=invalid',
  '/plugins/combo.js??a/client.js,b/client.js&rev=012345abcdef&dshAssetPreload=1',
  '/plugins/combo.js??a/client.js,b/client.js&rev=012345abcdef&dshAssetPreload=0',
  '/plugins/combo.js??a/client.js,b/client.js&rev=012345abcdef&dshAsset%50reload=1',
])('does not reinterpret a scheduling argument on %s', path => {
  const marked = `${path}${path.includes('?') ? '&' : '?'}dshAssetPreload=1`
  expect(withoutRuntimeAssetPreload('GET', marked)).toBe(marked)
  expect(runtimeRequestPath(marked, 'GET')).toBe(marked)
  expect(isImmutableRuntimeAssetRequest('GET', marked)).toBe(false)
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

it.each([
  ['POST', '/api/session.history', true],
  ['POST', '/api/host.describe', true],
  ['POST', '/api/workspace.list', true],
  ['POST', '/api/workspaceFiles.list', true],
  ['POST', '/api/workspaceFiles.stat', false],
  ['POST', '/api/workspaceFiles.read', false],
  ['POST', '/api/workspaceFiles.readBytes', false],
  ['POST', '/api/workspaceFiles.list/extra', false],
  ['GET', '/api/workspaceFiles.list', false],
  ['HEAD', '/api/workspaceFiles.list', false],
  ['POST', '/api/session.list', true],
  ['GET', '/?dshBootstrap=1', true],
  ['GET', '/?dshBootstrap=full', false],
  ['GET', '/?dshBootstrap=1&dshBootstrap=full', false],
  ['GET', '/api/session.history', false],
  ['POST', '/api/session.create', false],
  ['POST', '/api/workspace/move', false],
  ['POST', '/api/session.history/extra', false],
])('selects %s %s for ready Runtime reads if eligible (%s)', (method, path, eligible) => {
  expect(isReadyRuntimeRead(method, new URL(path, 'http://gateway'))).toBe(eligible)
})

it.each([
  ['GET', '/?dshBootstrap=1', false, 'application/json'],
  ['GET', '/?dshBootstrap=1', true, 'text/html'],
  ['GET', '/?dshBootstrap=1&dshBootstrap=1', true, 'application/json'],
  ['GET', '/?dshBootstrap=full', true, 'application/json'],
  ['POST', '/api/workspace.list', false, 'application/json'],
  ['POST', '/api/workspaceFiles.list', true, 'application/json'],
  ['POST', '/api/prepare/v1/session.create', true, 'application/json'],
  ['POST', '/api/admit/v1/session.prompt', true, 'application/json'],
])('does not delegate %s %s (%s, %s)', (method, path, accountBound, accept) => {
  expect(isDelegatablePersonalRead(method, new URL(path, 'http://gateway'), accountBound, accept)).toBe(false)
})

it('selects interactive terminal write/resize RPCs for ready-session admission and personal terminal-authorize fence', () => {
  expect(isReadyRuntimeInteractive('POST', '/api/terminal/write')).toBe(true)
  expect(isReadyRuntimeInteractive('POST', '/api/terminal/resize')).toBe(true)
  expect(isReadyRuntimeInteractive('GET', '/api/terminal/write')).toBe(false)
  expect(isReadyRuntimeInteractive('POST', '/api/terminal/create')).toBe(false)
  expect(isPersonalExecutionWriteRequest('/internal/runtime/execution/terminal-authorize', 'POST')).toBe(true)
  expect(isPersonalExecutionWriteRequest('/internal/runtime/execution/terminal-authorize', 'GET')).toBe(false)
})
