/** Disposable Gateway whose independently surviving supervisor runs unchanged. */
import { LocalLauncher } from '../../../lib/launcher.js'
import { nativeFixture } from './spec.mjs'
const { cfg, runtime } = nativeFixture(process.argv[2])
await new LocalLauncher(cfg).start(runtime)
process.send({ ready: true })
setInterval(() => {}, 60_000)
