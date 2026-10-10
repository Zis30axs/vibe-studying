import type { AnswerDraft, Question } from '../shared/types'
import { validateAnswer } from '../domain/schemas'
import type { AgentAdapter, Review } from './contracts'

export class LocalRuleAgent implements AgentAdapter {
  readonly name = '本地规则评阅 · 非 AI'

  async review(question: Question, input: AnswerDraft): Promise<Review> {
    const draft = validateAnswer(question, input, true)
    if (question.kind === 'choice') {
      const correct = draft.choiceId === question.correctAnswer
      return {
        score: correct ? question.maxScore : 0,
        maxScore: question.maxScore,
        feedback: correct
          ? '回答正确。可以结合解析巩固判断依据。'
          : `本次答案不正确，参考答案为 ${question.correctAnswer}。请结合解析重新判断。`,
        explanation: question.explanation,
        rubric: [],
        reviewer: this.name,
      }
    }
    const text = [draft.text, ...draft.blocks.map((block) => block.text)]
      .join('\n')
      .normalize('NFKC')
      .toLowerCase()
    const rubric = (question.rubric ?? []).map((item) => {
      const found = item.keywords.find((keyword) =>
        text.includes(keyword.normalize('NFKC').toLowerCase()),
      )
      return {
        id: item.id,
        label: item.label,
        earned: found ? item.points : 0,
        possible: item.points,
        feedback: found
          ? `匹配到“${found}”；请自行核对论证是否正确。`
          : `未匹配到提示词：${item.keywords.join(' / ')}。同义表达可能漏判。`,
      }
    })
    return {
      score: rubric.reduce((total, item) => total + item.earned, 0),
      maxScore: question.maxScore,
      feedback:
        '这是关键词覆盖度提示，不代表考试得分。规则不理解语义、否定或论证逻辑，也不评价模块顺序。' +
        (question.kind === 'geography' ? '绘图已随作答保存，但未参与自动评分。' : ''),
      explanation: question.explanation,
      rubric,
      reviewer: this.name,
    }
  }
}
