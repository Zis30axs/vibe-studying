import { describe, expect, it } from 'vitest'
import { containsCredentialText } from '../src/adapters/credential-reflection'

const key = 'tvly-synthetic-Key_987-never-real'
const percent = [...key].map((letter) => '%' + letter.charCodeAt(0).toString(16)).join('')
describe('bounded credential reflection checks', () => {
  it.each([
    key,
    Buffer.from(key).toString('base64'),
    Buffer.from(key).toString('base64url'),
    Buffer.from(key).toString('hex'),
    Buffer.from(key).toString('hex').toUpperCase(),
    [...Buffer.from(key).toString('hex')]
      .map((letter, index) => (index % 3 ? letter.toUpperCase() : letter))
      .join(''),
    '%ff' + percent,
    [...key].map((letter) => `&#${letter.charCodeAt(0)}`).join(''),
    percent,
    percent.replaceAll('%', '%25'),
    percent.replaceAll('%', '&percnt;'),
    [...key].map((letter) => `&#${letter.charCodeAt(0)};`).join(''),
    [...key].map((letter) => `&#x${letter.charCodeAt(0).toString(16)};`).join(''),
    [...key].map((letter) => `\\u${letter.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''),
    [...key].map((letter) => `\\x${letter.charCodeAt(0).toString(16)}`).join(''),
    [...key].map((letter) => `%u${letter.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''),
  ])('detects common reversible variant #%#', (encoded) => {
    expect(containsCredentialText(`Before ${encoded} After`, key)).toBe(true)
  })
  it('leaves ordinary public text and URL percent escapes alone', () => {
    expect(containsCredentialText('Some public 2024 evidence %20 &amp; 文字', key)).toBe(false)
    expect(containsCredentialText('text', '')).toBe(false)
  })
  it('fails closed on extreme nesting or oversized text rather than doing unbounded work', () => {
    let nested = percent
    for (let index = 0; index < 10; index++) nested = nested.replaceAll('%', '%25')
    expect(containsCredentialText(nested, key)).toBe(true)
    expect(containsCredentialText('x'.repeat(1024 * 1024 + 1), key)).toBe(true)
  })
})
