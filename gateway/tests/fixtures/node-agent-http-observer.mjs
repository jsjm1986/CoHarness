/** Test-only native-fetch observer; IPC confirms received headers before a real response body is interrupted. */
const nativeFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const response = await nativeFetch(input, init)
  if (response.headers.get('x-hgw-test-partial-control-body') === '1') {
    process.send?.({ type: 'node-control-headers-received' })
  }
  return response
}
