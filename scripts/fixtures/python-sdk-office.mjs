/** Exercise the wheel's Office API and model-shell commands from a shipped profile. */
import { readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createConverter } from '@deepseek-ai/libreoffice-kit'

export const name = 'python-sdk-office-smoke'

export async function apply(ctx, config) {
  const skill = await ctx.skills.get('office-export-pdf')
  const json = skill?.content.match(/\n(\{\n[\s\S]+)$/u)?.[1]
  if (json === undefined) throw new Error('Office skill did not supply CLI paths')
  const { libreofficeKit: { node, cli: entry } } = JSON.parse(json)
  const options = { timeout: 120_000, env: { ...process.env, PATH: '' } }
  const capabilities = await promisify(execFile)(node, [entry, 'capabilities', '--json'], options)
  await promisify(execFile)(node, [entry, 'convert', '--input', config.input, '--output', config.output + '.cli.pdf'], options)
  const pdf = await readFile(config.output + '.cli.pdf')
  if (pdf.subarray(0, 5).toString() !== '%PDF-') throw new Error('Office shell command did not create a PDF')
  const converter = await createConverter({ timeoutMs: 120_000 })
  try {
    const result = await converter.render({ inputPath: config.input, outputPath: config.output })
    const images = await converter.renderImages({ inputPath: config.imageInput, outputDir: config.imageOutput, pages: [1], dpi: 72 })
    await writeFile(config.result, JSON.stringify({ ...result, images, capabilities: JSON.parse(capabilities.stdout), moduleUrl: import.meta.resolve('@deepseek-ai/libreoffice-kit') }))
  } finally {
    await converter.dispose()
  }
}
