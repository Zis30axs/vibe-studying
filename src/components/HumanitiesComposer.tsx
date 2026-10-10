import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import type { AnswerDraft, ArgumentKind, ArgumentNode, Subject } from '../shared/types'
import {
  argumentFromDraft,
  generateArgumentText,
  insertArgumentNode,
  isArgumentContainer,
  MAX_ARGUMENT_DEPTH,
  MAX_ARGUMENT_NODES,
  MAX_ARGUMENT_TEXT_LENGTH,
  moveArgumentNode,
  removeArgumentNode,
} from '../domain/argument'

interface HumanitiesComposerProps {
  subject: Subject
  draft: AnswerDraft
  onChange: (draft: AnswerDraft) => void
  disabled?: boolean
}

type BlockInfo = { label: string; prompt: string }
type SubjectInfo = { name: string; hint: string; blocks: Record<ArgumentKind, BlockInfo> }
type Placement = { type: 'new'; kind: ArgumentKind } | { type: 'move'; id: string }
type Location = { node: ArgumentNode; parentId: string | null; index: number }
type Template = 'argument' | 'cause' | 'contrast' | 'points'

const DRAG_TYPE = 'application/x-examcraft-argument'
const LEAVES: ArgumentKind[] = ['principle', 'material', 'analysis', 'conclusion']
const CONTAINERS: ArgumentKind[] = ['cause', 'contrast', 'point']
const commonContainers: Record<'cause' | 'contrast' | 'point', BlockInfo> = {
  cause: { label: '因果链', prompt: '可填写这条因果链的主题；按原因、过程、结果放入子模块' },
  contrast: { label: '对比结构', prompt: '可填写比较维度；用两个分论点分别组织比较对象' },
  point: { label: '分论点', prompt: '可填写本段观点；在内部连接依据、分析和结论' },
}
const subjectInfo: Partial<Record<Subject, SubjectInfo>> = {
  politics: {
    name: '政治',
    hint: '原理要准确，材料要具体，分析要说清二者的联系。',
    blocks: {
      principle: { label: '知识原理', prompt: '写出与设问相关的概念、原理或政策依据' },
      material: { label: '材料事实', prompt: '从题目中提取事实，保留必要的主体与条件' },
      analysis: { label: '结合分析', prompt: '解释这条事实如何体现原理、产生什么影响' },
      conclusion: { label: '结论建议', prompt: '回应设问，写出有依据的结论或具体措施' },
      ...commonContainers,
    },
  },
  chinese: {
    name: '语文',
    hint: '从具体词句出发，解释表达效果，再回应题目的问题。',
    blocks: {
      principle: { label: '阅读观点', prompt: '写出你的理解、判断或所用的表达手法' },
      material: { label: '文本证据', prompt: '引用或概括相关词句，不脱离原文语境' },
      analysis: { label: '表达分析', prompt: '解释词句、形象或手法怎样产生表达效果' },
      conclusion: { label: '主旨回应', prompt: '把分析收束到人物、情感、主旨或设问' },
      ...commonContainers,
    },
  },
  history: {
    name: '历史',
    hint: '区分史料与推论，联系时序和背景，避免单一原因解释。',
    blocks: {
      principle: { label: '历史观点', prompt: '明确判断，或交代事件所处的时代背景' },
      material: { label: '史料证据', prompt: '记录史料事实、时间或出处，不虚构证据' },
      analysis: { label: '历史解释', prompt: '结合背景解释原因、变化或影响，区分事实与推论' },
      conclusion: { label: '综合认识', prompt: '归纳有证据支撑的结论，并说明必要的限度' },
      ...commonContainers,
    },
  },
  geography: {
    name: '地理',
    hint: '联系空间位置、地理条件和过程，说明影响与适用条件。',
    blocks: {
      principle: { label: '地理规律', prompt: '写出适用的地理规律、条件或区域特征' },
      material: { label: '图文信息', prompt: '提取位置、分布、数据或图中的具体信息' },
      analysis: { label: '过程分析', prompt: '连接条件、地理过程与影响，交代因果环节' },
      conclusion: { label: '区域结论', prompt: '回应设问，提出符合当地条件的判断或措施' },
      ...commonContainers,
    },
  },
}

function locate(
  nodes: ArgumentNode[],
  id: string,
  parentId: string | null = null,
): Location | null {
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]
    if (node.id === id) return { node, parentId, index }
    const child = locate(node.children, id, node.id)
    if (child) return child
  }
  return null
}

