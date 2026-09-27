/** Keyless model script exercising current and retired Cordis names through real dispatch. */
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

const CALLS = [
  { name: 'cordis_inspect_list', args: {} },
  { name: 'cordis_inspect_query', args: { platform: 'host', provider: 'Tool', method: 'listTools' } },
  { name: 'cordis_inspect_self', args: {} },
  { name: 'cordis_define', args: { plugin: { kind: 'new', idPrefix: 'probe' }, name: 'Probe', purpose: 'Unreachable', code: { host: 'return { apply() {} }' } } },
  { name: 'cordis_run', args: { pluginId: 'probe-1', packageId: 'pkg-1', mode: 'run' } },
  { name: 'cordis_stop', args: { pluginId: 'probe-1' } },
  { name: 'cordis_undefine', args: { pluginId: 'probe-1' } },
] as const

class InspectionAdapter extends LlmAdapter {
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const results = options.messages.flatMap(message => message.content.filter(block => block.type === 'tool-result'))
    if (results.length === 0) {
      for (const [index, call] of CALLS.entries()) {
        const block = { type: 'tool-call' as const, id: ToolCallId(`inspection-${index}`), name: call.name, arguments: JSON.stringify(call.args) }
        yield { type: 'block-start', index, blockType: 'tool-call' }
        yield { type: 'block-end', index, block }
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    if (results.length !== CALLS.length) throw new Error('inspection script did not receive every tool result')
    const text = 'CORDIS_READ_ONLY_OK'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'cordis-inspection-llm'
export const inject = ['llm']

/** Register the deterministic external-model substitute.
 * @param ctx - Real Loader-owned test plugin context.
 */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['cordis-inspection'], new InspectionAdapter())
}
