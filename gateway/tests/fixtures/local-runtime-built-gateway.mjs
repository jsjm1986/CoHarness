/** Plain-Node Gateway-side owner fixture; imports only compiled Gateway entries. */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { loadConfig } from '../../lib/config.js'
import { LocalLauncher } from '../../lib/launcher.js'

const root = process.env.LOCAL_RUNTIME_FIXTURE_ROOT
const cfg = loadConfig({ HGW_STATE_ROOT: join(root, 'state') })
cfg.dshRepoRoot = fileURLToPath(new URL('../../../', import.meta.url))
cfg.dshCommand = [process.execPath, fileURLToPath(new URL('./local-runtime-server.mjs', import.meta.url)), join(root, 'ready.json')]
await new LocalLauncher(cfg).start({ kind: 'project', ownerId: 7, username: 'fixture', runtimeKey: 'project-7', systemUser: 'fixture',
  port: 0, homePath: root, dshHome: root, generation: 2, credentialHash: 'a'.repeat(64), gatewayCredential: '{"fixture":true}' })
process.send({ kind: 'ready' })
setInterval(() => {}, 1000)
