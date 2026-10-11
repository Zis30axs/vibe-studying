/** Locally curated study references; expressions are display text, never executable input. */
export type FormulaSubject = 'math' | 'geography'

export interface FormulaSymbol {
  readonly symbol: string
  readonly meaning: string
  readonly unit?: string
}

export interface FormulaExample {
  readonly question: string
  readonly steps: readonly string[]
  readonly answer: string
}

export interface FormulaSource {
  readonly title: string
  readonly url: string
}

export interface FormulaEntry {
  readonly id: string
  readonly version: 1
  readonly subject: FormulaSubject
  readonly chapter: string
  readonly title: string
  readonly aliases: readonly string[]
  readonly expression: string
  readonly symbols: readonly FormulaSymbol[]
  readonly conditions: readonly string[]
  readonly pitfalls: readonly string[]
  readonly example: FormulaExample
  readonly sources: readonly FormulaSource[]
}
