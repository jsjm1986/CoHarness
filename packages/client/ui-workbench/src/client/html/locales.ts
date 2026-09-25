/** Locale-owned HTML iframe status text. */
export const zh = {
  frame: 'HTML 文档预览',
  loading: '正在读取…',
  failed: '无法预览这份 HTML 文档',
} satisfies Record<string, string>

/** HTML renderer dictionary keys. */
export type HtmlPreviewKey = keyof typeof zh

/** English dictionary with the same keys as the Chinese dictionary. */
export const en = {
  frame: 'HTML document preview',
  loading: 'Reading…',
  failed: 'This HTML document could not be previewed.',
} satisfies Record<HtmlPreviewKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** HTML preview status text. */
    sidebarHtml: HtmlPreviewKey
  }
}
