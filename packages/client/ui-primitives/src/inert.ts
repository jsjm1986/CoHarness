/**
 * Hold one element inert for the lifetime of an overlay. Native `inert` is
 * preferred; the fallback also hides the subtree from assistive technology
 * and removes its existing tab stops for older WebViews.
 * @param element - the page subtree hidden by the overlay.
 * @returns a disposer that restores the element's prior accessibility state.
 */
export function holdInert(element: HTMLElement): () => void {
  const nativeInert = typeof (Reflect.get(element, 'inert') as unknown) === 'boolean'
  const previousInert = (Reflect.get(element, 'inert') as unknown) === true
  const previousAriaHidden = nativeInert ? null : element.getAttribute('aria-hidden')
  const focusables = nativeInert ? [] : [...element.querySelectorAll<HTMLElement>(
    'a[href], area[href], button, input, select, textarea, audio[controls], video[controls], iframe, object, embed, details, [contenteditable="true"], [tabindex]',
  )].map(node => ({ node, tabIndex: node.tabIndex }))

  // Assigning the property is harmless on browsers that do not implement the
  // IDL member (it becomes an expando), while the fallback below supplies the
  // actual keyboard/AT behavior there.
  element.inert = true
  if (!nativeInert) {
    element.setAttribute('aria-hidden', 'true')
    for (const { node } of focusables) node.tabIndex = -1
  }

  return () => {
    element.inert = previousInert
    if (!nativeInert) {
      if (previousAriaHidden === null) element.removeAttribute('aria-hidden')
      else element.setAttribute('aria-hidden', previousAriaHidden)
      for (const { node, tabIndex } of focusables) node.tabIndex = tabIndex
    }
  }
}
