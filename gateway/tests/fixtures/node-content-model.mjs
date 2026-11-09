/** Exercise the installed Runtime Messages adapter against one strictly loopback model. */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const runtime = createRequire(new URL('../../../packages/llm/llm-deepseek-api-key/package.json',import.meta.url))
const transport=await import(pathToFileURL(runtime.resolve('@deepseek-ai/dsh-llm-deepseek')).href)
const llm=await import(pathToFileURL(runtime.resolve('@deepseek-ai/dsh-llm')).href)

/** @param {string} url loopback provider root. @param {string} key ephemeral credential read through the Gateway.
 * @param {string} prompt signed and admitted message. @returns {Promise<string>} model response assembled by the production adapter.
 */
export async function nodeContentModelReply(url,key,prompt) {
  if (new URL(url).hostname!=='127.0.0.1') throw new Error('Controlled model must be on loopback.')
  const files=new transport.DeepSeekFileStore()
  const adapter=new transport.DeepSeekAdapter({
    options:()=>transport.resolveAdapterOptions({baseURL:url}),
    resolveAuth:async()=>({headers:{'x-api-key':key}}),
    resolveUserId:()=>undefined, resolveAttachments:()=>undefined, resolveImageAccess:()=>undefined,
    resolveFiles:()=>files, prepareExtensions:async()=>({ fields:{},accept:async()=>{} }),
  })
  const output=new llm.BlockAssembler()
  for await (const item of adapter.stream({provider:'deepseek-official',model:'deepseek-v4-flash',
    messages:[llm.createUserMessage({source:{kind:'user'},content:[{type:'text',text:prompt}]})]})) output.push(item)
  return output.blocks().filter(block=>block.type==='text').map(block=>block.text).join('')
}
