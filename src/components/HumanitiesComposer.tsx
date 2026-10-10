import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { DragEvent, PointerEvent as ReactPointerEvent } from 'react'
import type {
  AnswerDraft,
  ArgumentCanvas,
  ArgumentDocument,
  ArgumentKind,
  ArgumentNode,
  ArgumentPosition,
  Subject,
  StudentQuestion,
  ModelConfig,
  ExamCraftApi,
  ModuleReviewSuggestion,
} from '../shared/types'
import {
  argumentFromDraft,
  argumentCanvas,
  flattenArgument,
  boundArgumentCoordinate,
  positionArgumentNode,
  generateArgumentText,
  insertArgumentNode,
  isArgumentContainer,
  MAX_ARGUMENT_NODES,
  MAX_ARGUMENT_TEXT_LENGTH,
  moveArgumentNode,
  removeArgumentNode,
} from '../domain/argument'

import { ModuleReviewPanel } from './ModuleReviewPanel'
import { ArgumentTimeline } from './ArgumentTimeline'
import {
  checkpointArgument,
  restoreArgumentRevision,
  hasArgumentDraftChanges,
  checkpointAcceptedEdit,
} from '../domain/argument-revisions'
import { applyModuleSuggestion } from '../domain/module-review'

interface HumanitiesComposerProps {
  subject: Subject
  draft: AnswerDraft
  onChange: (draft: AnswerDraft) => void
  disabled?: boolean
  question?: StudentQuestion
  config?: ModelConfig | null
  api?: ExamCraftApi
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
  question,
  config,
  api,
}: HumanitiesComposerProps) {
  const id = useId()
  const info = subjectInfo[subject] ?? subjectInfo.politics!
  const [selection, setSelection] = useState<Placement | null>(null)
  const [template, setTemplate] = useState<Template>('argument')
  const [error, setError] = useState('')
  const [announcement, setAnnouncement] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [history, setHistory] = useState<ArgumentDocument[]>([])
  const [future, setFuture] = useState<ArgumentDocument[]>([])
  const [previewCanvas, setPreviewCanvas] = useState<ArgumentCanvas | null>(null)
  const [syncConfirmation, setSyncConfirmation] = useState<{
    generated: string
    previous: string
  } | null>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const activeDrag = useRef<Placement | null>(null)
  const gesture = useRef<{
    pointerId: number
    startX: number
    startY: number
    nodeId?: string
    canvas: ArgumentCanvas
    moved: boolean
  } | null>(null)
  const hadStructuredDraft = useRef(Boolean(draft.argument || draft.blocks.length))
  const conversion = useMemo(() => {
    try {
      const document = argumentFromDraft(draft)
      return {
        document: { ...document, canvas: argumentCanvas(document) },
        generated: generateArgumentText(document.roots),
        error: '',
      }
    } catch (cause) {
      return {
        document: {
          version: 1 as const,
          roots: [] as ArgumentNode[],
          canvas: { positions: {}, viewport: { x: 0, y: 0, zoom: 1 } },
        },
        generated: '',
        error: cause instanceof Error ? cause.message : '旧草稿暂时无法转换为模块。',
      }
    }
  }, [draft])
  const { document, generated } = conversion
  const { roots } = document
  const canvas = previewCanvas ?? document.canvas
  const flat = useMemo(() => flattenArgument(roots), [roots])
  const selected =
    selection?.type === 'move' ? flat.find(({ node }) => node.id === selection.id) : undefined
  const atLimit = flat.length >= MAX_ARGUMENT_NODES

  useEffect(() => {
    if (
      syncConfirmation &&
      (syncConfirmation.generated !== generated || syncConfirmation.previous !== draft.text)
    )
      setSyncConfirmation(null)
  }, [generated, draft.text, syncConfirmation])
  useEffect(() => {
    if (hadStructuredDraft.current && !draft.argument && !draft.blocks.length && !draft.text) {
      setSelection(null)
      setHistory([])
      setFuture([])
      setError('')
      setAnnouncement('')
      setPreviewCanvas(null)
      setSyncConfirmation(null)
      activeDrag.current = null
      gesture.current = null
    }
    hadStructuredDraft.current = Boolean(draft.argument || draft.blocks.length)
  }, [draft.argument, draft.blocks, draft.text])

  function attempt(action: () => void) {
    if (disabled) return
    try {
      action()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法完成操作，请检查模块结构。')
    }
  }
  function commit(next: ArgumentDocument, message = '', record = true) {
    if (disabled) return
    generateArgumentText(next.roots)
    const normalized = { ...next, canvas: argumentCanvas(next) }
    if (record) {
      setHistory((items) => [...items.slice(-49), document])
      setFuture([])
    }
    onChange({ ...draft, argument: normalized })
    setError('')
    setSyncConfirmation(null)
    if (message) setAnnouncement(message)
  }
  function commitRoots(next: ArgumentNode[], message = '') {
    commit({ ...document, roots: next }, message)
  }
  function undo() {
    if (disabled || !history.length) return
    const previous = history[history.length - 1]
    setFuture((items) => [...items, document])
    setHistory(history.slice(0, -1))
    commit(
      { ...previous, revisions: document.revisions },
      '已撤销上一步模块编辑；版本时间树仍保留。',
      false,
    )
    setSelection(null)
  }
  function redo() {
    if (disabled || !future.length) return
    setHistory((items) => [...items, document])
    setFuture(future.slice(0, -1))
    commit(
      { ...future[future.length - 1], revisions: document.revisions },
      '已重做模块编辑。',
      false,
    )
  }
  function worldPoint(clientX: number, clientY: number): ArgumentPosition {
    const box = viewportRef.current!.getBoundingClientRect()
    return {
      x: boundArgumentCoordinate((clientX - box.left - canvas.viewport.x) / canvas.viewport.zoom),
      y: boundArgumentCoordinate((clientY - box.top - canvas.viewport.y) / canvas.viewport.zoom),
    }
  }
  function centerPoint(): ArgumentPosition {
    const box = viewportRef.current!.getBoundingClientRect()
    const point = worldPoint(box.left + box.width / 2, box.top + box.height / 2)
    return { x: point.x - 110, y: point.y - 75 }
  }
  function place(placement: Placement, point: ArgumentPosition, centerView = false) {
    attempt(() => {
      if (placement.type === 'new') {
        const node = makeNode(placement.kind)
        const next = { ...document, roots: insertArgumentNode(roots, node, null, roots.length) }
        const placed = positionArgumentNode(next, node.id, point)
        if (centerView && viewportRef.current) {
          const box = viewportRef.current.getBoundingClientRect()
          placed.canvas!.viewport.x = boundArgumentCoordinate(
            box.width / 2 - (point.x + 112) * placed.canvas!.viewport.zoom,
          )
          placed.canvas!.viewport.y = boundArgumentCoordinate(
            box.height / 2 - (point.y + 75) * placed.canvas!.viewport.zoom,
          )
        }
        commit(placed, '模块已自由放置；默认追加到成文顺序末尾。')
        setSelection({ type: 'move', id: node.id })
      } else
        commit(
          positionArgumentNode(document, placement.id, point),
          '位置已保存，逻辑关系与成文顺序保持不变。',
        )
    })
  }
  function placeAtCenter() {
    if (selection?.type !== 'new') return
    const origin = centerPoint()
    let point = origin
    const occupied = Object.values(canvas.positions)
    // Keyboard insertion finds an empty nearby cell, then brings that location
    // to the viewport center. Explicit pointer drops retain exact coordinates.
    for (let index = 0; index <= MAX_ARGUMENT_NODES; index++) {
      point = { x: origin.x + (index % 9) * 250, y: origin.y + Math.floor(index / 9) * 175 }
      if (!occupied.some((p) => Math.abs(p.x - point.x) < 240 && Math.abs(p.y - point.y) < 165))
        break
    }
    place(selection, point, true)
  }
  function revealNode(nodeId: string) {
    setSelection({ type: 'move', id: nodeId })
    const box = viewportRef.current?.getBoundingClientRect(),
      point = canvas.positions[nodeId]
    if (!box || !point) return
    const { x, y, zoom } = canvas.viewport
    if (
      point.x * zoom + x < 0 ||
      (point.x + 224) * zoom + x > box.width ||
      point.y * zoom + y < 0 ||
      (point.y + 150) * zoom + y > box.height
    ) {
      commit(
        {
          ...document,
          canvas: {
            ...canvas,
            viewport: {
              ...canvas.viewport,
              x: boundArgumentCoordinate(box.width / 2 - (point.x + 112) * zoom),
              y: boundArgumentCoordinate(box.height / 2 - (point.y + 75) * zoom),
            },
          },
        },
        '',
        false,
      )
    }
  }
  function startPaletteDrag(event: DragEvent, kind: ArgumentKind) {
    if (disabled) {
      event.preventDefault()
      return
    }
    activeDrag.current = { type: 'new', kind }
    event.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ owner: id }))
    event.dataTransfer.effectAllowed = 'copy'
  }
  function drop(event: DragEvent) {
    event.preventDefault()
    try {
      const payload = JSON.parse(event.dataTransfer.getData(DRAG_TYPE))
      if (payload.owner === id && activeDrag.current)
        place(activeDrag.current, worldPoint(event.clientX, event.clientY))
    } catch {
      setError('请从此组装台拖入模块。')
    }
    activeDrag.current = null
  }
  function startGesture(event: ReactPointerEvent, nodeId?: string) {
    if (disabled || event.button !== 0) return
    event.stopPropagation()
    if (!nodeId && selection?.type === 'new') {
      place(selection, worldPoint(event.clientX, event.clientY))
      return
    }
    event.preventDefault()
    if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus()
    event.currentTarget.setPointerCapture(event.pointerId)
    gesture.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      nodeId,
      canvas: structuredClone(canvas),
      moved: false,
    }
    if (nodeId) setSelection({ type: 'move', id: nodeId })
  }
  function moveGesture(event: ReactPointerEvent) {
    const current = gesture.current
    if (!current || current.pointerId !== event.pointerId) return
    const dx = event.clientX - current.startX,
      dy = event.clientY - current.startY
    if (Math.abs(dx) + Math.abs(dy) > 2) current.moved = true
    const next = structuredClone(current.canvas)
    if (current.nodeId) {
      const original = current.canvas.positions[current.nodeId]
      next.positions[current.nodeId] = {
        x: boundArgumentCoordinate(original.x + dx / next.viewport.zoom),
        y: boundArgumentCoordinate(original.y + dy / next.viewport.zoom),
      }
    } else {
      next.viewport.x = boundArgumentCoordinate(next.viewport.x + dx)
      next.viewport.y = boundArgumentCoordinate(next.viewport.y + dy)
    }
    setPreviewCanvas(next)
  }
  function finishGesture(event: ReactPointerEvent, cancel = false) {
    const current = gesture.current
    if (!current || current.pointerId !== event.pointerId) return
    if (current.moved && !cancel) {
      const next = structuredClone(current.canvas)
      const dx = event.clientX - current.startX,
        dy = event.clientY - current.startY
      if (current.nodeId) {
        const original = current.canvas.positions[current.nodeId]
        next.positions[current.nodeId] = {
          x: boundArgumentCoordinate(original.x + dx / next.viewport.zoom),
          y: boundArgumentCoordinate(original.y + dy / next.viewport.zoom),
        }
      } else {
        next.viewport.x = boundArgumentCoordinate(next.viewport.x + dx)
        next.viewport.y = boundArgumentCoordinate(next.viewport.y + dy)
      }
      attempt(() =>
        commit(
          { ...document, canvas: next },
          current.nodeId ? '自由位置已保存，成文顺序不变。' : '',
          Boolean(current.nodeId),
        ),
      )
    }
    gesture.current = null
    setPreviewCanvas(null)
  }
  function zoomBy(factor: number) {
    const box = viewportRef.current?.getBoundingClientRect()
    if (!box) return
    const old = canvas.viewport,
      zoom = Math.max(0.15, Math.min(2, old.zoom * factor))
    commit(
      {
        ...document,
        canvas: {
          ...canvas,
          viewport: {
            zoom,
            x: boundArgumentCoordinate(box.width / 2 - ((box.width / 2 - old.x) * zoom) / old.zoom),
            y: boundArgumentCoordinate(
              box.height / 2 - ((box.height / 2 - old.y) * zoom) / old.zoom,
            ),
          },
        },
      },
      '',
      false,
    )
  }
  function fit() {
    const box = viewportRef.current?.getBoundingClientRect()
    if (!box || !flat.length) return
    const positions = Object.values(canvas.positions)
    const minX = Math.min(...positions.map((p) => p.x)),
      minY = Math.min(...positions.map((p) => p.y))
    const width = Math.max(...positions.map((p) => p.x + 224)) - minX,
      height = Math.max(...positions.map((p) => p.y + 160)) - minY
    const zoom = Math.max(0.15, Math.min(1, (box.width - 40) / width, (box.height - 40) / height))
    commit(
      {
        ...document,
        canvas: {
          ...canvas,
          viewport: {
            zoom,
            x: boundArgumentCoordinate((box.width - width * zoom) / 2 - minX * zoom),
            y: boundArgumentCoordinate((box.height - height * zoom) / 2 - minY * zoom),
          },
        },
      },
      '已缩放到全部模块。',
      false,
    )
  }
  function reorder(direction: -1 | 1) {
    if (!selected) return
    attempt(() =>
      commitRoots(
        moveArgumentNode(
          roots,
          selected.node.id,
          selected.parentId,
          selected.index + (direction === 1 ? 2 : -1),
        ),
        '成文顺序已调整，画布位置不变。',
      ),
    )
  }
  function reparent(parentId: string | null) {
    if (!selected) return
    const siblings = parentId ? locate(roots, parentId)?.node.children : roots
    if (siblings)
      attempt(() =>
        commitRoots(
          moveArgumentNode(roots, selected.node.id, parentId, siblings.length),
          '逻辑连接已更新，画布位置不变。',
        ),
      )
  }
  function appendTemplate() {
    attempt(() => {
      let next = roots
      const added = makeTemplate(template)
      for (const node of added) next = insertArgumentNode(next, node, null, next.length)
      const nextCanvas = argumentCanvas({ ...document, roots: next })
      const origin = centerPoint()
      flattenArgument(added).forEach(({ node }, index) => {
        nextCanvas.positions[node.id] = {
          x: boundArgumentCoordinate(origin.x + (index % 3) * 260),
          y: boundArgumentCoordinate(origin.y + Math.floor(index / 3) * 180),
        }
      })
      commit(
        { ...document, roots: next, canvas: nextCanvas },
        '已添加空白结构；每个模块都可独立自由移动。',
      )
    })
  }
  function selectReviewTarget(nodeId: string, span?: { start: number; end: number }) {
    revealNode(nodeId)
    requestAnimationFrame(() => {
      const field = window.document.getElementById(`${id}-text-${nodeId}`)
      if (field instanceof HTMLTextAreaElement) {
        field.focus({ preventScroll: true })
        if (span) field.setSelectionRange(span.start, span.end)
      }
    })
  }
  function acceptSuggestion(suggestion: ModuleReviewSuggestion): { ok: boolean; message?: string } {
    if (disabled) return { ok: false, message: '当前正在提交，请稍后再修改模块。' }
    try {
      const edited = applyModuleSuggestion(document, suggestion)
      const next = checkpointAcceptedEdit(
        document,
        edited.roots,
        `接受建议：${suggestion.reason.slice(0, 55)}`,
      )
      commit(next, '已接受此项修改并记录版本；最终正文未改变。')
      return { ok: true }
    } catch (cause) {
      return {
        ok: false,
        message: cause instanceof Error ? cause.message : '无法应用建议，请重新审阅。',
      }
    }
  }
  function saveCheckpoint(label: string) {
    attempt(() =>
      commit(checkpointArgument(document, { label, source: 'manual' }), '检查点已保存。', false),
    )
  }
  function restoreCheckpoint(revisionId: string) {
    attempt(() => {
      const saved = hasArgumentDraftChanges(document)
        ? checkpointArgument(document, { label: '恢复前保留的修改', source: 'manual' })
        : document
      commit(restoreArgumentRevision(saved, revisionId), '模块版本已恢复，原分支与最终正文保留。')
      setSelection(null)
    })
  }

  function syncText(confirm = false) {
    if (disabled || !generated.trim()) return
    if (!confirm && draft.text.trim() && draft.text !== generated) {
      setSyncConfirmation({ generated, previous: draft.text })
      return
    }
    if (
      confirm &&
      (!syncConfirmation ||
        syncConfirmation.generated !== generated ||
        syncConfirmation.previous !== draft.text)
    )
      return
    onChange({ ...draft, argument: document, text: generated })
    setSyncConfirmation(null)
    setAnnouncement('已用模块更新正文。后续编辑模块不会自动改动正文。')
  }

  return (
    <section
      className="humanities-composer free-composer"
      data-testid="humanities-composer"
      aria-labelledby={`${id}-heading`}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          setSelection(null)
          setSyncConfirmation(null)
        }
        if (
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === 'z' &&
          !(event.target instanceof Element && event.target.closest('textarea,input'))
        ) {
          event.preventDefault()
          event.shiftKey ? redo() : undo()
        }
      }}
    >
      <header className="humanities-heading">
        <div>
          <h3 id={`${id}-heading`}>{info.name}自由论证画布</h3>
          <p>{info.hint}</p>
        </div>
        <span className="humanities-count">
          {flat.length} / {MAX_ARGUMENT_NODES} 模块
        </span>
      </header>
      {conversion.error ? (
        <div role="alert">
          <strong>旧草稿暂时无法转换：{conversion.error}</strong>
          <p>原正文和旧模块仍保留。</p>
          <button
            type="button"
            disabled={disabled}
            onClick={() => attempt(() => commitRoots([], '已新建空白结构，原正文和旧模块仍保留。'))}
          >
            新建空白组装结构
          </button>
        </div>
      ) : (
        <>
          <div className="free-palette" aria-label="空白模块库">
            {[...LEAVES, ...CONTAINERS].map((kind) => (
              <button
                key={kind}
                type="button"
                className={`humanities-kind-${kind} free-palette-block`}
                data-testid={`palette-${kind}`}
                draggable={!disabled && !atLimit}
                disabled={disabled || atLimit}
                aria-pressed={selection?.type === 'new' && selection.kind === kind}
                onDragStart={(event) => startPaletteDrag(event, kind)}
                onDragEnd={() => {
                  activeDrag.current = null
                }}
                onClick={() => {
                  setSelection({ type: 'new', kind })
                  setAnnouncement('点击画布任意位置放置，或按“放到视野中央”。')
                }}
              >
                ＋ {info.blocks[kind].label}
              </button>
            ))}
            <details className="free-template">
              <summary>空白结构</summary>
              <label htmlFor={`${id}-template`}>选择结构</label>
              <select
                id={`${id}-template`}
                data-testid="argument-template"
                value={template}
                disabled={disabled || atLimit}
                onChange={(event) => setTemplate(event.target.value as Template)}
              >
                <option value="argument">完整论证</option>
                <option value="cause">因果分析</option>
                <option value="contrast">对比分析</option>
                <option value="points">分点作答</option>
              </select>
              <button
                type="button"
                data-testid="apply-template"
                disabled={disabled || atLimit}
                onClick={appendTemplate}
              >
                ＋ 添加空白结构
              </button>
            </details>
          </div>
          <div className="free-toolbar" role="toolbar" aria-label="画布工具">
            <button
              type="button"
              disabled={disabled || !history.length}
              data-testid="undo-argument"
              onClick={undo}
            >
              ↶ 撤销
            </button>
            <button type="button" disabled={disabled || !future.length} onClick={redo}>
              ↷ 重做
            </button>
            <button
              type="button"
              aria-label="缩小画布"
              disabled={disabled || canvas.viewport.zoom <= 0.15}
              onClick={() => zoomBy(1 / 1.2)}
            >
              −
            </button>
            <output aria-label="画布缩放">{Math.round(canvas.viewport.zoom * 100)}%</output>
            <button
              type="button"
              aria-label="放大画布"
              disabled={disabled || canvas.viewport.zoom >= 2}
              onClick={() => zoomBy(1.2)}
            >
              ＋
            </button>
            <button type="button" disabled={disabled || !flat.length} onClick={fit}>
              适应全部
            </button>
            <button type="button" aria-pressed={expanded} onClick={() => setExpanded(!expanded)}>
              {expanded ? '收起画布' : '展开画布'}
            </button>
            {selection?.type === 'new' && (
              <button
                type="button"
                disabled={disabled}
                data-testid="place-center"
                onClick={placeAtCenter}
              >
                放到视野中央
              </button>
            )}
          </div>
          <p className="free-help">
            {selection?.type === 'new'
              ? `已选「${info.blocks[selection.kind].label}」，点击任意空白处放置。`
              : '拖动模块标题可自由摆放，拖动空白处平移；标题聚焦后方向键移动，Shift 微调。'}{' '}
            位置不影响成文顺序。
          </p>
          <div
            ref={viewportRef}
            className={`free-canvas${expanded ? ' is-expanded' : ''}`}
            data-testid="argument-canvas"
            tabIndex={0}
            aria-label="自由论证画布，拖动空白处平移，方向键平移"
            onDragOver={(event) => {
              if (!disabled && event.dataTransfer.types.includes(DRAG_TYPE)) event.preventDefault()
            }}
            onDrop={drop}
            onPointerDown={(event) => {
              if (!(event.target instanceof Element && event.target.closest('.free-node')))
                startGesture(event)
            }}
            onPointerMove={moveGesture}
            onPointerUp={(event) => finishGesture(event)}
            onPointerCancel={(event) => finishGesture(event, true)}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget || disabled) return
              const deltas: Record<string, [number, number]> = {
                ArrowLeft: [40, 0],
                ArrowRight: [-40, 0],
                ArrowUp: [0, 40],
                ArrowDown: [0, -40],
              }
              if (deltas[event.key]) {
                event.preventDefault()
                const [x, y] = deltas[event.key]
                commit(
                  {
                    ...document,
                    canvas: {
                      ...canvas,
                      viewport: {
                        ...canvas.viewport,
                        x: boundArgumentCoordinate(canvas.viewport.x + x),
                        y: boundArgumentCoordinate(canvas.viewport.y + y),
                      },
                    },
                  },
                  '',
                  false,
                )
              }
            }}
          >
            {!flat.length && (
              <div className="free-empty">
                把模块拖到这里的任意位置
                <br />
                <small>也可点选模块，再点画布；成文关系单独设置。</small>
              </div>
            )}
            <div
              className="free-world"
              style={{
                transform: `translate(${canvas.viewport.x}px, ${canvas.viewport.y}px) scale(${canvas.viewport.zoom})`,
              }}
            >
              <svg className="free-connections" aria-hidden="true">
                <defs>
                  <marker
                    id={`${id}-arrow`}
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
                  </marker>
                </defs>
                {flat
                  .filter((item) => item.parentId)
                  .map(({ node, parentId }) => {
                    const from = canvas.positions[parentId!],
                      to = canvas.positions[node.id]
                    return (
                      <path
                        key={node.id}
                        d={`M ${from.x + 224} ${from.y + 30} C ${from.x + 264} ${from.y + 30}, ${to.x - 40} ${to.y + 30}, ${to.x} ${to.y + 30}`}
                        markerEnd={`url(#${id}-arrow)`}
                      />
                    )
                  })}
              </svg>
              {flat.map(({ node, path, parentId }) => {
                const position = canvas.positions[node.id]
                const details = info.blocks[node.kind]
                return (
                  <article
                    key={node.id}
                    className={`free-node humanities-kind-${node.kind}${selected?.node.id === node.id ? ' is-selected' : ''}`}
                    style={{ left: position.x, top: position.y }}
                    data-testid={`block-${node.id}`}
                    data-block-id={node.id}
                    data-block-kind={node.kind}
                    data-parent-id={parentId ?? ''}
                    data-x={position.x}
                    data-y={position.y}
                    aria-label={`${details.label}模块，成文序号 ${path}`}
                    onClick={() => setSelection({ type: 'move', id: node.id })}
                  >
                    <header>
                      <button
                        type="button"
                        className="free-drag-handle"
                        data-testid={`drag-${node.id}`}
                        disabled={disabled}
                        aria-label={`移动${details.label}模块，方向键调整位置`}
                        aria-pressed={selected?.node.id === node.id}
                        onPointerDown={(event) => startGesture(event, node.id)}
                        onKeyDown={(event) => {
                          const deltas: Record<string, [number, number]> = {
                            ArrowLeft: [-1, 0],
                            ArrowRight: [1, 0],
                            ArrowUp: [0, -1],
                            ArrowDown: [0, 1],
                          }
                          if (deltas[event.key] && !disabled) {
                            event.preventDefault()
                            event.stopPropagation()
                            const [x, y] = deltas[event.key],
                              step = event.shiftKey ? 1 : 10
                            attempt(() =>
                              commit(
                                positionArgumentNode(document, node.id, {
                                  x: position.x + x * step,
                                  y: position.y + y * step,
                                }),
                                '位置已调整，成文顺序不变。',
                              ),
                            )
                          }
                        }}
                        onClick={() => setSelection({ type: 'move', id: node.id })}
                      >
                        ⠿ {details.label} <small>{path}</small>
                      </button>
                      <button
                        type="button"
                        className="free-remove"
                        data-testid={`remove-${node.id}`}
                        aria-label={`移除${details.label}模块及子模块`}
                        disabled={disabled}
                        onClick={(event) => {
                          event.stopPropagation()
                          attempt(() => {
                            commitRoots(
                              removeArgumentNode(roots, node.id),
                              '已移除模块及逻辑子模块，可撤销。',
                            )
                            setSelection(null)
                          })
                        }}
                      >
                        ×
                      </button>
                    </header>
                    <label className="humanities-sr-only" htmlFor={`${id}-text-${node.id}`}>
                      {details.label}内容
                    </label>
                    <textarea
                      id={`${id}-text-${node.id}`}
                      data-testid={`text-${node.id}`}
                      data-advisor-source={node.kind === 'material' ? 'material' : 'argument'}
                      value={node.text}
                      placeholder={details.prompt}
                      rows={2}
                      maxLength={MAX_ARGUMENT_TEXT_LENGTH}
                      disabled={disabled}
                      onFocus={() => setSelection({ type: 'move', id: node.id })}
                      onChange={(event) =>
                        attempt(() => commitRoots(updateText(roots, node.id, event.target.value)))
                      }
                    />
                    <footer>
                      {parentId
                        ? `属于 ${flat.find((item) => item.node.id === parentId)?.path}`
                        : '主序列'}
                      {isArgumentContainer(node.kind)
                        ? ` · ${node.children.length} 个逻辑子模块`
                        : ''}
                    </footer>
                  </article>
                )
              })}
            </div>
          </div>
          {selected && (
            <div className="free-inspector" aria-label="所选模块逻辑关系">
              <strong>
                {info.blocks[selected.node.kind].label} · {selected.path}
              </strong>
              <label>
                逻辑归属
                <select
                  data-testid="argument-parent"
                  value={selected.parentId ?? ''}
                  disabled={disabled}
                  onChange={(event) => reparent(event.target.value || null)}
                >
                  <option value="">答案主序列</option>
                  {flat
                    .filter(
                      ({ node }) =>
                        isArgumentContainer(node.kind) &&
                        node.id !== selected.node.id &&
                        !locate(selected.node.children, node.id),
                    )
                    .map(({ node, path }) => (
                      <option key={node.id} value={node.id}>
                        {path} · {info.blocks[node.kind].label} {node.text.slice(0, 16)}
                      </option>
                    ))}
                </select>
              </label>
              <button
                type="button"
                data-testid={`move-up-${selected.node.id}`}
                disabled={disabled || selected.index === 0}
                onClick={() => reorder(-1)}
              >
                成文提前
              </button>
              <button
                type="button"
                data-testid={`move-down-${selected.node.id}`}
                disabled={
                  disabled ||
                  selected.index >=
                    (selected.parentId
                      ? locate(roots, selected.parentId)!.node.children.length
                      : roots.length) -
                      1
                }
                onClick={() => reorder(1)}
              >
                成文延后
              </button>
              <small>逻辑归属与顺序单独设置，不吸附、不限制位置。</small>
            </div>
          )}
          <details className="free-outline">
            <summary>成文顺序与逻辑连接（{flat.length} 个模块）</summary>
            <ol>
              {flat.map(({ node, parentId, path }) => (
                <li key={node.id}>
                  <button
                    type="button"
                    disabled={disabled}
                    aria-pressed={selected?.node.id === node.id}
                    data-testid={`select-${node.id}`}
                    onClick={() => revealNode(node.id)}
                  >
                    {path} · {info.blocks[node.kind].label} {node.text.slice(0, 36) || '（空白）'}
                  </button>
                  <span>
                    {parentId
                      ? `连接到 ${flat.find((item) => item.node.id === parentId)?.path}`
                      : '主序列'}
                  </span>
                </li>
              ))}
            </ol>
          </details>
        </>
      )}
      {(error || atLimit) && (
        <p className="humanities-error" role="alert">
          {error || `已达到 ${MAX_ARGUMENT_NODES} 个模块上限。`}
        </p>
      )}
      <div className="humanities-announcement" role="status" aria-live="polite">
        {announcement}
      </div>
      <details className="free-preview">
        <summary>成文预览 · {generated.length} 字符</summary>
        <p>按逻辑顺序生成，与画布位置无关。请检查连接词、逻辑和事实。</p>
        <label className="humanities-sr-only" htmlFor={`${id}-preview`}>
          模块生成文字预览
        </label>
        <textarea
          id={`${id}-preview`}
          data-testid="argument-preview"
          value={generated}
          readOnly
          rows={4}
          placeholder="填写模块后，这里会按你的论证顺序生成文字。"
        />
      </details>
      <div className="humanities-sync-row">
        <p>正文独立保留，移动模块不会自动覆盖。</p>
        <button
          type="button"
          className="primary"
          data-testid="sync-argument"
          disabled={disabled || !generated.trim() || !!conversion.error}
          onClick={() => syncText()}
        >
          用模块更新正文
        </button>
      </div>
      {!conversion.error && (
        <>
          {question && api && (
            <ModuleReviewPanel
              disabled={disabled}
              document={document}
              question={question}
              config={config ?? null}
              api={api}
              selectedNodeId={selected?.node.id}
              onSelect={selectReviewTarget}
              onApply={acceptSuggestion}
            />
          )}
          <ArgumentTimeline
            document={document}
            disabled={disabled}
            onCheckpoint={saveCheckpoint}
            onRestore={restoreCheckpoint}
          />
        </>
      )}
      {syncConfirmation && (
        <div
          className="humanities-sync-confirmation"
          role="alertdialog"
          aria-labelledby={`${id}-confirm-heading`}
        >
          <strong id={`${id}-confirm-heading`}>替换已有正文？</strong>
          <p>继续会用模块预览完整替换正文，手动修改将被覆盖。</p>
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
            onClick={() => syncText(true)}
          >
            确认替换正文
          </button>
        </div>
      )}
    </section>
  )
}
