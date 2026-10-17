export type MathChallengeKind = 'single' | 'multiple' | 'fill' | 'solution'

export interface MathChallengeQuestion {
  id: string
  kind: MathChallengeKind
  title: string
  prompt: string
  points: number
  tags: string[]
  choices?: { id: string; text: string }[]
}

/** Host-only reference data. Never import the paper catalog into renderer code. */
export interface MathChallengeReferenceQuestion extends MathChallengeQuestion {
  answer: string
  explanation: string
  correctChoiceIds?: string[]
  rubric: { label: string; points: number }[]
}

export interface MathChallengePaper {
  id: string
  title: string
  description: string
  scope: string
  source: string
  durationMinutes: number
  solutionCount: 5 | 6
  questions: MathChallengeQuestion[]
}

export interface MathChallengePaperDefinition extends Omit<MathChallengePaper, 'questions'> {
  questions: MathChallengeReferenceQuestion[]
}

export interface MathChallengeSection {
  kind: MathChallengeKind
  label: string
  count: number
  points: number
  instructions: string
}

export interface MathChallengeCatalogEntry extends Omit<MathChallengePaper, 'questions'> {
  totalQuestions: number
  totalPoints: number
  sections: MathChallengeSection[]
}

export interface MathChallengeAnswer {
  choiceIds: string[]
  text: string
  flagged: boolean
}

export interface MathChallengeReviewItem {
  questionId: string
  answer: string
  explanation: string
  rubric: { label: string; points: number }[]
  earned: number | null
  points: number
  grading: 'automatic' | 'self' | 'pending'
}

export interface MathChallengeReview {
  objectiveScore: number
  objectiveMaxScore: number
  manualScore: number
  manualMaxScore: number
  pendingManualCount: number
  /** Null until all nonempty fill/solution answers have been self-assessed. */
  totalScore: number | null
  items: MathChallengeReviewItem[]
}

export interface MathChallengeSession {
  id: string
  paper: MathChallengePaper
  startedAt: number
  deadlineAt: number
  submittedAt: number | null
  submitReason: 'manual' | 'timeout' | null
  revision: number
  answers: Record<string, MathChallengeAnswer>
  activeQuestionId: string
  scratchpad: string
  /** Present only after submission. */
  review?: MathChallengeReview
}

export interface MathChallengeSummary {
  id: string
  paperTitle: string
  startedAt: number
  submittedAt: number
  submitReason: 'manual' | 'timeout'
  objectiveScore: number
  totalScore: number | null
  pendingManualCount: number
}

export interface MathChallengeOverview {
  papers: MathChallengeCatalogEntry[]
  active: MathChallengeSession | null
  history: MathChallengeSummary[]
}

export interface MathChallengeSaveInput {
  sessionId: string
  expectedRevision: number
  answers: Record<string, MathChallengeAnswer>
  activeQuestionId: string
  scratchpad: string
}

export interface MathChallengeApi {
  getMathChallenges(): Promise<MathChallengeOverview>
  startMathChallenge(input: { paperId: string }): Promise<MathChallengeSession>
  getMathChallenge(sessionId: string): Promise<MathChallengeSession>
  saveMathChallenge(input: MathChallengeSaveInput): Promise<MathChallengeSession>
  submitMathChallenge(input: {
    sessionId: string
    expectedRevision: number
  }): Promise<MathChallengeSession>
  gradeMathChallenge(input: {
    sessionId: string
    expectedRevision: number
    questionId: string
    score: number
  }): Promise<MathChallengeSession>
}
