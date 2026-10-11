import { useEffect, useId, useMemo, useState } from 'react'
import {
  assistanceLabels,
  helpKindLabels,
  type AssistanceStatus,
  type LearningGraphApi,
  type LearningGraphState,
} from '../shared/learning-graph'
import { learningAssistance, learningHelpState, learningScopeKey } from '../domain/learning-graph'
import type { Attempt, Subject } from '../shared/types'
import { subjectLabel, subjects } from '../shared/subjects'
import './learning-graph.css'

export function AssistanceBadge({ status = 'unknown' }: { status?: AssistanceStatus }) {
  return (
    <span className={`assistance-badge assistance-${status}`} data-assistance={status}>
      {assistanceLabels[status]}
    </span>
  )
}
const states = {
  pending: '请求中',
  received: '已收到提示 · 未合并',
  failed: '请求失败',
  canceled: '已取消',
  rejected: '未采纳建议',
  merged: '已采纳并合并',
}
const reasons = {
  baseline: '作答起点',
  independent: '独立新分支',
  edit: '编辑快照',
  restore: '恢复为新分支',
  merge: 'AI 修改合并',
}
const toolLabels: Record<string, string> = {
  list_questions: '查看题目列表',
  get_question: '读取所选题目',
  get_draft: '读取本次草稿',
  get_attempts: '读取授权提交',
  search_knowledge: '搜索教材',
  read_knowledge: '阅读教材',
  math_plot: '计算函数图像',
  search_formulas: '公式检索',
  get_formula: '公式读取',
  math_measure: '数学测量',
  geography_measure: '地理测量',
  terrain_calculate: '地形计算',
  review_answer: '委派作答审阅',
  advise_selection: '委派选区提示',
  review_modules: '委派模块建议',
  generate_question: '委派生成题目',
  propose_answer_edit: '提出作答修改',
  propose_question: '提出新题预览',
  delegate: '模型委派',
  other: '已授权工具',
}
export function LearningGraph({
  api,
  graph: supplied,
  attempts = [],
  onSelectAttempt,
  onRestore,
}: {
  api?: Pick<LearningGraphApi, 'getLearningGraph'>
  graph?: LearningGraphState
  attempts?: readonly Attempt[]
  onSelectAttempt?: (id: string) => void
  onRestore?: (snapshotId: string, expectedHeadId: string) => Promise<void>
}) {
  const headingId = useId()
  const [loaded, setLoaded] = useState<LearningGraphState>()
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<Subject | 'all'>('all')
  const [refresh, setRefresh] = useState(0)
  const [restoring, setRestoring] = useState(false)
  useEffect(() => {
    if (supplied || !api?.getLearningGraph) return
    let live = true
    void api.getLearningGraph().then(
      (result) => {
        if (live) {
          setLoaded(result)
          setError('')
        }
      },
      () => {
        if (live) setError('学习图未能读取；已保存提交仍可正常回看。')
      },
    )
    return () => {
      live = false
    }
  }, [api, supplied, refresh])
  const graph = supplied ?? loaded
  const savedIds = useMemo(() => new Set(attempts.map((attempt) => attempt.id)), [attempts])
  const snapshots =
    graph?.snapshots.filter((snapshot) => filter === 'all' || snapshot.subject === filter) ?? []
  return (
    <section className="learning-graph" aria-labelledby={headingId} data-testid="learning-graph">
      <header>
        <div>
          <span className="learning-graph-kicker">ANSWER BRANCHES</span>
          <h2 id={headingId}>作答与 AI 求助分支</h2>
        </div>
        {api && (
          <button type="button" onClick={() => setRefresh((value) => value + 1)}>
            刷新
          </button>
        )}
      </header>
      <p>每次求助从当时的真实作答分出支线。收到提示就记录参考；只有实际采纳修改才出现合并。</p>
      <div className="learning-graph-legend" aria-label="作答来源图例">
        {(['independent', 'referenced-ai', 'adopted-ai', 'unknown'] as const).map((status) => (
          <AssistanceBadge key={status} status={status} />
        ))}
      </div>
      <p className="learning-graph-footnote">
        这些标记帮助回顾学习过程，不扣分，也不改变评阅结果。旧记录没有来源证据时显示“来源未记录”。
      </p>
      <label className="learning-graph-filter">
        学科{' '}
        <select
          value={filter}
          onChange={(event) => setFilter(event.target.value as Subject | 'all')}
        >
          <option value="all">全部学科</option>
          {subjects.map((subject) => (
            <option value={subject} key={subject}>
              {subjectLabel[subject]}
            </option>
          ))}
        </select>
      </label>
      {error && <p role="alert">{error}</p>}
      {!graph && !error && (
        <p role="status">
          {api?.getLearningGraph
            ? '正在读取本机学习图…'
            : '此预览尚未提供学习图，已保存提交仍可回看。'}
        </p>
      )}
      {graph && !snapshots.length && (
        <p>还没有这一学科的作答分支。已有旧提交保留原样，不推测为独立作答。</p>
      )}
      <ol className="learning-graph-mainline" aria-label="作答快照与求助分支，按创建顺序">
        {graph &&
          snapshots.map((snapshot, index) => {
            const assistance = learningAssistance(graph, snapshot.id)
            const branches = graph.branches.filter((branch) => branch.snapshotId === snapshot.id)
            const submissions = graph.events.filter(
              (event) =>
                event.type === 'submission' &&
                event.snapshotId === snapshot.id &&
                savedIds.has(event.attemptId),
            )
            const currentId = graph.heads[learningScopeKey(snapshot)]
            return (
              <li
                key={snapshot.id}
                className={`learning-snapshot assistance-${assistance.status}`}
                data-snapshot-id={snapshot.id}
              >
                <div className="learning-snapshot-top">
                  <strong>
                    {subjectLabel[snapshot.subject]} · {reasons[snapshot.reason]} #{index + 1}
                  </strong>
                  <AssistanceBadge status={assistance.status} />
                </div>
                <div className="learning-snapshot-meta">
                  <span>{snapshot.questionId}</span>
                  <time dateTime={new Date(snapshot.createdAt).toISOString()}>
                    {new Date(snapshot.createdAt).toLocaleString('zh-CN')}
                  </time>
                  {currentId === snapshot.id && <b>当前版本</b>}
                </div>
                <details>
                  <summary>查看作答快照与连接</summary>
                  <p className="learning-plain-text">
                    {snapshot.draft.text ||
                      (snapshot.draft.choiceId
                        ? `选项 ${snapshot.draft.choiceId}`
                        : snapshot.draft.argument?.roots.map((root) => root.text).join('\n') ||
                          '图形 / 空白作答')}
                  </p>
                  <small>
                    快照 {snapshot.id}
                    {snapshot.parentId ? ` · 父快照 ${snapshot.parentId}` : ' · 独立起点'}
                    {snapshot.argumentRevisionId
                      ? ` · 模块版本 ${snapshot.argumentRevisionId}`
                      : ''}
                  </small>
                </details>
                {submissions.map(
                  (event) =>
                    event.type === 'submission' && (
                      <button
                        className="learning-submission-link"
                        type="button"
                        key={event.id}
                        onClick={() => onSelectAttempt?.(event.attemptId)}
                      >
                        查看真实提交 <AssistanceBadge status={event.assistance.status} />
                      </button>
                    ),
                )}
                {branches.length > 0 && (
                  <ol className="learning-help-branches" aria-label="从该作答发起的 AI 求助">
                    {branches.map((branch) => {
                      const state = learningHelpState(graph, branch.id)
                      const events = graph.events.filter(
                        (event) => 'branchId' in event && event.branchId === branch.id,
                      )
                      const received = events.find((event) => event.type === 'help-received')
                      const detail = received && 'detail' in received ? received.detail : undefined
                      const trace = events.filter((event) => event.type === 'tool')
                      return (
                        <li className={`learning-help help-${state}`} key={branch.id}>
                          <div>
                            <strong>⑂ {helpKindLabels[branch.kind]}</strong>
                            <span>{states[state]}</span>
                          </div>
                          {detail && (
                            <details>
                              <summary>查看求助与提示{detail.truncated ? '（节选）' : ''}</summary>
                              {detail.prompt && (
                                <p className="learning-plain-text">求助：{detail.prompt}</p>
                              )}
                              <p className="learning-plain-text">{detail.response}</p>
                            </details>
                          )}
                          {trace.length > 0 && (
                            <details>
                              <summary>工具轨迹 · {trace.length} 步（最多保留 40 步）</summary>
                              <ol>
                                {trace.map(
                                  (event) =>
                                    event.type === 'tool' && (
                                      <li key={event.id}>
                                        {toolLabels[event.trace.tool] ?? event.trace.tool} ·{' '}
                                        {
                                          { completed: '完成', failed: '失败', canceled: '取消' }[
                                            event.trace.outcome
                                          ]
                                        }
                                      </li>
                                    ),
                                )}
                              </ol>
                            </details>
                          )}
                          {state === 'merged' && <small>↳ 修改已写入新的作答快照</small>}
                        </li>
                      )
                    })}
                  </ol>
                )}
                {onRestore && currentId !== snapshot.id && (
                  <button
                    type="button"
                    disabled={restoring}
                    onClick={async () => {
                      setRestoring(true)
                      try {
                        await onRestore(snapshot.id, currentId)
                        setRefresh((value) => value + 1)
                      } catch {
                        setError('当前作答已变化或恢复未完成，请刷新后重试。')
                      } finally {
                        setRestoring(false)
                      }
                    }}
                  >
                    恢复此快照为新分支
                  </button>
                )}
              </li>
            )
          })}
      </ol>
    </section>
  )
}
