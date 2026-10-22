/** Comment-preserving profile plugin enablement edits. */
import { readFile } from 'node:fs/promises'
import { isMap, isSeq, parseDocument } from 'yaml'
import { loadOptionalPatches } from '@deepseek-ai/dsh-app-boot'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

/** Replace the last matching override or append one after existing insertions.
 * @param filename Current profile patch file.
 * @param id Unique composition entry id.
 * @param name Module name used to match name-qualified overrides.
 * @param enabled Desired entry enablement.
 * @returns Whether the file changed.
 */
export async function writePluginEnabled(filename: string, id: string, name: string, enabled: boolean): Promise<boolean> {
  let text: string
  try {
    text = await readFile(filename, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    text = '[]\n'
  }
  const document = parseDocument(text, {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
  })
  const error = document.errors[0]
  if (error !== undefined) throw error
  if (!isSeq(document.contents)) throw new Error('Profile patch must be a YAML sequence')
  loadOptionalPatches('dsh', filename)
  const items = document.contents.items
  const target = items.findLast((item, index) => {
    if (!isMap(item) || document.getIn([index, 'id']) !== id || item.has('insert')) return false
    const expectedName = document.getIn([index, 'name'])
    return !expectedName || expectedName === name
  })
  if (isMap(target)) {
    if (document.getIn([items.indexOf(target), 'disabled']) === !enabled) return false
    document.setIn([items.indexOf(target), 'disabled'], !enabled)
  } else {
    document.add({ id, disabled: !enabled })
  }
  await writeFileAtomic(filename, String(document), { mode: 0o600 })
  return true
}

/**
 * Write a managed row's `config` object, replacing any earlier override for
 * the same entry. `null` removes the config key so composition defaults apply.
 * @param filename Current profile patch file.
 * @param id Unique composition entry id.
 * @param name Module name used to match name-qualified overrides.
 * @param config Plain JSON-serializable configuration, or `null` to clear it.
 * @returns Whether the file changed.
 */
export async function writePluginConfig(
  filename: string, id: string, name: string, config: unknown,
): Promise<boolean> {
  let text: string
  try {
    text = await readFile(filename, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    text = '[]\n'
  }
  const document = parseDocument(text, {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
  })
  const error = document.errors[0]
  if (error !== undefined) throw error
  if (!isSeq(document.contents)) throw new Error('Profile patch must be a YAML sequence')
  loadOptionalPatches('dsh', filename)
  const items = document.contents.items
  const target = items.findLast((item, index) => {
    if (!isMap(item) || document.getIn([index, 'id']) !== id || item.has('insert')) return false
    const expectedName = document.getIn([index, 'name'])
    return !expectedName || expectedName === name
  })
  if (isMap(target)) {
    const index = items.indexOf(target)
    if (config === null) {
      if (!target.has('config')) return false
      target.delete('config')
      // A row created only to carry the override leaves a no-op entry behind;
      // rows that also disable or otherwise annotate the plugin stay.
      if (target.items.every(pair => pair.key?.toString() === 'id' || pair.key?.toString() === 'name')) items.splice(index, 1)
    } else {
      document.setIn([index, 'config'], config)
    }
  } else {
    if (config === null) return false
    document.add({ id, name, config })
  }
  await writeFileAtomic(filename, String(document), { mode: 0o600 })
  return true
}
