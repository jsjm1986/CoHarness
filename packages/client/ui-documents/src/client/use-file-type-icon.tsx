/** Load the document manager's type artwork independently of its controls. */
import { useEffect, useState } from 'react'
import { IconBrowseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FileTypeIcon } from './FileTypeIcon.tsx'

const GenericFileIcon: typeof FileTypeIcon = ({ className }) => (
  <IconBrowseOutline16 className={className} aria-hidden="true" size={18} />
)

/**
 * Start loading type artwork when a document surface opens.
 * @param enabled - whether the list or preview is open.
 * @returns a generic glyph until the shared artwork is available.
 */
export function useFileTypeIcon(enabled: boolean): typeof FileTypeIcon {
  const [loadedIcon, setLoadedIcon] = useState<typeof FileTypeIcon>()
  useEffect(() => {
    if (!enabled || loadedIcon !== undefined) return
    let current = true
    void import('./FileTypeIcon.tsx').then(({ FileTypeIcon }) => {
      if (current) setLoadedIcon(() => FileTypeIcon)
    }, () => {
      // A failed artwork fetch leaves the generic glyph available on every row.
    })
    return () => { current = false }
  }, [enabled, loadedIcon])
  return loadedIcon ?? GenericFileIcon
}
