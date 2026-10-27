import { defaultFileIcon, fileIconExtensions, fileIconImages, fileIconNames } from './file-icons.data.ts'

const mimeIcons: Readonly<Record<string, string>> = {
  'application/pdf': 'pdf',
  'application/msword': 'word',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'word',
  'application/vnd.ms-excel': 'table',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'table',
  'application/vnd.ms-powerpoint': 'powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'powerpoint',
  'application/zip': 'zip',
  'application/x-7z-compressed': 'zip',
  'application/gzip': 'zip',
  'application/json': 'json',
  'application/xml': 'xml',
  'application/x-yaml': 'yaml',
  'text/csv': 'table',
  'text/markdown': 'markdown',
}

/**
 * Resolve visual file identity from complete upstream associations, with MIME fallback.
 * @param name - safe display filename; complete names precede compound extensions.
 * @param mediaType - content type used when no filename association is known.
 * @returns an upstream icon identifier; no file content is read.
 */
export function documentIconId(name: string, mediaType: string): string {
  const original = name.split(/[\\/]/).at(-1) ?? name
  const filename = original.toLowerCase()
  const exact = Object.hasOwn(fileIconNames, original) ? fileIconNames[original] : undefined
  if (exact !== undefined) return exact
  const named = Object.hasOwn(fileIconNames, filename) ? fileIconNames[filename] : undefined
  if (named !== undefined) return named
  let dot = filename.indexOf('.')
  while (dot >= 0) {
    const extension = filename.slice(dot + 1)
    const icon = Object.hasOwn(fileIconExtensions, extension) ? fileIconExtensions[extension] : undefined
    if (icon !== undefined) return icon
    dot = filename.indexOf('.', dot + 1)
  }
  const mime = mediaType.split(';')[0]?.trim().toLowerCase() ?? ''
  const specific = mimeIcons[mime]
  if (specific !== undefined) return specific
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('text/')) return 'document'
  if (mime.startsWith('font/')) return 'font'
  return defaultFileIcon
}

/**
 * Render a decorative file-type asset from the local Material Icon Theme bundle.
 * @param props.name - displayed filename.
 * @param props.mediaType - MIME fallback for extensionless and unknown files.
 * @param props.className - dimensions owned by the surrounding file row.
 * @returns the matching local SVG image; the adjacent filename provides accessible text.
 */
export function FileTypeIcon({ name, mediaType, className }: { name: string; mediaType: string; className?: string | undefined }) {
  const icon = documentIconId(name, mediaType)
  return <img className={className} data-document-icon={icon} src={fileIconImages[icon] ?? fileIconImages[defaultFileIcon]} alt="" aria-hidden="true" width={18} height={18} />
}
