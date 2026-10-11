/**
 * Main-process defensive reflection check, not a general secret/DLP detector.
 * Decode common reversible representations with bounded work. Excessive nesting
 * fails closed. Arbitrary encryption, fragmentation, or custom encodings cannot
 * be recognized universally and must not be claimed as covered.
 */
export function containsCredentialText(raw: string, key: string): boolean {
  if (!key) return false
  if (raw.length > 1024 * 1024 || key.length > 16384) return true
  const variants = [
    key,
    Buffer.from(key).toString('base64'),
    Buffer.from(key).toString('base64url'),
    Buffer.from(key).toString('hex'),
    Buffer.from(key).toString('hex').toUpperCase(),
  ]
  const hexadecimal = Buffer.from(key).toString('hex')
  let decoded = raw
  for (let depth = 0; depth < 6; depth++) {
    if (
      variants.some((value) => decoded.includes(value)) ||
      decoded.toLowerCase().includes(hexadecimal)
    )
      return true
    const next = decoded
      .replace(
        /&#(x[0-9a-f]+|\d+);?|&(amp|lt|gt|quot|apos|nbsp|percnt|colon|sol|bsol|equals|period|num);/gi,
        (whole, number: string | undefined, name: string | undefined) => {
          if (number) {
            const code = number.toLowerCase().startsWith('x')
              ? parseInt(number.slice(1), 16)
              : Number(number)
            return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
          }
          return (
            (
              {
                amp: '&',
                lt: '<',
                gt: '>',
                quot: '"',
                apos: "'",
                nbsp: ' ',
                percnt: '%',
                colon: ':',
                sol: '/',
                bsol: '\\',
                equals: '=',
                period: '.',
                num: '#',
              } as Record<string, string>
            )[name!.toLowerCase()] ?? whole
          )
        },
      )
      .replace(
        /\\u\{([0-9a-f]{1,6})\}|\\u([0-9a-f]{4})|\\x([0-9a-f]{2})|%u([0-9a-f]{4})/gi,
        (
          whole,
          a: string | undefined,
          b: string | undefined,
          c: string | undefined,
          d: string | undefined,
        ) => {
          const code = parseInt((a ?? b ?? c ?? d)!, 16)
          return code <= 0x10ffff ? String.fromCodePoint(code) : whole
        },
      )
      .replace(/(?:%[0-9a-f]{2})+/gi, (part) => {
        try {
          return decodeURIComponent(part)
        } catch {
          // One invalid UTF-8 byte must not hide the remaining ASCII credential bytes.
          return part.replace(/%([0-7][0-9a-f])/gi, (_, byte: string) =>
            String.fromCharCode(parseInt(byte, 16)),
          )
        }
      })
    if (next === decoded) return false
    decoded = next
  }
  return true
}
