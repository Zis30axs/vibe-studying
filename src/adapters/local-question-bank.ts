import { join } from 'node:path'
import type { Question } from '../shared/types'
import { idSchema, questionBankSchema, scopeSchema, type QuestionScope } from '../domain/schemas'
import { sampleQuestions } from '../domain/sample-bank'
import { AtomicJsonStore } from './atomic-json-store'
import type { QuestionBankAdapter } from './contracts'

export function matchesScope(question: Question, scope: QuestionScope = {}): boolean {
  return (
    (!scope.subject || question.subject === scope.subject) &&
    (!scope.tags || scope.tags.every((tag) => question.tags.includes(tag))) &&
    (!scope.questionIds || scope.questionIds.includes(question.id))
  )
}

export class LocalQuestionBank implements QuestionBankAdapter {
  readonly name = '本地 JSON 题库 · 原创示例'
  readonly store: AtomicJsonStore<{ version: 1; questions: Question[] }> | undefined
  constructor(
    userDataDirectory?: string,
    private readonly bundled: Question[] = sampleQuestions,
  ) {
    if (userDataDirectory)
      this.store = new AtomicJsonStore(
        join(userDataDirectory, 'question-bank.json'),
        questionBankSchema,
        () => ({ version: 1, questions: [] }),
      )
  }

  private mergeQuestions(imported: Question[]): Question[] {
    // Existing imports own their IDs: new demo releases must not break saved history.
    const bundled = questionBankSchema.parse({ version: 1, questions: this.bundled }).questions
    const importedIds = new Set(imported.map((question) => question.id))
    const available = bundled.filter((question) => !importedIds.has(question.id))
    return questionBankSchema.parse({
      version: 1,
      questions: [...available.slice(0, Math.max(0, 1000 - imported.length)), ...imported],
    }).questions
  }

  async list(input: QuestionScope = {}): Promise<Question[]> {
    const scope = scopeSchema.parse(input)
    const imported = this.store ? (await this.store.load()).questions : []
    const questions = this.mergeQuestions(imported)
    return questions.filter((question) => matchesScope(question, scope))
  }

  async get(questionId: string, scope: QuestionScope = {}): Promise<Question> {
    const id = idSchema.parse(questionId)
    const question = (await this.list(scope)).find((item) => item.id === id)
    if (!question) throw new Error('题目不存在或不在允许范围内')
    return question
  }

  async importBank(input: unknown): Promise<number> {
    if (!this.store) throw new Error('该题库为只读模式')
    const incoming = questionBankSchema.parse(input)
    if (!incoming.questions.length) throw new Error('导入题库不能为空')
    await this.store.update((current) => {
      const existing = new Set(
        [...this.bundled, ...current.questions].map((question) => question.id),
      )
      const duplicate = incoming.questions.find((question) => existing.has(question.id))
      if (duplicate)
        throw new Error(`题目 ID 已存在：${duplicate.id}。导入已取消，未覆盖任何题目。`)
      questionBankSchema.parse({
        version: 1,
        questions: [...this.mergeQuestions(current.questions), ...incoming.questions],
      })
      return questionBankSchema.parse({
        version: 1,
        questions: [...current.questions, ...incoming.questions],
      })
    })
    return incoming.questions.length
  }
}
