/** Link the actual external governance package into the owned SDK parent profile. */
import { mkdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** @param {string} home - owned Harness home; linked before boot computes peer resolution. */
export async function prepareGovernance(home) {
  const scope = join(home, 'profiles/sdk-minimal/node_modules/@deepseek-ai')
  await mkdir(scope, { recursive: true })
  await symlink(fileURLToPath(new URL('../../../../../plugins/dsh-model-governance/', import.meta.url)),
    join(scope, 'dsh-model-governance'), process.platform === 'win32' ? 'junction' : 'dir')
}
