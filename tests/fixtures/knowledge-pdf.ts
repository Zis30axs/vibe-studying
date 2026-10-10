/** Original, generated test data. No textbook pages or third-party text. */
export const knowledgeFixturePages = [
  'ExamCraft synthetic practice PDF.\n本页是自编测试目录，不是教材。\n目录与印刷页码不用于自动建立章节。',
  '第二页：公民参与。\n公民通过有序参与表达意见。依法监督需要具体事实和清晰程序。\n这些句子仅用于检索测试，不代表官方教材表述。',
  '第三页：公共讨论。\n面对公共问题，先区分事实与观点，再核对理由和结论。\n这是一份自编示例，没有正式教材章节对应关系。',
]

/** Small real PDF with a Unicode CMap and physical pages, suitable for PDF.js. */
export function createKnowledgePdf(
  pages: string[] = knowledgeFixturePages,
  options: { lineHeight?: number } = {},
): Uint8Array {
  if (!pages.length) throw new Error('A fixture needs at least one page')
  const objects: string[] = []
  const add = (value: string) => {
    objects.push(value)
    return objects.length
  }
  const catalog = add('')
  const pageTree = add('')
  // Standard CJK font selection. No network or downloaded font is involved.
  const font = add(
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [4 0 R] >>',
  )
  add(
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /FontDescriptor 5 0 R /DW 1000 >>',
  )
  add(
    '<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 752 /Descent -271 /CapHeight 737 /StemV 58 >>',
  )
  const pageIds: number[] = []
  for (const text of pages) {
    const commands = text
      .split('\n')
      .map((line, index) => {
        const hex = [...line]
          .map((character) => character.charCodeAt(0).toString(16).padStart(4, '0'))
          .join('')
        return `${index ? `0 -${options.lineHeight ?? 26} Td\n` : ''}<${hex}> Tj`
      })
      .join('\n')
    const stream = `BT\n/F1 13 Tf\n50 760 Td\n${commands}\nET\n`
    const content = add(
      `<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}endstream`,
    )
    const page = add(
      `<< /Type /Page /Parent ${pageTree} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`,
    )
    pageIds.push(page)
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pageTree} 0 R >>`
  objects[pageTree - 1] =
    `<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`
  let output = '%PDF-1.7\n'
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(output, 'ascii'))
    output += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = Buffer.byteLength(output, 'ascii')
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  output += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')
  output += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new Uint8Array(Buffer.from(output, 'ascii'))
}
