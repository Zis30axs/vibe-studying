import { FORMULA_CATALOG_VERSION, FORMULA_ENTRIES } from './formula-catalog'
import type { FormulaEntry, FormulaSubject } from '../shared/formula-reference'

export const FORMULA_SUBJECT_LABELS: Record<FormulaSubject, string> = {
  math: '数学',
  geography: '地理',
}
export const FORMULA_FAVORITES_STORAGE_KEY = 'examcraft.formula-favorites.v1'
export const MAX_FORMULA_RESULTS = 30

/** Shared by the offline reader and Agent tools. No browser, model or network access. */
export function normalizeFormulaSearch(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/−/g, '-').replace(/\s+/gu, ' ').trim()
}

function searchableText(entry: FormulaEntry): string {
  return normalizeFormulaSearch(
    [
      entry.id,
      entry.title,
      entry.subject,
      FORMULA_SUBJECT_LABELS[entry.subject],
      entry.subject === 'math' ? 'mathematics' : '',
      entry.chapter,
      ...entry.aliases,
      entry.expression,
      ...entry.symbols.flatMap((item) => [item.symbol, item.meaning, item.unit ?? '']),
    ].join(' '),
  )
}
const formulaIndex = FORMULA_ENTRIES.map((entry) => ({
  entry,
  text: searchableText(entry),
  title: normalizeFormulaSearch(entry.title),
  aliases: entry.aliases.map(normalizeFormulaSearch),
}))

export function searchFormulas(
  query: string,
  options: { subject?: FormulaSubject; chapter?: string; limit?: number } = {},
): FormulaEntry[] {
  const normalized = normalizeFormulaSearch(query.slice(0, 1000))
  const tokens = normalized.split(/[\s,，;；]+/u).filter(Boolean)
  const limit = Number.isFinite(options.limit)
    ? Math.max(0, Math.min(MAX_FORMULA_RESULTS, Math.floor(options.limit!)))
    : MAX_FORMULA_RESULTS
  const chapter = options.chapter ? normalizeFormulaSearch(options.chapter) : ''
  return formulaIndex
    .filter(
      ({ entry, text }) =>
        (!options.subject || entry.subject === options.subject) &&
        (!chapter || normalizeFormulaSearch(entry.chapter) === chapter) &&
        tokens.every((token) => text.includes(token)),
    )
    .map((item) => ({
      ...item,
      score: !normalized
        ? 0
        : item.title === normalized
          ? 100
          : item.aliases.includes(normalized)
            ? 90
            : item.title.includes(normalized)
              ? 60
              : item.aliases.some((alias) => alias.includes(normalized))
                ? 40
                : 0,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ entry }) => entry)
}

export function getFormula(id: string): FormulaEntry | undefined {
  return FORMULA_ENTRIES.find((entry) => entry.id === id)
}

export interface FormulaFavorites {
  version: 1
  catalogVersion: string
  ids: string[]
}
export interface FormulaFavoritesResult {
  favorites: FormulaFavorites
  status: 'empty' | 'ready' | 'migrated' | 'repaired' | 'invalid' | 'unsupported' | 'unavailable'
}
export type FormulaFavoritesStorage = Pick<Storage, 'getItem' | 'setItem'>
const emptyFavorites = (): FormulaFavorites => ({
  version: 1,
  catalogVersion: FORMULA_CATALOG_VERSION,
  ids: [],
})
const knownIds = new Set(FORMULA_ENTRIES.map((entry) => entry.id))
const validIds = (ids: unknown[]): string[] => [
  ...new Set(ids.filter((id): id is string => typeof id === 'string' && knownIds.has(id))),
]

/** Legacy arrays and v0 envelopes migrate; unknown future schemas are never overwritten. */
export function parseFormulaFavorites(serialized: string | null): FormulaFavoritesResult {
  if (serialized === null) return { favorites: emptyFavorites(), status: 'empty' }
  if (serialized.length > 100_000) return { favorites: emptyFavorites(), status: 'invalid' }
  try {
    const parsed: unknown = JSON.parse(serialized)
    if (Array.isArray(parsed)) {
      return {
        favorites: { ...emptyFavorites(), ids: validIds(parsed) },
        status: 'migrated',
      }
    }
    if (!parsed || typeof parsed !== 'object') throw new Error('Invalid favorites')
    const stored = parsed as Record<string, unknown>
    if (typeof stored.version === 'number' && stored.version > 1)
      return { favorites: emptyFavorites(), status: 'unsupported' }
    if ((stored.version !== 1 && stored.version !== 0) || !Array.isArray(stored.ids))
      throw new Error('Invalid favorites')
    const ids = validIds(stored.ids)
    return {
      favorites: { ...emptyFavorites(), ids },
      status:
        stored.version === 0 || stored.catalogVersion !== FORMULA_CATALOG_VERSION
          ? 'migrated'
          : ids.length !== stored.ids.length
            ? 'repaired'
            : 'ready',
    }
  } catch {
    return { favorites: emptyFavorites(), status: 'invalid' }
  }
}

export function readFormulaFavorites(storage: FormulaFavoritesStorage): FormulaFavoritesResult {
  try {
    return parseFormulaFavorites(storage.getItem(FORMULA_FAVORITES_STORAGE_KEY))
  } catch {
    return { favorites: emptyFavorites(), status: 'unavailable' }
  }
}

export function writeFormulaFavorites(
  storage: FormulaFavoritesStorage,
  ids: readonly string[],
): boolean {
  try {
    storage.setItem(
      FORMULA_FAVORITES_STORAGE_KEY,
      JSON.stringify({ ...emptyFavorites(), ids: validIds([...ids]) }),
    )
    return true
  } catch {
    return false
  }
}
