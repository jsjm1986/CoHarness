/** Exact local allocation shared by the disposable Gateway and recovered controller. */
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../../../lib/config.js'

/** @param {string} root - owned test directory. @returns the matching Gateway configuration and allocation. */
export function nativeFixture(root) {
  const cfg = loadConfig({ HGW_STATE_ROOT: `${root}/state` })
  cfg.dshRepoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
  cfg.dshCommand = [process.execPath, fileURLToPath(new URL('./runtime.mjs', import.meta.url)), 'runtime', root]
  const runtime = { kind: 'project', ownerId: 7, username: 'fixture', runtimeKey: 'project-7', systemUser: 'fixture',
    port: 0, homePath: root, dshHome: root, generation: 2, credentialHash: 'a'.repeat(64), gatewayCredential: '{"fixture":true}' }
  return { cfg, runtime }
}