function countNodes(nodes: ArgumentNode[]): number {
  return nodes.reduce((total, node) => total + 1 + countNodes(node.children), 0)
}

function updateText(nodes: ArgumentNode[], id: string, text: string): ArgumentNode[] {
  return nodes.map((node) =>
    node.id === id ? { ...node, text } : { ...node, children: updateText(node.children, id, text) },
  )
}

function makeNode(kind: ArgumentKind, children: ArgumentNode[] = []): ArgumentNode {
  return { id: crypto.randomUUID(), kind, text: '', children }
}

function makeTemplate(template: Template): ArgumentNode[] {
  const point = () =>
    makeNode(
      'point',
      LEAVES.map((kind) => makeNode(kind)),
    )
  if (template === 'cause') {
    return [
      makeNode(
        'cause',
        ['material', 'analysis', 'conclusion'].map((kind) => makeNode(kind as ArgumentKind)),
      ),
    ]
  }
  if (template === 'contrast') {
    return [
      makeNode(
        'contrast',
        [0, 1].map(() => makeNode('point', [makeNode('material'), makeNode('analysis')])),
      ),
    ]
  }
  return template === 'points' ? [point(), point()] : [point()]
}

export function HumanitiesComposer({
  subject,
  draft,
  onChange,
  disabled = false,
}: HumanitiesComposerProps) {
  const id = useId()
  const info = subjectInfo[subject] ?? subjectInfo.politics!
  const [selection, setSelection] = useState<Placement | null>(null)
  const [template, setTemplate] = useState<Template>('argument')
  const [error, setError] = useState('')
  const [announcement, setAnnouncement] = useState('')
  const [hoveredSocket, setHoveredSocket] = useState<string | null>(null)
  const [removed, setRemoved] = useState<Location | null>(null)
  const [syncConfirmation, setSyncConfirmation] = useState<{
    generated: string
    previous: string
  } | null>(null)
  const activeDrag = useRef<Placement | null>(null)
  const hadStructuredDraft = useRef(Boolean(draft.argument || draft.blocks.length))
  const conversion = useMemo(() => {
    try {
      const roots = argumentFromDraft(draft).roots
      return { roots, generated: generateArgumentText(roots), error: '' }
    } catch (cause) {
      return {
        roots: [] as ArgumentNode[],
        generated: '',
        error: cause instanceof Error ? cause.message : '旧草稿暂时无法转换为模块。',
      }
    }
  }, [draft])
  const { roots, generated } = conversion
  const total = countNodes(roots)
  const atLimit = total >= MAX_ARGUMENT_NODES
  const selectedLabel =
    selection?.type === 'new'
      ? info.blocks[selection.kind].label
      : selection?.type === 'move'
        ? info.blocks[locate(roots, selection.id)?.node.kind ?? 'analysis'].label
        : ''

  useEffect(() => {
    if (
      syncConfirmation &&
      (syncConfirmation.generated !== generated || syncConfirmation.previous !== draft.text)
    ) {
      setSyncConfirmation(null)
    }
  }, [generated, draft.text, syncConfirmation])

  useEffect(() => {
    // A redo creates a new empty draft under the same question key. Do not let an
    // old selection or deletion undo put material from the previous attempt back.
    if (hadStructuredDraft.current && !draft.argument && !draft.blocks.length && !draft.text) {
      setSelection(null)
      setRemoved(null)
      setError('')
      setAnnouncement('')
      setHoveredSocket(null)
      setSyncConfirmation(null)
      activeDrag.current = null
    }
    hadStructuredDraft.current = Boolean(draft.argument || draft.blocks.length)
  }, [draft.argument, draft.blocks, draft.text])

  function commit(nextRoots: ArgumentNode[], message?: string) {
    if (disabled) return
    // Validate generated length before saving; this also keeps large edits from failing silently later.
    generateArgumentText(nextRoots)
    onChange({ ...draft, argument: { version: 1, roots: nextRoots } })
    setError('')
    setSyncConfirmation(null)
    if (message) setAnnouncement(message)
  }

  function attempt(action: () => void) {
    if (disabled) return
    try {
      action()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法完成操作，请检查模块结构。')
    }
  }

  function select(placement: Placement) {
    if (disabled) return
    setSelection(placement)
    setError('')
    setAnnouncement('已选中模块，请点击目标卡槽；按 Escape 取消。')
  }

  function place(parentId: string | null, index: number, placement = selection) {
    if (!placement || disabled) return
    attempt(() => {
      const next =
        placement.type === 'new'
          ? insertArgumentNode(roots, makeNode(placement.kind), parentId, index)
          : moveArgumentNode(roots, placement.id, parentId, index)
      commit(next, parentId ? '模块已吸附到容器内。' : '模块已吸附到答案主序列。')
      setSelection(null)
      setHoveredSocket(null)
    })
  }

  function startDrag(event: DragEvent, placement: Placement) {
    event.stopPropagation()
    if (
      disabled ||
      (event.target instanceof Element && event.target.closest('textarea, input, select'))
    ) {
      event.preventDefault()
      return
    }
    activeDrag.current = placement
    event.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ owner: id, placement }))
    event.dataTransfer.effectAllowed = placement.type === 'new' ? 'copy' : 'move'
    select(placement)
  }

  function endDrag() {
    activeDrag.current = null
    setHoveredSocket(null)
  }

  function drop(event: DragEvent, parentId: string | null, index: number) {
    event.preventDefault()
    event.stopPropagation()
    if (disabled) return
    try {
      const payload: { owner?: string; placement?: Placement } = JSON.parse(
        event.dataTransfer.getData(DRAG_TYPE),
      )
      if (payload.owner !== id || !activeDrag.current) return
      place(parentId, index, activeDrag.current)
    } catch {
      setError('请从此组装台拖入模块。')
    }
    endDrag()
  }

  function socket(parentId: string | null, index: number, testId: string, label: string) {
    return (
      <button
        type="button"
        key={testId}
        className={`humanities-socket${selection ? ' is-ready' : ''}${hoveredSocket === testId ? ' is-over' : ''}`}
        data-testid={testId}
        data-parent-id={parentId ?? 'root'}
        data-slot-index={index}
        aria-label={label}
        disabled={disabled || (!selection && !activeDrag.current)}
        onClick={() => place(parentId, index)}
        onDragOver={(event) => {
          if (!disabled && event.dataTransfer.types.includes(DRAG_TYPE)) {
            event.preventDefault()
            event.stopPropagation()
            event.dataTransfer.dropEffect = activeDrag.current?.type === 'new' ? 'copy' : 'move'
            setHoveredSocket(testId)
          }
        }}
        onDragLeave={() => setHoveredSocket(null)}
        onDrop={(event) => drop(event, parentId, index)}
      >
        <span aria-hidden="true">＋</span>
        <span>{hoveredSocket === testId ? '松开，吸附在这里' : label}</span>
      </button>
    )
  }

  function moveSibling(nodeId: string, parentId: string | null, index: number, direction: -1 | 1) {
    attempt(() =>
      commit(
        moveArgumentNode(roots, nodeId, parentId, index + (direction === 1 ? 2 : -1)),
        '模块顺序已调整。',
      ),
    )
  }

  function moveOut(nodeId: string, parentId: string | null) {
    if (!parentId) return
    const parent = locate(roots, parentId)
    if (!parent) return
    attempt(() =>
      commit(
        moveArgumentNode(roots, nodeId, parent.parentId, parent.index + 1),
        '模块已移到外一层。',
      ),
    )
  }

  function remove(nodeId: string) {
    const location = locate(roots, nodeId)
    if (!location) return
    attempt(() => {
      commit(removeArgumentNode(roots, nodeId), '已移除模块及其内部内容，可以撤销。')
      setRemoved(location)
      if (selection?.type === 'move' && locate([location.node], selection.id)) setSelection(null)
    })
  }

  function undoRemove() {
    if (!removed) return
    attempt(() => {
      const siblings = removed.parentId ? locate(roots, removed.parentId)?.node.children : roots
      if (!siblings) throw new Error('原容器已不存在，暂时无法撤销这次移除。')
      commit(
        insertArgumentNode(
          roots,
          removed.node,
          removed.parentId,
          Math.min(removed.index, siblings.length),
        ),
        '已恢复移除的模块及其内部内容。',
      )
      setRemoved(null)
    })
  }

  function renderNodes(nodes: ArgumentNode[], parentId: string | null = null, depth = 1) {
    return nodes.map((node, index) => {
      const details = info.blocks[node.kind]
      const container = isArgumentContainer(node.kind)
      const selected = selection?.type === 'move' && selection.id === node.id
      return (
        <div className="humanities-node-slot" key={node.id}>
          {socket(parentId, index, `drop-before-${node.id}`, `放在第 ${index + 1} 个模块前`)}
          <article
            className={`humanities-node humanities-kind-${node.kind}${container ? ' is-container' : ''}${selected ? ' is-selected' : ''}`}
            data-testid={`block-${node.id}`}
            data-block-id={node.id}
            data-block-kind={node.kind}
            data-depth={depth}
            draggable={!disabled}
            onDragStart={(event) => startDrag(event, { type: 'move', id: node.id })}
            onDragEnd={endDrag}
            aria-label={`${details.label}模块，第 ${depth} 层`}
          >
            <header className="humanities-node-header">
              <button
                type="button"
                className="humanities-drag-handle"
                data-testid={`drag-${node.id}`}
                title="拖动模块；也可点击选择，再点目标卡槽"
                aria-label={`选择或拖动${details.label}模块`}
                aria-pressed={selected}
                disabled={disabled}
                draggable={!disabled}
                onDragStart={(event) => startDrag(event, { type: 'move', id: node.id })}
                onDragEnd={endDrag}
                onClick={() => select({ type: 'move', id: node.id })}
              >
                ⠿
              </button>
              <strong>{details.label}</strong>
              <span className="humanities-node-level">
                {container ? '可嵌套' : '内容'} · {depth} 层
              </span>
              <button
                type="button"
                className="humanities-remove"
                data-testid={`remove-${node.id}`}
                aria-label={`移除${details.label}模块及子模块`}
                disabled={disabled}
                onClick={() => remove(node.id)}
              >
                ×
              </button>
            </header>
            <div className="humanities-node-body">
              <label className="humanities-sr-only" htmlFor={`${id}-text-${node.id}`}>
                {details.label}内容
              </label>
              <textarea
                id={`${id}-text-${node.id}`}
                data-testid={`text-${node.id}`}
                value={node.text}
                placeholder={details.prompt}
                rows={container ? 2 : 3}
                maxLength={MAX_ARGUMENT_TEXT_LENGTH}
                disabled={disabled}
                onChange={(event) =>
                  attempt(() => commit(updateText(roots, node.id, event.target.value)))
                }
              />
              <div className="humanities-node-actions">
                <button
                  type="button"
                  data-testid={`select-${node.id}`}
                  aria-pressed={selected}
                  disabled={disabled}
                  onClick={() => select({ type: 'move', id: node.id })}
                >
                  {selected ? '已选中' : '选择位置'}
                </button>
                <button
                  type="button"
                  data-testid={`move-up-${node.id}`}
                  aria-label={`上移${details.label}模块`}
                  disabled={disabled || index === 0}
                  onClick={() => moveSibling(node.id, parentId, index, -1)}
                >
                  ↑ 上移
                </button>
                <button
                  type="button"
                  data-testid={`move-down-${node.id}`}
                  aria-label={`下移${details.label}模块`}
                  disabled={disabled || index === nodes.length - 1}
                  onClick={() => moveSibling(node.id, parentId, index, 1)}
                >
                  ↓ 下移
                </button>
                <button
                  type="button"
                  data-testid={`move-out-${node.id}`}
                  disabled={disabled || parentId === null}
                  onClick={() => moveOut(node.id, parentId)}
                >
                  ↖ 移出一层
                </button>
                <span className="humanities-text-count">
                  {node.text.length} / {MAX_ARGUMENT_TEXT_LENGTH}
                </span>
              </div>
            </div>
            {container && (
              <section className="humanities-cavity" aria-label={`${details.label}内部模块`}>
                {renderNodes(node.children, node.id, depth + 1)}
                {socket(
                  node.id,
                  node.children.length,
                  `drop-inside-${node.id}`,
                  node.children.length ? '放到容器末尾' : '放入这个容器',
                )}
                {!node.children.length && (
                  <p className="humanities-cavity-hint">把内容模块或另一段逻辑放进来</p>
                )}
              </section>
            )}
            {container && <div className="humanities-container-foot" aria-hidden="true" />}
          </article>
        </div>
      )
    })
  }

  function appendTemplate() {
    attempt(() => {
      let next = roots
      for (const node of makeTemplate(template))
        next = insertArgumentNode(next, node, null, next.length)
      commit(next, '已添加空白结构，请用本题的依据填写。')
    })
  }

  function syncText() {
    if (disabled || !generated.trim()) return
    if (draft.text.trim() && draft.text !== generated) {
      setSyncConfirmation({ generated, previous: draft.text })
      return
    }
    onChange({ ...draft, argument: { version: 1, roots }, text: generated })
    setAnnouncement('已用模块更新正文。后续编辑模块不会自动改动正文。')
    setSyncConfirmation(null)
  }

  function confirmSync() {
    if (disabled || !syncConfirmation) return
    if (syncConfirmation.generated !== generated || syncConfirmation.previous !== draft.text) {
      setError('内容已变化，请重新预览后更新正文。')
      setSyncConfirmation(null)
      return
    }
    onChange({ ...draft, argument: { version: 1, roots }, text: generated })
    setAnnouncement('正文已替换为当前模块生成的文字。')
    setSyncConfirmation(null)
  }

  return (
    <section
      className="humanities-composer"
      data-testid="humanities-composer"
      aria-labelledby={`${id}-heading`}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          setSelection(null)
          setHoveredSocket(null)
          setSyncConfirmation(null)
          setAnnouncement('已取消当前选择。')
        }
      }}
    >
      <header className="humanities-heading">
        <div>
          <span className="humanities-eyebrow">THINK · CONNECT · EXPRESS</span>
          <h3 id={`${id}-heading`}>{info.name}论证组装台</h3>
          <p>{info.hint}</p>
        </div>
        <span className="humanities-count">
          {total} / {MAX_ARGUMENT_NODES} 模块
        </span>
      </header>
      <p className="humanities-instruction">
        拖入彩色模块，在亮起的卡槽松开即可连接。也可先点模块，再点卡槽；支持键盘 Tab / Enter。
      </p>
      {conversion.error ? (
        <div className="humanities-migration-error" role="alert">
          <strong>旧草稿暂时无法转换：{conversion.error}</strong>
          <p>原正文和旧模块仍保留。可继续在正文中作答，或新建空白组装结构。</p>
          <details>
            <summary>查看保留的旧模块</summary>
            {draft.blocks.map((block) => (
              <p key={block.id}>
                <strong>{block.label}：</strong>
                {block.text}
              </p>
            ))}
          </details>
          <button
            type="button"
            disabled={disabled}
            onClick={() => attempt(() => commit([], '已新建空白组装结构，原正文与旧模块仍保留。'))}
          >
            新建空白组装结构
          </button>
        </div>
      ) : (
        <div className="humanities-layout">
          <aside className="humanities-palette" aria-labelledby={`${id}-palette`}>
            <h4 id={`${id}-palette`}>空白模块库</h4>
            <p>只给思路结构，内容由你填写。</p>
            <span className="humanities-palette-label">内容模块</span>
            {[LEAVES, CONTAINERS].map((group, groupIndex) => (
              <div className="humanities-palette-group" key={groupIndex}>
                {groupIndex === 1 && (
                  <span className="humanities-palette-label">逻辑容器 · 可放入子模块</span>
                )}
                {group.map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    className={`humanities-palette-block humanities-kind-${kind}${isArgumentContainer(kind) ? ' is-container' : ''}`}
                    data-testid={`palette-${kind}`}
                    draggable={!disabled && !atLimit}
                    disabled={disabled || atLimit}
                    aria-pressed={selection?.type === 'new' && selection.kind === kind}
                    onDragStart={(event) => startDrag(event, { type: 'new', kind })}
                    onDragEnd={endDrag}
                    onClick={() => select({ type: 'new', kind })}
                  >
                    <span className="humanities-palette-grip" aria-hidden="true">
                      ⠿
                    </span>
                    <span>
                      {info.blocks[kind].label}
                      <small>
                        {kind === 'cause'
                          ? '原因 → 过程 → 结果'
                          : kind === 'contrast'
                            ? '比较不同对象或维度'
                            : kind === 'point'
                              ? '让一段论证成为整体'
                              : '填写自己的内容'}
                      </small>
                    </span>
                    <span aria-hidden="true">＋</span>
                  </button>
                ))}
              </div>
            ))}
            <div className="humanities-template">
              <label htmlFor={`${id}-template`}>从空白结构开始</label>
              <select
                id={`${id}-template`}
                data-testid="argument-template"
                value={template}
                disabled={disabled || atLimit}
                onChange={(event) => setTemplate(event.target.value as Template)}
              >
                <option value="argument">完整论证 · 观点到结论</option>
                <option value="cause">因果分析 · 原因到结果</option>
                <option value="contrast">对比分析 · 两个对象</option>
                <option value="points">分点作答 · 两段论证</option>
              </select>
              <button
                type="button"
                data-testid="apply-template"
                disabled={disabled || atLimit}
                onClick={appendTemplate}
              >
                ＋ 添加空白结构
              </button>
              <small>追加到末尾，已有内容会保留。</small>
            </div>
          </aside>

          <section className="humanities-workspace" aria-labelledby={`${id}-canvas-heading`}>
            <header className="humanities-workspace-heading">
              <h4 id={`${id}-canvas-heading`}>我的论证结构</h4>
              <button
                type="button"
                data-testid="undo-remove"
                disabled={disabled || !removed}
                onClick={undoRemove}
              >
                ↶ 撤销移除
              </button>
            </header>
            <div className={`humanities-selection${selection ? ' has-selection' : ''}`}>
              <span>
                {selection
                  ? `已选择「${selectedLabel}」：点击卡槽放置`
                  : `可逐层嵌套，最多 ${MAX_ARGUMENT_DEPTH} 层；正文须单独更新。`}
              </span>
              {selection && (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    setSelection(null)
                    setHoveredSocket(null)
                  }}
                >
                  取消
                </button>
              )}
            </div>
            <div className="humanities-canvas" data-testid="argument-canvas">
              {!roots.length && (
                <div className="humanities-empty">
                  <span aria-hidden="true">
                    ▰<br />└ ▰
                  </span>
                  <strong>先搭思路，再写答案</strong>
                  <p>
                    从左侧拖入一个空白模块，
                    <br />
                    或添加一套空白结构。
                  </p>
                </div>
              )}
              {renderNodes(roots)}
              {socket(
                null,
                roots.length,
                'drop-root',
                roots.length ? '放到答案末尾' : '放入第一个模块',
              )}
            </div>
          </section>
        </div>
      )}
      {(error || atLimit) && (
        <p className="humanities-error" role="alert">
          {error || `已达到 ${MAX_ARGUMENT_NODES} 个模块上限，请先合并或移除模块。`}
        </p>
      )}
      <div className="humanities-announcement" role="status" aria-live="polite">
        {announcement}
      </div>
      <section className="humanities-preview" aria-labelledby={`${id}-preview-heading`}>
        <header>
          <div>
            <h4 id={`${id}-preview-heading`}>成文预览</h4>
            <p>按当前结构生成。请检查连接词、逻辑与事实；组装完成不代表答案正确。</p>
          </div>
          <span>{generated.length} 字符</span>
        </header>
        <label className="humanities-sr-only" htmlFor={`${id}-preview`}>
          模块生成文字预览
        </label>
        <textarea
          id={`${id}-preview`}
          data-testid="argument-preview"
          value={generated}
          readOnly
          rows={5}
          placeholder="填写模块后，这里会按你的论证顺序生成文字。"
        />
        <div className="humanities-sync-row">
          <p>手写正文独立保留，编辑或移动模块不会自动覆盖。</p>
          <button
            type="button"
            className="primary"
            data-testid="sync-argument"
            disabled={disabled || !generated.trim() || !!conversion.error}
            onClick={syncText}
          >
            用模块更新正文
          </button>
        </div>
        {syncConfirmation && (
          <div
            className="humanities-sync-confirmation"
            role="alertdialog"
            aria-labelledby={`${id}-confirm-heading`}
            aria-describedby={`${id}-confirm-detail`}
          >
            <strong id={`${id}-confirm-heading`}>替换已有正文？</strong>
            <p id={`${id}-confirm-detail`}>
              正文中已有不同的内容。继续会用上方预览完整替换正文，手动修改将被覆盖。
            </p>
            <div>
              <button
                type="button"
                data-testid="cancel-sync"
                autoFocus
                disabled={disabled}
                onClick={() => setSyncConfirmation(null)}
              >
                保留原正文
              </button>
              <button
                type="button"
                data-testid="confirm-sync"
                className="primary"
                disabled={disabled}
                onClick={confirmSync}
              >
                确认替换正文
              </button>
            </div>
          </div>
        )}
      </section>
    </section>
  )
}
