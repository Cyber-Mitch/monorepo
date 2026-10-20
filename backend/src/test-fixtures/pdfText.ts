import { inflateSync } from 'node:zlib'

/**
 * Extracts the text drawn by a PDF produced with pdfkit's standard fonts, for
 * tests. Inflates every content stream and reads the `TJ` / `Tj` string
 * operands, which pdfkit writes as hex strings. Not a general PDF parser.
 */
export function extractPdfText(pdf: Buffer): string {
  const source = pdf.toString('latin1')
  const out: string[] = []

  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g
  for (const match of source.matchAll(streamRe)) {
    const raw = Buffer.from(match[1], 'latin1')
    let content: string
    try {
      content = inflateSync(raw).toString('latin1')
    } catch {
      content = match[1]
    }
    const lineParts: string[] = []
    for (const op of content.matchAll(/\[((?:<[0-9a-fA-F]*>|\([^)]*\)|-?[\d.]+|\s)*)\]\s*TJ|<([0-9a-fA-F]*)>\s*Tj|\(([^)]*)\)\s*Tj/g)) {
      const hexRuns = op[1] !== undefined ? [...op[1].matchAll(/<([0-9a-fA-F]*)>/g)].map((m) => m[1]) : op[2] !== undefined ? [op[2]] : []
      if (hexRuns.length > 0) {
        lineParts.push(hexRuns.map((h) => Buffer.from(h, 'hex').toString('latin1')).join(''))
      } else if (op[3] !== undefined) {
        lineParts.push(op[3])
      }
    }
    if (lineParts.length > 0) out.push(lineParts.join('\n'))
  }
  return out.join('\n')
}
