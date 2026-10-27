// @vitest-environment jsdom
import { render, cleanup } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { documentIconId, FileTypeIcon } from '../src/client/FileTypeIcon.tsx'
import { fileIconExtensions, fileIconImages, fileIconNames } from '../src/client/file-icons.data.ts'

afterEach(cleanup)
it.each([
  ['报告.PDF', 'application/octet-stream', 'pdf'],
  ['合同.docx', 'application/octet-stream', 'word'],
  ['报表.xlsx', 'application/octet-stream', 'table'],
  ['演示.pptx', 'application/octet-stream', 'powerpoint'],
  ['照片.heic', 'image/heic', 'image'],
  ['录音.mp3', 'audio/mpeg', 'audio'],
  ['视频.mp4', 'video/mp4', 'video'],
  ['资料.tar.gz', 'application/octet-stream', 'zip'],
  ['unknown', 'application/pdf; charset=binary', 'pdf'],
  ['unknown', 'text/plain', 'document'],
  ['unknown', 'application/octet-stream', 'file'],
])('uses a recognizable type asset for %s', (name, mime, expected) => {
  expect(documentIconId(name, mime)).toBe(expected)
})
it('prioritizes exact filenames and complete compound extensions', () => {
  expect(documentIconId('README.md', 'text/markdown')).toBe(fileIconNames['readme.md'])
  expect(documentIconId('types.d.ts', 'text/plain')).toBe(fileIconExtensions['d.ts'])
})
it('packages an SVG for every upstream filename and extension association', () => {
  for (const id of [...Object.values(fileIconNames), ...Object.values(fileIconExtensions)]) {
    expect(fileIconImages[id]).toMatch(/^data:image\/svg\+xml;base64,/)
  }
})
it('keeps icon bytes local and decorative beside the accessible filename', () => {
  const { container } = render(<FileTypeIcon name="合同.docx" mediaType="application/octet-stream" />)
  const image = container.querySelector('img')!
  expect(image.getAttribute('src')).toMatch(/^data:image\/svg\+xml;base64,/)
  expect(image.getAttribute('alt')).toBe('')
  expect(image.getAttribute('aria-hidden')).toBe('true')
})

it('preserves case-sensitive upstream filenames and accepts normalized aliases', () => {
  for (const [name, id] of Object.entries(fileIconNames)) {
    if (name.includes('/') || name.includes('\\')) continue
    expect(documentIconId(name, 'application/octet-stream')).toBe(id)
  }
  expect(documentIconId('CLAUDE.md', 'text/markdown')).toBe('claude')
  expect(documentIconId('Caddyfile', 'application/octet-stream')).toBe('caddy')
  expect(documentIconId('example.tmLanguage', 'application/octet-stream')).toBe('xml')
  expect(documentIconId('constructor', 'application/octet-stream')).toBe('file')
})
