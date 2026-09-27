/** Markdown primitive chrome labels. */
export const zh = {
  'code.copy': '复制',
  'code.copied': '已复制',
  'footnotes': '脚注',
} satisfies Record<string, string>

/** Markdown namespace keys. */
export type MarkdownPreviewKey = keyof typeof zh

/** English labels, paired with the Chinese key set. */
export const en = {
  'code.copy': 'Copy',
  'code.copied': 'Copied',
  'footnotes': 'Footnotes',
} satisfies Record<MarkdownPreviewKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Markdown renderer code and footnote controls. */
    sidebarMarkdown: MarkdownPreviewKey
  }
}
