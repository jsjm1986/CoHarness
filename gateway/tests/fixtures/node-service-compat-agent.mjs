/** Run the node channel in an isolated process against fixture-owned Gateway listeners. */
import { once } from 'node:events'

const compiled = process.argv[2] === 'lib'
const load = name => import(new URL(`../../${compiled ? 'lib' : 'src'}/${name}.${compiled ? 'js' : 'ts'}`, import.meta.url))
const [{ runNodeChannel }, { loadNodeChannelClientLimits }, { NodeDialer }] = await Promise.all([
  load('node-channel-client'), load('node-channel-protocol'), load('node-dialer'),
])

const lifetime = new AbortController()
process.once('disconnect', () => lifetime.abort())
const [config] = await once(process, 'message', { signal: lifetime.signal })
process.on('message', message => { if (message === 'stop') lifetime.abort() })
try {
  await runNodeChannel({
    dialer: new NodeDialer([config.center], 60_000, () => {}),
    credential: config.credential,
    lease: config.lease,
    limits: loadNodeChannelClientLimits({}),
    requestTimeoutMs: 5_000,
    retryMs: 60_000,
    localGatewayUrl: config.local,
    maxServices: config.maxServices,
  }, lifetime.signal, event => process.send?.(event),
  async () => ({ platform: 'linux', architecture: 'x64', uptimeSeconds: 1, executionReady: false }))
} finally {
  if (process.connected) process.disconnect()
}
