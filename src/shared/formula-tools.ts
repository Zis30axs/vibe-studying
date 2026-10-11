import { z } from 'zod'
import type { FormulaEntry } from './formula-reference'

/** Public, bundled teaching references. No imported textbook or student data. */
export const FORMULA_TOOL_LIMITS = Object.freeze({ queryCharacters: 120, results: 3 })
export const formulaSearchInputSchema = z.strictObject({
  query: z.string().trim().min(1).max(FORMULA_TOOL_LIMITS.queryCharacters),
  chapter: z.string().trim().min(1).max(80).optional(),
  limit: z.number().int().min(1).max(FORMULA_TOOL_LIMITS.results).optional(),
})
export const formulaGetInputSchema = z.strictObject({
  formulaId: z
    .string()
    .min(1)
    .max(100)
    .regex(/^(math|geo)\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/),
})
export const FORMULA_PROVENANCE = 'bundled-formula-reference' as const
export interface FormulaReferenceReceipt {
  readonly formulaId: string
  readonly catalogVersion: string
  readonly entryVersion: number
  readonly title: string
  readonly expression: string
  readonly conditions: FormulaEntry['conditions']
  readonly sources: FormulaEntry['sources']
  readonly provenance: typeof FORMULA_PROVENANCE
}
