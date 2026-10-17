import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { AtomicJsonStore } from './atomic-json-store'
import { mathChallengePapers } from '../domain/math-challenge-papers'
import {
  isMathChallengeAnswerValid,
  mathChallengeCatalog,
  mathChallengeGradeSchema,
  mathChallengePaperSchema,
  mathChallengeSaveSchema,
  mathChallengeSessionIdSchema,
  mathChallengeSessionProjection,
  mathChallengeStartSchema,
  mathChallengeStoreSchema,
  mathChallengeSubmitSchema,
  type MathChallengeRecord,
  type MathChallengeStore,
} from '../domain/math-challenge'
import type { MathChallengeOverview, MathChallengeSession } from '../shared/math-challenge'

/** Independent from the single-question study ledger. One atomic queue owns every sitting. */
export class MathChallengeService {
  private readonly store: AtomicJsonStore<MathChallengeStore>
  private readonly papers: MathChallengeRecord['paper'][]
  constructor(
    directory: string,
    papers = mathChallengePapers,
    private readonly now = () => Date.now(),
  ) {
    this.papers = papers.map((p) => mathChallengePaperSchema.parse(p))
    if (new Set(this.papers.map((p) => p.id)).size !== this.papers.length)
      throw new Error('试卷 ID 重复')
    this.store = new AtomicJsonStore(
      join(directory, 'math-challenges.json'),
      mathChallengeStoreSchema,
      () => ({ version: 1, sessions: [] }),
    )
  }

  private expire(state: MathChallengeStore): void {
    const now = this.now()
    for (const s of state.sessions) {
      if (s.submittedAt === null && now >= s.deadlineAt) {
        s.submittedAt = s.deadlineAt
        s.submitReason = 'timeout'
        s.revision++
      }
    }
  }

  private find(state: MathChallengeStore, id: string): MathChallengeRecord {
    const session = state.sessions.find((s) => s.id === id)
    if (!session) throw new Error('未找到这次综合卷挑战')
    return session
  }

  private assertRevision(session: MathChallengeRecord, revision: number): void {
    if (session.revision !== revision)
      throw new Error('这份试卷已在其他操作中更新，请重新载入后继续')
  }

  private async current(): Promise<MathChallengeStore> {
    const state = await this.store.load()
    if (state.sessions.some((s) => s.submittedAt === null && this.now() >= s.deadlineAt))
      return this.store.update((s) => {
        this.expire(s)
        return s
      })
    return state
  }

  async getMathChallenges(): Promise<MathChallengeOverview> {
    const state = await this.current()
    return {
      papers: this.papers.map(mathChallengeCatalog),
      active: state.sessions.find((s) => s.submittedAt === null)
        ? mathChallengeSessionProjection(state.sessions.find((s) => s.submittedAt === null)!)
        : null,
      history: state.sessions
        .filter((s) => s.submittedAt !== null)
        .map((s) => {
          const projected = mathChallengeSessionProjection(s)
          return {
            id: s.id,
            paperTitle: s.paper.title,
            startedAt: s.startedAt,
            submittedAt: s.submittedAt!,
            submitReason: s.submitReason!,
            objectiveScore: projected.review!.objectiveScore,
            totalScore: projected.review!.totalScore,
            pendingManualCount: projected.review!.pendingManualCount,
          }
        })
        .reverse(),
    }
  }

  async startMathChallenge(input: unknown): Promise<MathChallengeSession> {
    const { paperId } = mathChallengeStartSchema.parse(input)
    const paper = this.papers.find((p) => p.id === paperId)
    if (!paper) throw new Error('试卷不存在')
    let createdId = ''
    const state = await this.store.update((s) => {
      this.expire(s)
      if (s.sessions.some((x) => x.submittedAt === null))
        throw new Error('已有进行中的试卷，请先继续并交卷')
      if (s.sessions.length >= 200)
        throw new Error('挑战记录已达到 200 份上限，请先备份挑战记录文件')
      const startedAt = this.now()
      createdId = randomUUID()
      s.sessions.push({
        id: createdId,
        paper: structuredClone(paper),
        startedAt,
        deadlineAt: startedAt + paper.durationMinutes * 60_000,
        submittedAt: null,
        submitReason: null,
        revision: 0,
        answers: {},
        activeQuestionId: paper.questions[0].id,
        scratchpad: '',
        manualScores: {},
      })
      return s
    })
    return mathChallengeSessionProjection(this.find(state, createdId))
  }

  async getMathChallenge(input: unknown): Promise<MathChallengeSession> {
    const id = mathChallengeSessionIdSchema.parse(input)
    return mathChallengeSessionProjection(this.find(await this.current(), id))
  }

  async saveMathChallenge(input: unknown): Promise<MathChallengeSession> {
    const request = mathChallengeSaveSchema.parse(structuredClone(input))
    const state = await this.store.update((s) => {
      this.expire(s)
      const session = this.find(s, request.sessionId)
      // Expiry closes the saved sitting before any late input is applied.
      if (session.submittedAt !== null) return s
      this.assertRevision(session, request.expectedRevision)
      const questions = new Map(session.paper.questions.map((q) => [q.id, q]))
      if (!questions.has(request.activeQuestionId)) throw new Error('当前题目不在本次试卷中')
      for (const [id, answer] of Object.entries(request.answers)) {
        const q = questions.get(id)
        if (!q || !isMathChallengeAnswerValid(q, answer))
          throw new Error('作答与本次试卷题目不一致')
      }
      session.answers = request.answers
      session.activeQuestionId = request.activeQuestionId
      session.scratchpad = request.scratchpad
      session.revision++
      return s
    })
    return mathChallengeSessionProjection(this.find(state, request.sessionId))
  }

  async submitMathChallenge(input: unknown): Promise<MathChallengeSession> {
    const request = mathChallengeSubmitSchema.parse(input)
    const state = await this.store.update((s) => {
      this.expire(s)
      const session = this.find(s, request.sessionId)
      if (session.submittedAt !== null) return s
      this.assertRevision(session, request.expectedRevision)
      session.submittedAt = Math.max(session.startedAt, Math.min(this.now(), session.deadlineAt))
      session.submitReason = 'manual'
      session.revision++
      return s
    })
    return mathChallengeSessionProjection(this.find(state, request.sessionId))
  }

  async gradeMathChallenge(input: unknown): Promise<MathChallengeSession> {
    const request = mathChallengeGradeSchema.parse(input)
    const state = await this.store.update((s) => {
      this.expire(s)
      const session = this.find(s, request.sessionId)
      if (session.submittedAt === null) throw new Error('交卷后才能对照解析自评')
      this.assertRevision(session, request.expectedRevision)
      const q = session.paper.questions.find((q) => q.id === request.questionId)
      if (!q || (q.kind !== 'fill' && q.kind !== 'solution'))
        throw new Error('只能给本次填空、解答题自评')
      if (request.score > q.points) throw new Error('自评分数不能超过题目满分')
      session.manualScores[q.id] = request.score
      session.revision++
      return s
    })
    return mathChallengeSessionProjection(this.find(state, request.sessionId))
  }
}
