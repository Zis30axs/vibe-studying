import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ExamCraftApi,
  GeneratedQuestionPreview,
  ModelConfig,
  StudentQuestion,
} from '../shared/types'
import { GeographyFigure } from './GeographyFigure'
import './geography-generator.css'

interface Props {
  api: ExamCraftApi
  config: ModelConfig | null
  onAccepted: (question: StudentQuestion) => void
  disabled?: boolean
}

/** The renderer receives only a student-safe preview. Accepting is a separate local write. */
export function GeographyGenerator({ api, config, onAccepted, disabled = false }: Props) {
  const [syllabus, setSyllabus] = useState('高中地理')
  const [chapter, setChapter] = useState('地球运动与经纬度')
  const [difficulty, setDifficulty] = useState<'基础' | '进阶' | '挑战'>('基础')
  const [consent, setConsent] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'generating' | 'accepting'>('idle')
  const [preview, setPreview] = useState<GeneratedQuestionPreview | null>(null)
  const [quota, setQuota] = useState<{ used: number; limit: number } | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const active = useRef<string | null>(null)
  const accepting = useRef(false)
  const previewRef = useRef<GeneratedQuestionPreview | null>(null)
  const mounted = useRef(true)
  const revision = useRef(config?.revision)
  revision.current = config?.revision
  const busy = phase !== 'idle'

  const refreshQuota = useCallback(async () => {
    try {
      const current = await api.getGenerationStatus()
      if (mounted.current) setQuota(current)
    } catch {
      if (mounted.current) {
        setQuota(null)
        setError('无法读取本次会话生成额度，请稍后重新检查。')
      }
    }
  }, [api])
  const invalidate = useCallback(() => {
    const requestId = active.current
    active.current = null
    if (requestId) void api.cancelQuestionGeneration(requestId).catch(() => {})
    const previous = previewRef.current
    previewRef.current = null
    if (previous) void api.rejectGeneratedQuestion(previous.token).catch(() => {})
    setPreview(null)
    setConsent(false)
    setPhase('idle')
  }, [api])

  useEffect(() => {
    mounted.current = true
    void refreshQuota()
    return () => {
      mounted.current = false
      const requestId = active.current
      active.current = null
      if (requestId) void api.cancelQuestionGeneration(requestId).catch(() => {})
      const previous = previewRef.current
      previewRef.current = null
      if (previous) void api.rejectGeneratedQuestion(previous.token).catch(() => {})
    }
  }, [api, refreshQuota])
  useEffect(() => {
    invalidate()
    setError('')
    setNotice('')
  }, [config?.revision, config?.configured, invalidate])

  function changeInput(update: () => void) {
    invalidate()
    update()
    setError('')
    setNotice('')
  }
  async function generate() {
    if (
      disabled ||
      busy ||
      active.current ||
      previewRef.current ||
      !consent ||
      !config?.configured ||
      !quota ||
      quota.used >= quota.limit ||
      !syllabus.trim() ||
      !chapter.trim()
    )
      return
    const requestId = crypto.randomUUID()
    const configRevision = config.revision
    active.current = requestId
    setConsent(false)
    setPhase('generating')
    setError('')
    setNotice('')
    try {
      const result = await api.generateGeographyQuestion({
        requestId,
        syllabus: syllabus.trim(),
        chapter: chapter.trim(),
        difficulty,
        cloudConsent: true,
        configRevision,
      })
      if (!mounted.current || active.current !== requestId || revision.current !== configRevision) {
        void api.rejectGeneratedQuestion(result.token).catch(() => {})
        return
      }
      previewRef.current = result
      setPreview(result)
    } catch (reason) {
      if (mounted.current && active.current === requestId)
        setError(
          reason instanceof Error ? reason.message : '生成失败。未自动重试，请重新确认后手动生成。',
        )
    } finally {
      if (mounted.current && active.current === requestId) {
        active.current = null
        setPhase('idle')
      }
      if (mounted.current) void refreshQuota()
    }
  }
  async function accept() {
    const candidate = previewRef.current
    if (!candidate || busy || disabled || accepting.current) return
    accepting.current = true
    setPhase('accepting')
    setError('')
    try {
      const question = await api.acceptGeneratedQuestion(candidate.token)
      // Acceptance is a committed local write. Keep the parent cache in sync even
      // when navigation unmounts this panel during persistence.
      if (mounted.current && previewRef.current?.token === candidate.token) {
        previewRef.current = null
        setPreview(null)
        setNotice('已加入本地题库，开始练习。')
      }
      onAccepted(question)
    } catch (reason) {
      if (mounted.current)
        setError(reason instanceof Error ? reason.message : '题目未能加入本地题库。')
    } finally {
      accepting.current = false
      if (mounted.current) setPhase('idle')
    }
  }
  async function reject() {
    const candidate = previewRef.current
    if (!candidate || busy || accepting.current) return
    try {
      await api.rejectGeneratedQuestion(candidate.token)
      if (previewRef.current?.token !== candidate.token) return
      previewRef.current = null
      setPreview(null)
      setConsent(false)
      setError('')
      setNotice('已舍弃，未加入题库。重新生成需要再次确认，并消耗一次额度。')
    } catch (reason) {
      if (mounted.current)
        setError(reason instanceof Error ? reason.message : '无法舍弃预览，请重试。')
    }
  }

  return (
    <details className="geo-generator" data-advisor-exclude>
      <summary>
        ＋ AI 生成地理题 <span>原创示意题 · 先预览再加入</span>
      </summary>
      <section aria-label="AI 地理出题" className="geo-generator-body">
        <p className="geo-generator-intro">
          按学习范围生成一道带示意图的练习题。只有点击“加入题库并开始练习”才会保存。
        </p>
        <div className="geo-generator-fields">
          <label>
            课程 / 考纲
            <input
              aria-label="生成题目课程 / 考纲"
              value={syllabus}
              maxLength={500}
              disabled={busy || disabled}
              onChange={(event) => changeInput(() => setSyllabus(event.target.value))}
            />
          </label>
          <label>
            章节
            <input
              aria-label="生成题目章节"
              value={chapter}
              maxLength={120}
              disabled={busy || disabled}
              onChange={(event) => changeInput(() => setChapter(event.target.value))}
            />
          </label>
          <label>
            难度
            <select
              aria-label="生成题目难度"
              value={difficulty}
              disabled={busy || disabled}
              onChange={(event) =>
                changeInput(() => setDifficulty(event.target.value as typeof difficulty))
              }
            >
              <option>基础</option>
              <option>进阶</option>
              <option>挑战</option>
            </select>
          </label>
        </div>
        <p className="geo-generator-quota">
          {quota
            ? `本次应用会话已请求 ${quota.used} / ${quota.limit} 次；取消或失败也可能计入。`
            : '正在读取生成额度。'}
        </p>
        {!config?.configured && <p role="status">请先在模型设置中配置模型，本地练习仍可使用。</p>}
        {!preview && (
          <>
            <div className="geo-generator-disclosure">
              <p>
                本次发送：课程 / 考纲“{syllabus || '未填写'}”、章节“{chapter || '未填写'}”、难度“
                {difficulty}”，以及出题格式要求。
              </p>
              <p>
                接收方：{config?.baseUrl || '尚未配置'} · {config?.protocol || '未设置协议'} ·{' '}
                {config?.model || '未设置模型'}。调用可能产生 API 费用，按服务商计费。
              </p>
              <label className="geo-generator-consent">
                <input
                  type="checkbox"
                  checked={consent}
                  disabled={busy || disabled || !config?.configured}
                  onChange={(event) => setConsent(event.target.checked)}
                />
                我同意本次向上述模型发送这些输入并承担可能产生的 API 费用
              </label>
            </div>
            <div className="geo-generator-actions">
              <button
                type="button"
                className="primary"
                disabled={
                  disabled ||
                  busy ||
                  !config?.configured ||
                  !consent ||
                  !syllabus.trim() ||
                  !chapter.trim() ||
                  !quota ||
                  quota.used >= quota.limit
                }
                onClick={() => void generate()}
              >
                {phase === 'generating' ? '正在生成…' : '确认并生成一道题'}
              </button>
              {phase === 'generating' && (
                <button
                  type="button"
                  onClick={() => {
                    invalidate()
                    setNotice('已取消，迟到结果不会加入题库。已发出的请求可能仍会计费。')
                    void refreshQuota()
                  }}
                >
                  取消生成
                </button>
              )}
              {!quota && !busy && (
                <button type="button" onClick={() => void refreshQuota()}>
                  重新检查额度
                </button>
              )}
            </div>
          </>
        )}
        {preview && (
          <article className="geo-generator-preview" aria-label="生成题目预览">
            <div className="geo-generator-preview-heading">
              <h3>{preview.question.title}</h3>
              <span>{preview.question.maxScore} 分</span>
            </div>
            <p className="geo-generator-prompt">{preview.question.prompt}</p>
            {preview.question.figure && <GeographyFigure figure={preview.question.figure} />}
            <p className="geo-generator-provenance">
              {preview.question.source} · {preview.question.provenance?.model} ·{' '}
              {preview.question.provenance?.generatedAt}
            </p>
            <p className="geo-generator-caveat">
              仅通过结构检查，题意、地理事实和参考解析尚未核验。请先判断题目是否适合练习；审阅结果也需要自行核对。
            </p>
            <div className="geo-generator-actions">
              <button
                type="button"
                className="primary"
                disabled={busy || disabled}
                onClick={() => void accept()}
              >
                {phase === 'accepting' ? '正在加入…' : '加入题库并开始练习'}
              </button>
              <button type="button" disabled={busy} onClick={() => void reject()}>
                舍弃 / 重新生成
              </button>
            </div>
          </article>
        )}
        {error && (
          <p role="alert" className="geo-generator-error">
            {error} 不会自动重试。
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
      </section>
    </details>
  )
}
