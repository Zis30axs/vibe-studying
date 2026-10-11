import { describe, expect, it } from 'vitest'
import { FORMULA_CATALOG_VERSION, FORMULA_ENTRIES } from '../src/domain/formula-catalog'
import {
  FORMULA_FAVORITES_STORAGE_KEY,
  getFormula,
  normalizeFormulaSearch,
  parseFormulaFavorites,
  readFormulaFavorites,
  searchFormulas,
  writeFormulaFavorites,
} from '../src/domain/formula-reference'

const vectorId = 'math.vector.dot'
const slopeId = 'math.line.slope'
const scaleId = 'geo.scale.distance'

describe('shared offline formula lookup', () => {
  it('finds Chinese titles and aliases, English aliases, fullwidth text and symbols', () => {
    expect(getFormula(vectorId)?.title).toBe('空间向量数量积')
    expect(searchFormulas('数量积').map((entry) => entry.id)).toContain(vectorId)
    expect(searchFormulas('点积').map((entry) => entry.id)).toContain(vectorId)
    const entry = getFormula(vectorId)!
    const asciiAlias = entry.aliases.find((alias) => /[a-z]/i.test(alias))!
    expect(asciiAlias).toBeTruthy()
    const fullwidth = asciiAlias
      .toUpperCase()
      .replace(/[!-~]/g, (character) => String.fromCharCode(character.charCodeAt(0) + 0xfee0))
    expect(searchFormulas(`  ${fullwidth}  `).map((formula) => formula.id)).toContain(vectorId)
    expect(searchFormulas(entry.symbols[0].symbol).map((formula) => formula.id)).toContain(vectorId)
    expect(normalizeFormulaSearch('  ＭＡＴＨ　Ａ − Ｂ ')).toBe('math a - b')
  })

  it('matches all tokens across subject, chapter, title, aliases, symbols and units', () => {
    expect(searchFormulas('数学 直线 斜率').map((entry) => entry.id)).toContain(slopeId)
    expect(searchFormulas('geography 比例尺').map((entry) => entry.id)).toContain(scaleId)
    const scale = getFormula(scaleId)!
    expect(
      searchFormulas(`${scale.title} ${scale.symbols[0].meaning}`).map((entry) => entry.id),
    ).toContain(scaleId)
    expect(searchFormulas('数学 地理')).toEqual([])
    expect(searchFormulas('公式库不存在的关键词')).toEqual([])
  })

  it('filters exact subject and chapter without changing canonical entries', () => {
    const subjectResults = searchFormulas('', { subject: 'geography' })
    expect(subjectResults.length).toBeGreaterThan(0)
    expect(subjectResults.every((entry) => entry.subject === 'geography')).toBe(true)
    const chapter = getFormula(scaleId)!.chapter
    const chapterResults = searchFormulas('', { subject: 'geography', chapter })
    expect(chapterResults.map((entry) => entry.id)).toContain(scaleId)
    expect(chapterResults.every((entry) => entry.chapter === chapter)).toBe(true)
    expect(searchFormulas('', { subject: 'math', chapter })).toEqual([])
    expect(getFormula('missing')).toBeUndefined()
    expect(searchFormulas(getFormula(slopeId)!.title)[0]).toBe(getFormula(slopeId))
  })

  it('is deterministic, defaults to the catalog order and caps results at 30', () => {
    expect(searchFormulas('')).toEqual(FORMULA_ENTRIES.slice(0, 30))
    expect(searchFormulas('', { limit: 999 })).toHaveLength(Math.min(30, FORMULA_ENTRIES.length))
    expect(searchFormulas('', { limit: 1 })).toHaveLength(1)
    expect(searchFormulas('', { limit: 2.9 })).toHaveLength(2)
    expect(searchFormulas('', { limit: 0 })).toEqual([])
    expect(searchFormulas('', { limit: -2 })).toEqual([])
    expect(searchFormulas('', { limit: Number.NaN })).toEqual(searchFormulas(''))
    expect(searchFormulas('数学')).toEqual(searchFormulas('数学'))
  })
})

describe('versioned formula favorites', () => {
  const encode = (ids: unknown[], catalogVersion = FORMULA_CATALOG_VERSION) =>
    JSON.stringify({ version: 1, catalogVersion, ids })

  it('loads valid IDs, preserves order and prunes duplicate, unknown and non-string values', () => {
    const parsed = parseFormulaFavorites(encode([vectorId, vectorId, 'unknown', 4, scaleId, null]))
    expect(parsed.status).toBe('repaired')
    expect(parsed.favorites).toEqual({
      version: 1,
      catalogVersion: FORMULA_CATALOG_VERSION,
      ids: [vectorId, scaleId],
    })
    expect(parseFormulaFavorites(encode([vectorId])).status).toBe('ready')
  })

  it('migrates legacy arrays and v0 envelopes, and reconciles catalog updates', () => {
    for (const value of [
      JSON.stringify([vectorId, 'removed-formula']),
      JSON.stringify({ version: 0, ids: [vectorId, 'removed-formula'] }),
      encode([vectorId, 'removed-formula'], 'old-catalog'),
    ]) {
      const result = parseFormulaFavorites(value)
      expect(result.status).toBe('migrated')
      expect(result.favorites.ids).toEqual([vectorId])
      expect(result.favorites.catalogVersion).toBe(FORMULA_CATALOG_VERSION)
    }
  })

  it('falls back safely for malformed data without interpreting future schemas', () => {
    expect(parseFormulaFavorites(null).status).toBe('empty')
    for (const malformed of [
      '{',
      'null',
      'true',
      '42',
      '{}',
      '{"version":1,"ids":{}}',
      'x'.repeat(100001),
    ]) {
      const result = parseFormulaFavorites(malformed)
      expect(result.status).toBe('invalid')
      expect(result.favorites.ids).toEqual([])
    }
    expect(parseFormulaFavorites('{"version":2,"ids":["math.vector.dot"]}').status).toBe(
      'unsupported',
    )
  })

  it('contains read/write storage failures and saves only bounded known IDs', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value)
      },
    }
    expect(writeFormulaFavorites(storage, [scaleId, 'unknown', scaleId])).toBe(true)
    expect(JSON.parse(values.get(FORMULA_FAVORITES_STORAGE_KEY)!)).toEqual({
      version: 1,
      catalogVersion: FORMULA_CATALOG_VERSION,
      ids: [scaleId],
    })
    expect(readFormulaFavorites(storage).favorites.ids).toEqual([scaleId])
    const blocked = {
      getItem: () => {
        throw new Error('Access denied')
      },
      setItem: () => {
        throw new Error('Quota exceeded')
      },
    }
    expect(readFormulaFavorites(blocked).status).toBe('unavailable')
    expect(writeFormulaFavorites(blocked, [vectorId])).toBe(false)
  })
})
