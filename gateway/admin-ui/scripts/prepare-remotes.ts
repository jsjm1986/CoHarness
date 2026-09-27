/** Emit only the administrator's Host Remote codecs from their owning source definitions. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { WorkspaceTypertGenerator } from '../../../packages/typert/generator/src/workspace.ts'

const root = resolve(import.meta.dirname, '../../..')
const packages = ['@deepseek-ai/dsh-plugin-manager', '@deepseek-ai/dsh-host-plugin-inventory']
const artifacts = new WorkspaceTypertGenerator(root).generate(packages, ['host'])
for (const name of packages) {
  const artifact = artifacts.find(value => value.package === name && value.face === 'host')
  if (artifact?.remote === undefined) throw new Error(`Admin Remote generation: ${name} has no Host Remote contribution`)
  const output = resolve(root, artifact.packageRoot, 'lib')
  mkdirSync(output, { recursive: true })
  writeFileSync(resolve(output, 'typert.remote-client.js'), artifact.remote.js)
  writeFileSync(resolve(output, 'typert.remote-client.d.ts'), artifact.remote.dts)
  writeFileSync(resolve(output, 'typert.remote-client.d.ts.map'), artifact.remote.dtsMap)
}
console.log(`Admin Remote generation: ${artifacts.length} Host contributions`)
