import { z } from 'zod'
import { webResearchSourceSchema, type WebResearchSource } from './web-research'

/** None of these labels assert that a generated question is an authentic past exam. */
export const questionResearchOriginSchema = z.enum(['original', 'adapted', 'unverified-source'])
export type QuestionResearchOrigin = z.infer<typeof questionResearchOriginSchema>
/** Persist bounded attribution only, not fetched page text or model-authored metadata. */
export const questionResearchSourceSchema = z.strictObject({
  sourceId: webResearchSourceSchema.shape.sourceId,
  title: webResearchSourceSchema.shape.title,
  url: webResearchSourceSchema.shape.url,
  yearEvidence: webResearchSourceSchema.shape.yearEvidence,
  untrusted: z.literal(true),
  verification: z.literal('unverified'),
  retrieved: z.literal(true),
  retrievedAt: z.iso.datetime(),
  provenance: z.enum(['tavily-search', 'direct-fetch']),
})
export type QuestionResearchSource = z.infer<typeof questionResearchSourceSchema>
export const questionResearchSourcesSchema = z
  .array(questionResearchSourceSchema)
  .min(1)
  .max(15)
  .refine(
    (sources) => new Set(sources.map((source) => source.sourceId)).size === sources.length,
    '来源标识不可重复',
  )

export function researchSourceAttribution(source: WebResearchSource): QuestionResearchSource {
  const parsed = webResearchSourceSchema.parse(source)
  const { excerpt: _excerpt, ...attribution } = parsed
  return questionResearchSourceSchema.parse(attribution)
}

/** The source-year mentions are evidence of text encountered, never proof of an exam's date. */
export function validQuestionResearch(value: {
  researchOrigin?: QuestionResearchOrigin
  researchSources?: QuestionResearchSource[]
}): boolean {
  if (value.researchOrigin === undefined) return value.researchSources === undefined
  if (value.researchOrigin === 'original') return value.researchSources === undefined
  return !!value.researchSources?.length
}
