/**
 * Deliverables plugin, node half. Registers the response-format guidance that
 * lets the browser half recognize final-response file references. The browser
 * half ships via exports["./client"], discovered through the package.json
 * dsh.client declaration.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Services required for the model guidance paired with the browser renderer. */
export const inject = ['systemPrompt']

/** Stable final-response guidance owned by the matching renderer. */
const FILE_REFERENCE_PROMPT = 'Prefer showing the primary results within your final response alongside a brief explanation. '
  + 'Use ![Description](<path/to/image.png>) when an image supports an explanation or comparison; it appears inline and opens a larger preview on click. '
  + 'Use [Description](<path/to/image.png>) when referring to an image or listing files; image links offer a hover preview and open in the sidebar on click. '
  + 'Enclose Markdown file destinations in angle brackets, especially paths containing spaces. '
  + 'Include a file link alongside an inline image so it remains accessible in clients that cannot display images inline. '
  + 'Do not call present just to list edited source files, or run commands to check whether a diff view will appear. '
  + 'Use present when a separate file card helps the user open the complete deliverable, especially Office documents, spreadsheets, and slide decks. Each presented file adds a card below the reply, with preview and native-open actions. '
  + 'Usually select the 1-2 most important deliverables; include more when needed, but at most 4 files in a single present call. Avoid repeating results already shown inline unless the separate card adds useful access. '
  + 'Outside commands, configuration expressions, and code blocks, link every mention of an existing file, including repeats and tables, to its full path relative to the working directory or absolute; append #L24 or #L24-L30 to the target for known lines. '
  + 'Use the filename or a clear alias as the label, adding only enough parent directories to distinguish files; keep full paths out of labels. Default to the name alone; when precise locations matter, append :24 or :24–30, with no # or L in the line suffix.'

/**
 * Register model guidance for the file-reference renderer shipped by this package.
 * @param ctx - host context carrying the system-prompt registry.
 */
export function apply(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'ui:deliverable-file-references',
    order: ctx.systemPrompt.getSectionOrder('DELIVERABLE_FILE_REFERENCES'),
    text: FILE_REFERENCE_PROMPT,
  })
}
