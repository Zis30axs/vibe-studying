import type { StudentQuestion } from '../shared/types'
import { subjectLabel } from '../shared/subjects'
export function StudyNavigator({
  questions,
  selected,
  reviewing,
  disabled,
  onSelect,
}: {
  questions: StudentQuestion[]
  selected?: StudentQuestion
  reviewing: boolean
  disabled: boolean
  onSelect(id: string): void
}) {
  const index = questions.findIndex((item) => item.id === selected?.id)
  return (
    <div className="study-navigator" aria-label="当前练习导航">
      <div className="study-current">
        <span className="study-subject">{selected ? subjectLabel[selected.subject] : '练习'}</span>
        <span>{selected?.title ?? '请选择或导入题目'}</span>
      </div>
      <div className="study-stages" aria-label="练习阶段">
        <span>01 选题</span>
        <i aria-hidden="true" />
        <span aria-current={!reviewing && selected ? 'step' : undefined}>02 作答</span>
        <i aria-hidden="true" />
        <span aria-current={reviewing ? 'step' : undefined}>03 审阅</span>
      </div>
      <div className="study-paging">
        <button
          aria-label="上一题"
          title="当前筛选范围内的上一题"
          disabled={disabled || index <= 0}
          onClick={() => onSelect(questions[index - 1].id)}
        >
          ←
        </button>
        <span aria-label="题目位置">
          {index < 0 ? '0' : index + 1} / {questions.length}
        </span>
        <button
          aria-label="下一题"
          title="当前筛选范围内的下一题"
          disabled={disabled || index < 0 || index >= questions.length - 1}
          onClick={() => onSelect(questions[index + 1].id)}
        >
          →
        </button>
      </div>
    </div>
  )
}
export function WorkspaceLoading() {
  return (
    <section className="workspace-loading" role="status" aria-label="正在打开本地学习空间">
      <p>正在打开本地学习空间…</p>
      <div aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
    </section>
  )
}
