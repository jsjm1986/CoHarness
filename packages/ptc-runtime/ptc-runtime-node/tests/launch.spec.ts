import { expect, it } from 'vitest'
import { bootstrapArgs } from '../src/launch.ts'

const unmapped = { processPathFromHostPath: () => undefined }
const noMapping = { processPathFromHostPath: () => { throw new Error('must not map') } }

it('uses an explicit installed bootstrap without pretending it maps the host file', () => {
  expect(bootstrapArgs(noMapping, { bootstrapPath: '/remote/process.js' }, 2048)).toEqual(['/remote/process.js', '2048'])
})

it('fails when the execution world cannot read the source bootstrap', () => {
  expect(() => bootstrapArgs(unmapped, {}, 2048)).toThrow('unavailable in the subprocess execution world')
})

it('selects the private packaged bootstrap through the existing executable', () => {
  const prior = Object.getOwnPropertyDescriptor(process, 'pkg')
  try {
    Object.defineProperty(process, 'pkg', { configurable: true, value: {} })
    expect(bootstrapArgs(noMapping, {}, 2048)).toEqual(['2048'])
  } finally {
    if (prior === undefined) Reflect.deleteProperty(process, 'pkg')
    else Object.defineProperty(process, 'pkg', prior)
  }
})

it('requires a bootstrapPath for persistent processes and selects their bootstrap', () => {
  const prior = Object.getOwnPropertyDescriptor(process, 'pkg')
  try {
    Object.defineProperty(process, 'pkg', { configurable: true, value: {} })
    expect(() => bootstrapArgs(noMapping, {}, 2048, true)).toThrow('requires a bootstrapPath')
  } finally {
    if (prior === undefined) Reflect.deleteProperty(process, 'pkg')
    else Object.defineProperty(process, 'pkg', prior)
  }
  expect(bootstrapArgs(noMapping, { bootstrapPath: '/remote/persistent-process.js' }, 2048, true)).toEqual(['/remote/persistent-process.js', '2048'])
})
