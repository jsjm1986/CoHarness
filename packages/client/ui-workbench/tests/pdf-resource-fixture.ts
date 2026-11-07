/** Self-authored PDF fixtures exercise real CMap, standard-font, JPEG2000, and JBIG2 reads. */
import { pdfObjects } from './pdf-fixture.ts'

/** Resource paths covered by the installed PDF.js parser and renderer. */
export type PdfResourceFixture = 'vector' | 'standard' | 'cjk' | 'jpx' | 'jbig2'

// Pillow/OpenJPEG 2.5.4 lossless encoding of an 8×8 solid RGB(220,20,40) image.
const JPX = '0000000c6a5020200d0a870a00000014667479706a703220000000006a7032200000002d6a703268000000166968647200000008000000080003070700000000000f636f6c7201000000000010000000a76a703263ff4fff51002f000000000008000000080000000000000000000000080000000800000000000000000003070101070101070101ff52000c00000001000304040001ff5c000d4040484850484850484850ff640025000143726561746564206279204f70656e4a5045472076657273696f6e20322e352e34ff90000a0000000000260001ff93cfb4080333cfb408081fcfb40805c9808080808080808080ffd9'
// Self-authored 16×16 white bitmap with a black center; Pillow CCITT Group 4 data in JBIG2 MMR segments.
const JBIG2 = '000000013000010000001300000010000000100000000000000000000000000000022700010000001f00000010000000100000000000000000000126a0bff2e7fffffff8ff0010010000000331000100000000'

/** @param kind - required PDF resource path. @returns complete ASCII-only PDF bytes, without external content. */
export function pdfResourceFixture(kind: PdfResourceFixture): Uint8Array {
  const content = kind === 'vector' ? '0.9 0.1 0.1 rg 10 10 80 80 re f'
    : kind === 'standard' ? 'BT /F1 24 Tf 10 40 Td (ABC) Tj ET'
      : kind === 'cjk' ? 'BT /F1 20 Tf 10 40 Td <65E5672C8A9E> Tj ET'
        : 'q 80 0 0 80 10 10 cm /Im1 Do Q'
  const resources = kind === 'vector' ? '<< >>'
    : kind === 'jpx' || kind === 'jbig2' ? '<< /XObject << /Im1 5 0 R >> >>' : '<< /Font << /F1 5 0 R >> >>'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources ${resources} /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ]
  if (kind === 'standard') objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Symbol >>')
  if (kind === 'cjk') objects.push(
    '<< /Type /Font /Subtype /Type0 /BaseFont /HeiseiKakuGo-W5 /Encoding /UniJIS-UCS2-H /DescendantFonts [6 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HeiseiKakuGo-W5 /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 5 >> /FontDescriptor 7 0 R >>',
    '<< /Type /FontDescriptor /FontName /HeiseiKakuGo-W5 /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>',
  )
  if (kind === 'jpx' || kind === 'jbig2') {
    const data = kind === 'jpx' ? JPX : JBIG2, size = kind === 'jpx' ? 8 : 16
    const filter = kind === 'jpx' ? 'JPXDecode' : 'JBIG2Decode'
    const colors = kind === 'jpx' ? '/ColorSpace /DeviceRGB /BitsPerComponent 8' : '/ColorSpace /DeviceGray /BitsPerComponent 1 /Decode [1 0]'
    objects.push(`<< /Type /XObject /Subtype /Image /Width ${size} /Height ${size} ${colors} /Filter [/ASCIIHexDecode /${filter}] /Length ${data.length + 1} >>\nstream\n${data}>\nendstream`)
  }
  return pdfObjects(objects)
}
