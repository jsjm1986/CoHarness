// @vitest-environment jsdom
/** The bundled CommonJS interop unwrap keeps RFB constructable. */
import { expect, it } from 'vitest'
import { RFB } from '../src/client/rfb.ts'

it('exposes the RFB class as a constructor', () => {
  expect(typeof RFB).toBe('function')
  expect(() => Reflect.construct(String, [], RFB as new () => object)).not.toThrow()
})
