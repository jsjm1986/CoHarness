import { useEffect } from 'react'

/** Props for the browser title projection. */
export interface DocumentTitleProps {
  /** Durable title of the selected session, or undefined for the product title. */
  title?: string | undefined
  /**
   * Product title resolved by the assembly (build-configured
   * `DSH_CLIENT_TITLE` or the localized brand name); absent only when neither
   * exists, in which case the served document keeps its build-rendered title.
   */
  productTitle?: string | undefined
}

/**
 * Project the selected durable session title into the browser title and
 * restore the product title when unmounted.
 * @param props - Selected session title projection.
 * @returns No rendered content.
 */
export function DocumentTitle({ title, productTitle }: DocumentTitleProps): null {
  useEffect(() => {
    if (productTitle === undefined) {
      if (title !== undefined) document.title = title
      return
    }
    document.title = title === undefined ? productTitle : `${title} — ${productTitle}`
    return () => { document.title = productTitle }
  }, [productTitle, title])
  return null
}
