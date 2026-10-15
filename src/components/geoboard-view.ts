import {
  BoardHistory,
  add,
  appendNodes,
  angleDegrees,
  assertGeoboard,
  boardStyle,
  clipLine,
  distance,
  dot,
  emptyGeoboard,
  intersections,
  movePoint,
  mul,
  parseGeoboard,
  polygonMetrics,
  removeNodes,
  snapPosition,
  solveGeoboard,
  sub,
  transformedCopy,
} from '../domain/geoboard'
import type {
  BoardNode,
  BoardObject,
  BoardPoint,
  BoardVec,
  GeoboardState,
  Resolved,
} from '../domain/geoboard'

const NS = 'http://www.w3.org/2000/svg'
const WIDTH = 800,
  HEIGHT = 600
const fmt = (n: number): string => (Number.isFinite(n) ? Number(n.toFixed(5)).toString() : '未定义')
const names: Record<string, string> = {
  free: '自由点',
  midpoint: '中点',
  projection: '垂足',
  reflection: '轴对称点',
  intersection: '交点',
  'on-object': '约束点',
  segment: '线段',
  line: '直线',
  ray: '射线',
  parallel: '平行线',
  perpendicular: '垂线',
  circle: '圆',
  'fixed-circle': '定半径圆',
  circumcircle: '三点圆',
  polygon: '橡皮筋多边形',
  arc: '圆弧',
  tangent: '切线',
}
const tools = [
  ['move', '选择 / 拖动', '拖动自由点或约束点；派生图形自动重算。'],
  ['pan', '平移', '拖动画布平移，滚轮以指针为中心缩放。'],
  ['point', '描点', '点击画布放置点，也可用坐标输入。'],
  ['segment', '线段', '依次点击两点，可直接在空白处创建端点。'],
  ['line', '直线', '依次点击两点，直线在整个视窗中延伸。'],
  ['ray', '射线', '依次点击起点和方向点。'],
  ['polygon', '橡皮筋', '依次点击顶点；点击首点或按 Enter 闭合。'],
  ['circle', '圆', '依次点击圆心和圆上一点。'],
  ['fixed-circle', '定半径圆', '先设置半径，再点击圆心。'],
  ['circumcircle', '三点圆', '依次点击圆上的三个不同点。'],
  ['arc', '圆弧', '依次点圆心、起点、结束方向点；沿逆时针，第三点只确定终止方向。'],
  ['midpoint', '中点', '依次点击两个端点。'],
  ['parallel', '平行线', '先点击过点，再点击已有直线、线段或射线。'],
  ['perpendicular', '垂线', '先点击过点，再点击已有直线、线段或射线。'],
  ['projection', '垂足', '先点击待投影点，再点击直线（取所在直线，不限线段内）。'],
  ['intersection', '交点', '依次点击两条直线、线段、射线或圆，生成全部有效交点。'],
  ['tangent', '切线', '先点击圆外点或圆上点，再点击圆；自动生成有效切线。'],
  ['on-object', '线上 / 圆上点', '点击已有线或圆，生成可沿该图形拖动的约束点。'],
  ['reflection', '轴对称点', '先点击原点，再点击作为对称轴的直线。'],
  ['measure', '测量', '点击两点测距离，第三点测角；角的顶点为第二点。'],
] as const
type Tool = (typeof tools)[number][0]
type LegacyDrawing = {
  points: { id: string; x: number; y: number; label: string }[]
  lines: { id: string; from: string; to: string }[]
}
export interface GeoboardViewOptions {
  value?: GeoboardState
  disabled?: boolean
  onChange: (state: GeoboardState) => void
  legacy?: LegacyDrawing
}
function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls = '',
  text = '',
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  if (cls) el.className = cls
  if (text) el.textContent = text
  return el
}
function svgElement<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
  text = '',
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(NS, tag)
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value))
  if (text) el.textContent = text
  return el
}
function field(
  label: string,
  value: string,
  type = 'number',
): { label: HTMLLabelElement; input: HTMLInputElement } {
  const outer = element('label', 'gb-field'),
    name = element('span', '', label),
    input = element('input')
  input.type = type
  input.value = value
  input.setAttribute('aria-label', label)
  if (type === 'number') input.step = 'any'
  outer.append(name, input)
  return { label: outer, input }
}
export class GeoboardView {
  private history: BoardHistory
  private readonly root = element('section', 'geoboard')
  private readonly toolbar = element('div', 'gb-toolbar')
  private readonly canvas = svgElement('svg', {
    viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
    tabindex: 0,
    role: 'img',
    'aria-label': '动态几何钉板',
  })
  private readonly canvasGroup = svgElement('g')
  private readonly status = element('p', 'gb-status')
  private readonly hint = element('p', 'gb-hint')
  private readonly inspector = element('div', 'gb-inspector')
  private readonly objects = element('div', 'gb-object-list')
  private readonly counts = element('span', 'gb-count')
  private readonly measurement = element('div', 'gb-measurement')
  private readonly controls = element('div', 'gb-view-controls')
  private readonly gridSelect = element('select')
  private readonly stepInput = field('吸附步长', '1').input
  private readonly radiusInput = field('作圆半径', '3').input
  private readonly fileInput = element('input')
  private tool: Tool = 'move'
  private pending: string[] = []
  private selected: string[] = []
  private measured: string[] = []
  private disabled: boolean
  private legacy?: LegacyDrawing
  private color = '#3d9ee8'
  private preview: GeoboardState | null = null
  private drag: {
    pointer: number
    id?: string
    from: BoardVec
    start: { x: number; y: number }
    before: GeoboardState
    moved: boolean
  } | null = null
  private suppressClick = false
  private space = false
  private destroyed = false
  private readonly listener = new AbortController()
  private readonly onChange: (state: GeoboardState) => void
  private uid = (): string => {
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    return `gb-${Array.from(bytes, (n) => n.toString(16).padStart(2, '0')).join('')}`
  }
  constructor(host: HTMLElement, options: GeoboardViewOptions) {
    const state = options.value ?? emptyGeoboard()
    assertGeoboard(state)
    this.history = new BoardHistory(state)
    this.onChange = options.onChange
    this.disabled = options.disabled ?? false
    this.legacy = options.legacy
    this.root.setAttribute('aria-label', 'Geoboard 动态几何')
    this.root.tabIndex = -1
    const title = element('div', 'gb-heading'),
      titleText = element('div')
    titleText.append(
      element('h4', '', '动态钉板 · 几何实验室'),
      element('p', '', '自己构造，拖动验证；数值测量不能代替数学证明。'),
    )
    title.append(titleText, this.counts)
    this.toolbar.setAttribute('role', 'toolbar')
    this.toolbar.setAttribute('aria-label', '动态几何工具')
    for (const [id, label, help] of tools) {
      const button = this.button(label, () => {
        this.tool = id
        this.pending = []
        this.measured = []
        this.preview = null
        this.drag = null
        this.message(help)
        this.render()
      })
      button.dataset.tool = id
      button.title = help
      this.toolbar.append(button)
    }
    const historyBar = element('div', 'gb-actions')
    const undo = this.button('撤销钉板操作', () => this.undo())
    undo.dataset.action = 'undo'
    const redo = this.button('重做钉板操作', () => this.redo())
    redo.dataset.action = 'redo'
    const clear = this.button('清空钉板', () => {
      if (window.confirm('只清空此题的钉板，保留旧数学画布与历史提交。清空可以撤销。'))
        this.commit({ ...this.state, points: [], objects: [] })
    })
    const json = this.button(
      '导出钉板 JSON',
      () =>
        this.download(
          'examcraft-geoboard.json',
          JSON.stringify(this.state, null, 2),
          'application/json',
        ),
      false,
    )
    const svg = this.button('导出 SVG', () => this.exportSvg(), false)
    const importButton = this.button('导入钉板 JSON', () => this.fileInput.click())
    const legacy = this.button('复制旧画布点线', () => this.copyLegacy())
    legacy.dataset.action = 'legacy'
    const fit = this.button('回到原点', () =>
      this.commit({ ...this.state, view: { ...this.state.view, x: 0, y: 0, scale: 32 } }),
    )
    historyBar.append(undo, redo, clear, fit, legacy, importButton, json, svg)
    this.fileInput.type = 'file'
    this.fileInput.accept = '.json,application/json'
    this.fileInput.hidden = true
    this.fileInput.addEventListener(
      'change',
      async () => {
        const file = this.fileInput.files?.[0]
        this.fileInput.value = ''
        if (!file || this.disabled) return
        const before = this.history.present
        try {
          if (file.size > 1024 * 1024) throw new Error('文件不能超过 1 MiB。')
          const imported = parseGeoboard(await file.text())
          if (this.destroyed || this.disabled || this.history.present !== before)
            throw new Error('作答已经变化，未覆盖当前钉板；请重新导入。')
          if (
            (!this.state.points.length && !this.state.objects.length) ||
            window.confirm('用导入的图形替换当前钉板？可以撤销，不影响旧画布或历史提交。')
          )
            this.commit(imported)
        } catch (e) {
          this.error(e)
        }
      },
      { signal: this.listener.signal },
    )
    this.gridSelect.setAttribute('aria-label', '钉板网格')
    for (const [value, label] of [
      ['square', '方格钉板'],
      ['isometric', '等距三角钉板'],
      ['circular', '同心圆钉板'],
      ['none', '无网格'],
    ]) {
      const option = element('option', '', label)
      option.value = value
      this.gridSelect.append(option)
    }
    this.gridSelect.addEventListener('change', () =>
      this.changeView({ grid: this.gridSelect.value as GeoboardState['view']['grid'] }),
    )
    this.stepInput.min = '.01'
    this.stepInput.max = '100'
    this.stepInput.className = 'gb-small-input'
    this.stepInput.addEventListener('change', () => {
      const n = this.stepInput.valueAsNumber
      if (Number.isFinite(n) && n >= 0.01 && n <= 100) this.changeView({ step: n })
      else {
        this.message('步长须为 0.01—100。')
        this.stepInput.value = String(this.state.view.step)
      }
    })
    this.radiusInput.value = '3'
    this.radiusInput.min = '.000001'
    this.radiusInput.max = '10000'
    this.radiusInput.className = 'gb-small-input'
    const color = field('新图形颜色', this.color, 'color')
    color.input.addEventListener('input', () => (this.color = color.input.value))
    this.controls.append(
      this.gridSelect,
      this.wrap('吸附步长', this.stepInput),
      this.wrap('作圆半径', this.radiusInput),
      color.label,
    )
    for (const [key, text] of [
      ['snap', '吸附'],
      ['axes', '坐标轴'],
      ['labels', '标签'],
    ] as const) {
      const label = element('label', 'gb-check'),
        input = element('input')
      input.type = 'checkbox'
      input.dataset.setting = key
      input.addEventListener('change', () => this.changeView({ [key]: input.checked }))
      label.append(input, document.createTextNode(text))
      this.controls.append(label)
    }
    const main = element('div', 'gb-layout'),
      left = element('div', 'gb-main'),
      frame = element('div', 'gb-canvas-frame'),
      aside = element('aside', 'gb-sidebar')
    this.canvas.append(
      svgElement('title', {}, '动态几何钉板。支持鼠标、触控、键盘选择工具。横纵轴等比例。'),
      this.canvasGroup,
    )
    this.canvas.classList.add('gb-canvas')
    this.status.setAttribute('role', 'status')
    this.status.setAttribute('aria-live', 'polite')
    frame.append(this.canvas)
    left.append(frame, this.measurement, this.status)
    aside.append(
      this.coordinateForm(),
      this.inspector,
      element('h5', '', '对象 · 可隐藏 / 锁定 / 编辑'),
      this.objects,
    )
    main.append(left, aside)
    this.root.append(
      title,
      this.toolbar,
      historyBar,
      this.controls,
      this.hint,
      main,
      this.fileInput,
    )
    host.replaceChildren(this.root)
    const opts = { signal: this.listener.signal }
    this.canvas.addEventListener('click', (e) => this.click(e), opts)
    this.canvas.addEventListener(
      'contextmenu',
      (e) => {
        e.preventDefault()
        if (!this.disabled && !this.drag) this.addPoint(this.position(e))
      },
      opts,
    )
    this.canvas.addEventListener('pointerdown', (e) => this.pointerDown(e), opts)
    this.canvas.addEventListener('pointermove', (e) => this.pointerMove(e), opts)
    this.canvas.addEventListener('pointerup', (e) => this.pointerEnd(e), opts)
    this.canvas.addEventListener('pointercancel', () => this.cancelDrag(), opts)
    this.canvas.addEventListener(
      'lostpointercapture',
      () => {
        if (this.drag) this.cancelDrag()
      },
      opts,
    )
    this.canvas.addEventListener('wheel', (e) => this.wheel(e), { ...opts, passive: false })
    this.root.addEventListener('keydown', (e) => this.key(e), opts)
    this.root.addEventListener(
      'keyup',
      (e) => {
        if (e.code === 'Space') this.space = false
      },
      opts,
    )
    this.root.addEventListener(
      'focusout',
      (e) => {
        if (!(e.relatedTarget instanceof Node) || !this.root.contains(e.relatedTarget))
          this.space = false
      },
      opts,
    )
    this.render()
  }
  private previousInput: GeoboardState | undefined
  get state(): GeoboardState {
    return this.preview ?? this.history.present
  }
  get snapshot(): GeoboardState {
    return structuredClone(this.history.present)
  }
  update(value: GeoboardState | undefined, disabled = false, legacy?: LegacyDrawing): void {
    this.legacy = legacy
    const next = value ?? emptyGeoboard()
    const cleared = value === undefined && this.previousInput !== undefined
    this.previousInput = value
    if (cleared || JSON.stringify(next) !== JSON.stringify(this.history.present)) {
      this.cancelDrag()
      this.history.reset(next)
      this.selected = []
      this.pending = []
      this.measured = []
    }
    if (disabled && !this.disabled) this.cancelDrag()
    this.disabled = disabled
    this.render()
  }
  destroy(): void {
    this.destroyed = true
    this.listener.abort()
    this.root.remove()
  }
  private button(text: string, action: () => void, mutates = true): HTMLButtonElement {
    const button = element('button', '', text)
    button.type = 'button'
    if (mutates) button.dataset.mutates = 'true'
    button.addEventListener('click', () => {
      if (this.disabled && mutates) return
      try {
        action()
      } catch (e) {
        this.error(e)
      }
    })
    return button
  }
  private wrap(text: string, input: HTMLElement): HTMLLabelElement {
    const label = element('label', 'gb-field')
    label.append(element('span', '', text), input)
    return label
  }
  private message(text: string): void {
    this.status.textContent = text
  }
  private error(e: unknown): void {
    this.message(e instanceof Error ? e.message : '操作未完成。')
  }
  private commit(next: GeoboardState): void {
    if (this.disabled) return
    try {
      if (this.history.commit(next)) this.onChange(this.history.present)
      this.preview = null
      this.render()
    } catch (e) {
      this.preview = null
      this.error(e)
      this.render()
    }
  }
  private changeView(update: Partial<GeoboardState['view']>): void {
    this.commit({ ...this.state, view: { ...this.state.view, ...update } })
  }
  private undo(): void {
    if (this.disabled || !this.history.canUndo) return
    this.cancelDrag()
    this.pending = []
    this.selected = []
    this.measured = []
    this.onChange(this.history.undo())
    this.render()
    this.message('已撤销本次钉板操作。')
  }
  private redo(): void {
    if (this.disabled || !this.history.canRedo) return
    this.cancelDrag()
    this.pending = []
    this.selected = []
    this.measured = []
    this.onChange(this.history.redo())
    this.render()
  }
  private pixel(p: BoardVec): BoardVec {
    const v = this.state.view
    return { x: WIDTH / 2 + (p.x - v.x) * v.scale, y: HEIGHT / 2 - (p.y - v.y) * v.scale }
  }
  private local(event: { clientX: number; clientY: number }): BoardVec {
    const matrix = this.canvas.getScreenCTM()
    if (!matrix) return { x: WIDTH / 2, y: HEIGHT / 2 }
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse())
    return { x: p.x, y: p.y }
  }
  private position(event: { clientX: number; clientY: number }, snap = true): BoardVec {
    const p = this.local(event),
      v = this.state.view,
      world = { x: (p.x - WIDTH / 2) / v.scale + v.x, y: -(p.y - HEIGHT / 2) / v.scale + v.y }
    return snap ? snapPosition(world, v) : world
  }
  private makePoint(p: BoardVec, label?: string): BoardPoint {
    const used = new Set(this.state.points.map((n) => n.label))
    let n = this.state.points.length
    let next: string
    do {
      next = n < 26 ? String.fromCharCode(65 + n) : `P${n + 1}`
      n++
    } while (used.has(next))
    return {
      id: this.uid(),
      ...boardStyle(label || next, this.color),
      kind: 'free',
      ...p,
      locked: false,
    }
  }
  private addPoint(p: BoardVec, label?: string): string {
    const point = this.makePoint(p, label)
    const next = appendNodes(this.state, [point])
    this.commit(next)
    return point.id
  }
  private hit(event: Event): string | undefined {
    return event.target instanceof Element
      ? (event.target.closest('[data-gb-id]')?.getAttribute('data-gb-id') ?? undefined)
      : undefined
  }
  private click(e: MouseEvent): void {
    if (this.suppressClick) {
      this.suppressClick = false
      return
    }
    if (this.disabled) return
    this.canvas.focus({ preventScroll: true })
    try {
      const id = this.hit(e),
        node = [...this.state.points, ...this.state.objects].find((n) => n.id === id)
      if (this.tool === 'move') {
        this.select(id, e.shiftKey)
        return
      }
      if (this.tool === 'pan') return
      if (this.tool === 'point') {
        if (node) this.select(id)
        else this.select(this.addPoint(this.position(e)))
        return
      }
      if (this.tool === 'on-object') {
        if (node && this.state.objects.some((n) => n.id === id))
          this.constrain(id!, this.position(e, false))
        else this.message('请点击一条线或一个圆。')
        return
      }
      if (this.tool === 'intersection') {
        if (node && this.state.objects.some((n) => n.id === id)) this.useObject(id!)
        else this.message('请选择两个已有线或圆。')
        return
      }
      if (node && this.state.objects.some((n) => n.id === id)) {
        this.useObject(id!)
        return
      }
      const pointId = id || this.addPoint(this.position(e))
      this.usePoint(pointId)
    } catch (error) {
      this.error(error)
    }
  }
  private select(id?: string, multi = false): void {
    if (!id) this.selected = []
    else if (multi)
      this.selected = this.selected.includes(id)
        ? this.selected.filter((n) => n !== id)
        : [...this.selected, id]
    else this.selected = [id]
    this.render()
  }
  private usePoint(id: string): void {
    if (this.tool === 'measure') {
      this.measured =
        this.measured.length >= 3
          ? [id]
          : this.measured.includes(id)
            ? this.measured
            : [...this.measured, id]
      this.render()
      return
    }
    if (this.tool === 'polygon' && this.pending.length >= 3 && id === this.pending[0]) {
      this.finishPolygon()
      return
    }
    if (this.pending.includes(id)) {
      this.message('请使用不同的点。')
      return
    }
    this.pending.push(id)
    const needed =
      this.tool === 'fixed-circle'
        ? 1
        : ['arc', 'circumcircle'].includes(this.tool)
          ? 3
          : ['circle', 'midpoint', 'line', 'segment', 'ray'].includes(this.tool)
            ? 2
            : Infinity
    if (this.pending.length === needed) {
      const [a, b, c] = this.pending,
        base = { id: this.uid(), ...boardStyle('', this.color) }
      let node: BoardNode | undefined
      if (this.tool === 'fixed-circle')
        node = { ...base, kind: 'fixed-circle', center: a, radius: this.radiusInput.valueAsNumber }
      else if (this.tool === 'midpoint') node = { ...base, label: 'M', kind: 'midpoint', a, b }
      else if (this.tool === 'circle') node = { ...base, kind: 'circle', center: a, through: b }
      else if (this.tool === 'circumcircle') node = { ...base, kind: 'circumcircle', a, b, c }
      else if (this.tool === 'arc') node = { ...base, kind: 'arc', center: a, start: b, end: c }
      else if (this.tool === 'line' || this.tool === 'segment' || this.tool === 'ray')
        node = { ...base, kind: this.tool, from: a, to: b }
      if (node) this.addConstruction([node])
    } else if (
      ['parallel', 'perpendicular', 'projection', 'reflection', 'tangent'].includes(this.tool)
    ) {
      this.pending = [id]
      this.message(`已选择点。接着点击${this.tool === 'tangent' ? '圆' : '直线、线段或射线'}。`)
    }
    this.render()
  }
  private addConstruction(nodes: BoardNode[]): void {
    this.pending = []
    const next = appendNodes(this.state, nodes),
      solved = solveGeoboard(next)
    const invalid = nodes.find((n) => solved.errors.has(n.id))
    if (invalid) {
      this.pending = []
      throw new Error(solved.errors.get(invalid.id))
    }
    this.pending = []
    this.selected = nodes.map((n) => n.id)
    this.commit(next)
    this.message('构造完成；拖动它的自由点可以验证关系。')
  }
  private finishPolygon(): void {
    if (this.pending.length < 3) {
      this.message('多边形至少需要三个顶点。')
      return
    }
    this.addConstruction([
      {
        id: this.uid(),
        ...boardStyle('', this.color),
        fill: true,
        kind: 'polygon',
        points: [...this.pending],
      },
    ])
  }
  private useObject(id: string): void {
    const resolved = solveGeoboard(this.state).values.get(id),
      base = () => ({ id: this.uid(), ...boardStyle('', this.color) })
    if (this.tool === 'intersection') {
      if (resolved?.type !== 'line' && resolved?.type !== 'circle')
        throw new Error('只支持直线、线段、射线与圆的交点。')
      if (!this.pending.length) {
        this.pending = [id]
        this.message('已选第一条线 / 圆，请选择第二条。')
        this.render()
        return
      }
      const first = this.pending[0]
      if (first === id) throw new Error('请选择另一个图形。')
      const a = solveGeoboard(this.state).values.get(first)
      if (a?.type !== 'line' && a?.type !== 'circle') throw new Error('第一条图形当前不可用。')
      const hits = intersections(a, resolved)
      this.pending = []
      if (!hits.length)
        throw new Error('当前没有唯一交点：图形可能相离、平行、重合，或交点在线段 / 射线外。')
      this.addConstruction(
        hits.map((_, index) => ({
          ...base(),
          label: `I${index + 1}`,
          kind: 'intersection',
          a: first,
          b: id,
          branch: index as 0 | 1,
        })),
      )
      return
    }
    const point = this.pending[0]
    if (!point) {
      this.message('先选择一个点，再点击参考直线或圆。')
      return
    }
    if (this.tool === 'tangent') {
      if (resolved?.type !== 'circle') throw new Error('请选择圆。')
      const nodes: BoardObject[] = [0, 1].map((branch) => ({
        ...base(),
        kind: 'tangent',
        point,
        circle: id,
        branch: branch as 0 | 1,
      }))
      const result = solveGeoboard(appendNodes(this.state, nodes)),
        valid = nodes.filter((n) => result.values.has(n.id))
      if (!valid.length) {
        this.pending = []
        throw new Error('圆内点不能作实切线。')
      }
      this.addConstruction(valid)
      return
    }
    if (resolved?.type !== 'line') throw new Error('请选择直线、线段或射线。')
    if (this.tool === 'parallel' || this.tool === 'perpendicular')
      this.addConstruction([{ ...base(), kind: this.tool, through: point, line: id }])
    else if (this.tool === 'projection' || this.tool === 'reflection')
      this.addConstruction([
        {
          ...base(),
          label: this.tool === 'projection' ? 'H' : 'P′',
          kind: this.tool,
          point,
          line: id,
        },
      ])
  }
  private constrain(object: string, target: BoardVec): void {
    const resolved = solveGeoboard(this.state).values.get(object)
    if (resolved?.type !== 'line' && resolved?.type !== 'circle')
      throw new Error('只能在线、线段、射线或圆上放约束点。')
    let parameter =
      resolved.type === 'circle'
        ? Math.atan2(target.y - resolved.center.y, target.x - resolved.center.x)
        : dot(sub(target, resolved.p), resolved.d)
    if (resolved.type === 'line')
      parameter = Number.isFinite(resolved.max)
        ? Math.max(0, Math.min(1, parameter / resolved.max))
        : Math.max(resolved.min, parameter)
    this.addConstruction([
      { id: this.uid(), ...boardStyle('Q', this.color), kind: 'on-object', object, parameter },
    ])
  }
  private pointerDown(e: PointerEvent): void {
    if (this.disabled || this.drag || (e.button !== 0 && e.button !== 1)) return
    const id = this.hit(e),
      p = this.state.points.find((n) => n.id === id),
      pan = this.tool === 'pan' || e.button === 1 || this.space
    if (
      !pan &&
      (this.tool !== 'move' || !p || (p.kind !== 'on-object' && (p.kind !== 'free' || p.locked)))
    )
      return
    e.preventDefault()
    this.canvas.focus({ preventScroll: true })
    this.suppressClick = false
    this.drag = {
      pointer: e.pointerId,
      id: pan ? undefined : id,
      from: this.position(e, false),
      start: this.local(e),
      before: this.history.present,
      moved: false,
    }
    if (id && !pan) this.selected = [id]
    this.canvas.setPointerCapture(e.pointerId)
  }
  private pointerMove(e: PointerEvent): void {
    const d = this.drag
    if (!d || d.pointer !== e.pointerId || this.disabled) return
    const local = this.local(e)
    if (distance(local, d.start) < 2 && !d.moved) return
    d.moved = true
    try {
      if (d.id) {
        const v = d.before.view,
          target = {
            x: (local.x - WIDTH / 2) / v.scale + v.x,
            y: -(local.y - HEIGHT / 2) / v.scale + v.y,
          }
        this.preview = movePoint(d.before, d.id, snapPosition(target, v))
      } else {
        const v = d.before.view
        this.preview = {
          ...d.before,
          view: {
            ...v,
            x: Math.max(-10000, Math.min(10000, v.x - (local.x - d.start.x) / v.scale)),
            y: Math.max(-10000, Math.min(10000, v.y + (local.y - d.start.y) / v.scale)),
          },
        }
      }
      this.renderCanvas()
      this.renderMeasurement()
    } catch (error) {
      this.error(error)
    }
  }
  private pointerEnd(e: PointerEvent): void {
    const d = this.drag
    if (!d || d.pointer !== e.pointerId) return
    const next = this.preview
    this.drag = null
    this.preview = null
    this.suppressClick = d.moved
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId)
    if (d.moved && next) this.commit(next)
    else this.render()
  }
  private cancelDrag(): void {
    const d = this.drag
    this.drag = null
    this.preview = null
    this.suppressClick = false
    if (d && this.canvas.hasPointerCapture(d.pointer)) this.canvas.releasePointerCapture(d.pointer)
    this.renderCanvas()
  }
  private wheel(e: WheelEvent): void {
    if (this.disabled || this.drag || e.ctrlKey || e.metaKey || e.altKey) return
    e.preventDefault()
    if (e.shiftKey) {
      const steps = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50, 100],
        current = this.state.view.step
      const next =
        e.deltaY > 0
          ? (steps.find((n) => n > current + 1e-9) ?? 100)
          : ([...steps].reverse().find((n) => n < current - 1e-9) ?? 0.01)
      this.changeView({ step: next })
      return
    }
    const local = this.local(e),
      before = this.position(e, false),
      view = this.state.view,
      scale = Math.max(8, Math.min(160, view.scale * Math.exp(-e.deltaY * 0.001)))
    this.changeView({
      scale,
      x: Math.max(-10000, Math.min(10000, before.x - (local.x - WIDTH / 2) / scale)),
      y: Math.max(-10000, Math.min(10000, before.y + (local.y - HEIGHT / 2) / scale)),
    })
  }
  private key(e: KeyboardEvent): void {
    if (e.isComposing || e.repeat) return
    if (
      e.target instanceof Element &&
      e.target.closest('input,textarea,select,[contenteditable="true"]')
    )
      return
    if (this.disabled) return
    if (e.code === 'Space') {
      e.preventDefault()
      this.space = true
    }
    if (e.key === 'Escape') {
      this.cancelDrag()
      this.pending = []
      this.measured = []
      this.render()
      this.message('已取消连选。已创建的点保留，可撤销。')
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      e.shiftKey ? this.redo() : this.undo()
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault()
      this.redo()
    } else if (e.key === 'Enter' && this.tool === 'polygon') {
      e.preventDefault()
      try {
        this.finishPolygon()
      } catch (error) {
        this.error(error)
      }
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (this.selected.length) {
        e.preventDefault()
        this.deleteSelected()
      }
    } else if (e.key.toLowerCase() === 'i' && !e.ctrlKey && !e.metaKey)
      this.changeView({ labels: !this.state.view.labels })
  }
  private deleteSelected(): void {
    const before = this.state.points.length + this.state.objects.length,
      next = removeNodes(this.state, this.selected),
      removed = before - next.points.length - next.objects.length
    if (
      removed > this.selected.length &&
      !window.confirm(`删除这些元素也会删除依赖它们的构造，共 ${removed} 项。可以撤销。继续？`)
    )
      return
    this.selected = []
    this.pending = []
    this.commit(next)
  }
  private coordinateForm(): HTMLElement {
    const box = element('details', 'gb-details')
    box.append(element('summary', '', '精确坐标输入'))
    const x = field('新点 x', '0'),
      y = field('新点 y', '0'),
      label = field('新点名称', '', 'text')
    label.input.maxLength = 80
    const button = this.button('添加坐标点', () =>
      this.select(
        this.addPoint({ x: x.input.valueAsNumber, y: y.input.valueAsNumber }, label.input.value),
      ),
    )
    box.append(x.label, y.label, label.label, button)
    return box
  }
  private copyLegacy(): void {
    if (!this.legacy?.points.length) {
      this.message('旧数学画布尚无点。')
      return
    }
    const ids = new Map<string, string>(),
      nodes: BoardNode[] = []
    for (const p of this.legacy.points) {
      const id = this.uid()
      ids.set(p.id, id)
      nodes.push({
        id,
        ...boardStyle(p.label, this.color),
        kind: 'free',
        x: p.x,
        y: p.y,
        locked: false,
      })
    }
    for (const line of this.legacy.lines) {
      const from = ids.get(line.from),
        to = ids.get(line.to)
      if (from && to && from !== to)
        nodes.push({ id: this.uid(), ...boardStyle('', this.color), kind: 'segment', from, to })
    }
    this.commit(appendNodes(this.state, nodes))
    this.message('已复制旧画布的点线；原图、函数和历史提交均未修改。')
  }
  private render(): void {
    const ids = new Set([...this.state.points, ...this.state.objects].map((n) => n.id))
    this.selected = this.selected.filter((n) => ids.has(n))
    this.pending = this.pending.filter((n) => ids.has(n))
    this.measured = this.measured.filter((n) => ids.has(n))
    this.counts.textContent = `${this.state.points.length}/200 点 · ${this.state.objects.length}/300 图形`
    for (const button of this.toolbar.querySelectorAll<HTMLButtonElement>('button'))
      button.setAttribute('aria-pressed', String(button.dataset.tool === this.tool))
    this.hint.textContent = `${tools.find((t) => t[0] === this.tool)?.[2]}${this.pending.length ? ` 已选 ${this.pending.length} 项。` : ''} 滚轮缩放；Shift+滚轮调精度；空格拖动平移；I 隐藏标签。`
    this.gridSelect.value = this.state.view.grid
    this.stepInput.value = String(this.state.view.step)
    for (const input of this.controls.querySelectorAll<HTMLInputElement>('[data-setting]'))
      input.checked = this.state.view[input.dataset.setting as 'snap' | 'axes' | 'labels']
    this.renderCanvas()
    this.renderMeasurement()
    this.renderInspector()
    this.renderObjects()
    for (const input of this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
      'input,select',
    ))
      input.disabled = this.disabled
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('button[data-mutates]'))
      button.disabled = this.disabled
    this.root.querySelector<HTMLButtonElement>('[data-action="undo"]')!.disabled =
      this.disabled || !this.history.canUndo
    this.root.querySelector<HTMLButtonElement>('[data-action="redo"]')!.disabled =
      this.disabled || !this.history.canRedo
    this.root.querySelector<HTMLButtonElement>('[data-action="legacy"]')!.disabled =
      this.disabled || !this.legacy?.points.length
    this.canvas.setAttribute('aria-disabled', String(this.disabled))
  }
  private bounds(): { left: number; right: number; bottom: number; top: number } {
    const v = this.state.view
    return {
      left: v.x - WIDTH / 2 / v.scale,
      right: v.x + WIDTH / 2 / v.scale,
      bottom: v.y - HEIGHT / 2 / v.scale,
      top: v.y + HEIGHT / 2 / v.scale,
    }
  }
  private renderGrid(group: SVGGElement): void {
    const v = this.state.view,
      b = this.bounds(),
      factor = Math.max(1, Math.ceil(16 / (v.step * v.scale))),
      s = v.step * factor
    group.append(svgElement('rect', { width: WIDTH, height: HEIGHT, fill: '#111b2b' }))
    const peg = (p: BoardVec) => {
      const q = this.pixel(p)
      if (q.x >= 0 && q.x <= WIDTH && q.y >= 0 && q.y <= HEIGHT)
        group.append(svgElement('circle', { cx: q.x, cy: q.y, r: 1.6, fill: '#435269' }))
    }
    if (v.grid === 'square') {
      for (let x = Math.ceil(b.left / s) * s; x <= b.right; x += s)
        for (let y = Math.ceil(b.bottom / s) * s; y <= b.top; y += s) peg({ x, y })
    } else if (v.grid === 'isometric') {
      const dy = (s * Math.sqrt(3)) / 2
      for (let row = Math.ceil(b.bottom / dy); row * dy <= b.top; row++) {
        for (let col = Math.ceil(b.left / s - row / 2); (col + row / 2) * s <= b.right; col++)
          peg({ x: (col + row / 2) * s, y: row * dy })
      }
    } else if (v.grid === 'circular') {
      const max = Math.max(
        Math.hypot(b.left, b.bottom),
        Math.hypot(b.right, b.top),
        Math.hypot(b.left, b.top),
        Math.hypot(b.right, b.bottom),
      )
      const min = Math.hypot(
        b.left > 0 ? b.left : b.right < 0 ? b.right : 0,
        b.bottom > 0 ? b.bottom : b.top < 0 ? b.top : 0,
      )
      for (let r = Math.max(0, Math.floor(min / s) * s); r <= max; r += s)
        for (let a = 0; a < 12; a++)
          peg({ x: r * Math.cos((a * Math.PI) / 6), y: r * Math.sin((a * Math.PI) / 6) })
    }
    if (v.axes) {
      const origin = this.pixel({ x: 0, y: 0 })
      group.append(
        svgElement('line', {
          x1: 0,
          y1: origin.y,
          x2: WIDTH,
          y2: origin.y,
          stroke: '#9bacbd',
          'stroke-width': 1,
        }),
        svgElement('line', {
          x1: origin.x,
          y1: 0,
          x2: origin.x,
          y2: HEIGHT,
          stroke: '#9bacbd',
          'stroke-width': 1,
        }),
      )
      const step = Math.max(s, 10 ** Math.floor(Math.log10(70 / v.scale)))
      for (let x = Math.ceil(b.left / step) * step; x <= b.right; x += step)
        if (Math.abs(x) > 1e-8) {
          const p = this.pixel({ x, y: 0 })
          group.append(
            svgElement(
              'text',
              {
                x: p.x + 3,
                y: Math.min(HEIGHT - 10, Math.max(18, p.y + 17)),
                fill: '#9bacbd',
                'font-size': 11,
              },
              fmt(x),
            ),
          )
        }
      for (let y = Math.ceil(b.bottom / step) * step; y <= b.top; y += step)
        if (Math.abs(y) > 1e-8) {
          const p = this.pixel({ x: 0, y })
          group.append(
            svgElement(
              'text',
              {
                x: Math.min(WIDTH - 45, Math.max(4, p.x + 7)),
                y: p.y - 4,
                fill: '#9bacbd',
                'font-size': 11,
              },
              fmt(y),
            ),
          )
        }
    }
    if (factor > 1 && v.grid !== 'none')
      group.append(
        svgElement(
          'text',
          { x: 12, y: HEIGHT - 12, fill: '#a9bbca', 'font-size': 12 },
          `网格显示已抽稀，吸附仍按 ${fmt(v.step)} 单位`,
        ),
      )
  }
  private shape(node: BoardNode, r: Resolved, group: SVGGElement): void {
    if (!node.visible) return
    const selected =
      this.selected.includes(node.id) ||
      this.pending.includes(node.id) ||
      this.measured.includes(node.id)
    const color = node.color,
      attrs: Record<string, string | number> = {
        stroke: color,
        'stroke-width': selected ? 3.5 : 2,
        fill: node.fill ? color : 'none',
        'fill-opacity': node.fill ? 0.18 : 1,
        'data-gb-id': node.id,
        'vector-effect': 'non-scaling-stroke',
      }
    let shape: SVGElement, anchor: BoardVec | undefined
    if (r.type === 'point') {
      const p = this.pixel(r.p)
      if (p.x < -100 || p.x > WIDTH + 100 || p.y < -100 || p.y > HEIGHT + 100) return
      shape = svgElement('circle', {
        ...attrs,
        cx: p.x,
        cy: p.y,
        r: selected ? 6.5 : 5,
        fill: node.kind === 'free' ? color : '#111b2b',
        'fill-opacity': 1,
      })
      anchor = { x: p.x + 10, y: p.y - 10 }
      const hit = svgElement('circle', {
        cx: p.x,
        cy: p.y,
        r: 12,
        fill: 'transparent',
        'data-gb-id': node.id,
        class: 'gb-hit',
      })
      group.append(hit)
      if (node.kind === 'free' && node.locked)
        group.append(
          svgElement('rect', {
            x: p.x - 8,
            y: p.y - 8,
            width: 16,
            height: 16,
            fill: 'none',
            stroke: color,
            'stroke-dasharray': '2 2',
            'pointer-events': 'none',
          }),
        )
    } else if (r.type === 'line') {
      const ends = clipLine(r, this.bounds())
      if (!ends) return
      const a = this.pixel(ends[0]),
        b = this.pixel(ends[1])
      shape = svgElement('line', { ...attrs, x1: a.x, y1: a.y, x2: b.x, y2: b.y })
      anchor = { x: (a.x + b.x) / 2 + 8, y: (a.y + b.y) / 2 - 8 }
    } else if (r.type === 'circle') {
      const c = this.pixel(r.center)
      shape = svgElement('circle', {
        ...attrs,
        cx: c.x,
        cy: c.y,
        r: r.radius * this.state.view.scale,
      })
      anchor = {
        x: c.x + (r.radius * this.state.view.scale) / Math.sqrt(2),
        y: c.y - (r.radius * this.state.view.scale) / Math.sqrt(2),
      }
    } else if (r.type === 'polygon') {
      const ps = r.points.map((p) => this.pixel(p))
      shape = svgElement('polygon', { ...attrs, points: ps.map((p) => `${p.x},${p.y}`).join(' ') })
      anchor = mul(ps.reduce(add, { x: 0, y: 0 }), 1 / ps.length)
    } else {
      const p = this.pixel(
        add(r.center, mul({ x: Math.cos(r.start), y: Math.sin(r.start) }, r.radius)),
      )
      const q = this.pixel(
        add(
          r.center,
          mul({ x: Math.cos(r.start + r.sweep), y: Math.sin(r.start + r.sweep) }, r.radius),
        ),
      )
      const radius = r.radius * this.state.view.scale
      shape = svgElement('path', {
        ...attrs,
        fill: 'none',
        d: `M ${p.x} ${p.y} A ${radius} ${radius} 0 ${r.sweep > Math.PI ? 1 : 0} 0 ${q.x} ${q.y}`,
      })
      anchor = q
    }
    if (r.type !== 'point') {
      const hit = shape.cloneNode() as SVGElement
      hit.setAttribute('stroke', 'transparent')
      hit.setAttribute('stroke-width', '14')
      hit.setAttribute('fill', 'none')
      hit.classList.add('gb-hit')
      group.append(hit)
    }
    shape.classList.add('gb-shape')
    group.append(shape)
    if (this.state.view.labels && node.label && anchor)
      group.append(
        svgElement(
          'text',
          {
            x: anchor.x,
            y: anchor.y,
            fill: color,
            'font-size': 13,
            'pointer-events': 'none',
            'paint-order': 'stroke',
            stroke: '#111b2b',
            'stroke-width': 3,
          },
          node.label,
        ),
      )
  }
  private renderCanvas(): void {
    if (this.destroyed) return
    const content = svgElement('g'),
      result = solveGeoboard(this.state)
    this.renderGrid(content)
    for (const n of [...this.state.objects, ...this.state.points]) {
      const r = result.values.get(n.id)
      if (r) this.shape(n, r, content)
    }
    this.canvasGroup.replaceChildren(content)
  }
  private renderMeasurement(): void {
    const result = solveGeoboard(this.state),
      ps = this.measured
        .map((id) => result.values.get(id))
        .filter((n): n is Extract<Resolved, { type: 'point' }> => n?.type === 'point')
    let message = '坐标、距离与面积为浮点近似，用于观察，不作为答案判分。'
    if (ps.length === 2)
      message = `两点距离 = ${fmt(distance(ps[0].p, ps[1].p))}；再选一点测角（第二点为顶点）。`
    if (ps.length === 3) {
      const angle = angleDegrees(ps[0].p, ps[1].p, ps[2].p)
      message =
        angle === null
          ? '有重合点，角未定义。'
          : `∠ABC = ${fmt(angle)}°；AB = ${fmt(distance(ps[0].p, ps[1].p))}；BC = ${fmt(distance(ps[1].p, ps[2].p))}`
    }
    if (result.errors.size)
      message += ` 当前 ${result.errors.size} 项构造暂不可用，已隐藏；恢复有效位置后自动出现。`
    this.measurement.textContent = message
  }
  private describe(r: Resolved): string {
    if (r.type === 'point')
      return `坐标 (${fmt(r.p.x)}, ${fmt(r.p.y)})；到 x 轴 ${fmt(Math.abs(r.p.y))}；到 y 轴 ${fmt(Math.abs(r.p.x))}`
    if (r.type === 'line') {
      const a = -r.d.y,
        b = r.d.x,
        c = r.d.y * r.p.x - r.d.x * r.p.y
      return `所在直线：${fmt(a)}x + (${fmt(b)})y + (${fmt(c)}) = 0${Number.isFinite(r.max) ? `；线段长 ${fmt(r.max)}` : ''}`
    }
    if (r.type === 'circle')
      return `圆心 (${fmt(r.center.x)}, ${fmt(r.center.y)})；r = ${fmt(r.radius)}；(x − (${fmt(r.center.x)}))² + (y − (${fmt(r.center.y)}))² = ${fmt(r.radius ** 2)}；周长 ${fmt(2 * Math.PI * r.radius)}；面积 ${fmt(Math.PI * r.radius ** 2)}`
    if (r.type === 'arc')
      return `半径 ${fmt(r.radius)}；逆时针圆心角 ${fmt((r.sweep * 180) / Math.PI)}°；弧长 ${fmt(r.sweep * r.radius)}（第三点仅定方向）`
    const m = polygonMetrics(r.points)
    return `${m.simple ? `面积 ${fmt(m.area!)}` : '自交 / 重合边：不报告普通多边形面积'}；周长 ${fmt(m.perimeter)}`
  }
  private renderInspector(): void {
    this.inspector.replaceChildren()
    const n = [...this.state.points, ...this.state.objects].find((n) => n.id === this.selected[0])
    if (!n) {
      this.inspector.append(element('p', 'gb-muted', '选择对象后编辑属性或查看测量结果。'))
      return
    }
    const solved = solveGeoboard(this.state),
      result = solved.values.get(n.id)
    this.inspector.append(
      element(
        'h5',
        '',
        `${names[n.kind]}${this.selected.length > 1 ? ` · 已选 ${this.selected.length} 项` : ''}`,
      ),
      element('p', 'gb-equation', result ? this.describe(result) : solved.errors.get(n.id)),
    )
    const label = field('对象名称', n.label, 'text')
    label.input.maxLength = 80
    label.input.addEventListener('change', () =>
      this.updateNode(n.id, { label: label.input.value }),
    )
    const color = field('对象颜色', n.color, 'color')
    color.input.addEventListener('change', () =>
      this.updateNode(n.id, { color: color.input.value }),
    )
    this.inspector.append(label.label, color.label)
    for (const [key, text] of [
      ['visible', '显示对象'],
      ['fill', '填充图形'],
    ] as const) {
      const outer = element('label', 'gb-check'),
        input = element('input')
      input.type = 'checkbox'
      input.checked = n[key]
      input.setAttribute('aria-label', text)
      input.addEventListener('change', () => this.updateNode(n.id, { [key]: input.checked }))
      outer.append(input, document.createTextNode(text))
      this.inspector.append(outer)
    }
    if (n.kind === 'free') {
      const x = field('所选点 x', String(n.x)),
        y = field('所选点 y', String(n.y))
      const apply = this.button('更新点坐标', () =>
        this.commit(
          movePoint(this.state, n.id, { x: x.input.valueAsNumber, y: y.input.valueAsNumber }),
        ),
      )
      const lock = this.button(n.locked ? '解锁点' : '锁定点', () =>
        this.updateNode(n.id, { locked: !n.locked }),
      )
      this.inspector.append(x.label, y.label, apply, lock)
    } else if (n.kind === 'fixed-circle') {
      const r = field('所选圆半径', String(n.radius))
      r.input.min = '.000001'
      r.input.max = '10000'
      r.input.addEventListener('change', () =>
        this.updateNode(n.id, { radius: r.input.valueAsNumber }),
      )
      this.inspector.append(r.label)
    }
    this.inspector.append(
      this.button(
        `删除选中${this.selected.length > 1 ? ` ${this.selected.length} 项` : '对象'}`,
        () => this.deleteSelected(),
      ),
    )
    if (result) this.inspector.append(this.transformForm(n.id))
  }
  private updateNode(id: string, patch: Record<string, unknown>): void {
    const next = {
      ...this.state,
      points: this.state.points.map((n) => (n.id === id ? ({ ...n, ...patch } as BoardPoint) : n)),
      objects: this.state.objects.map((n) =>
        n.id === id ? ({ ...n, ...patch } as BoardObject) : n,
      ),
    }
    this.commit(next)
  }
  private transformForm(id: string): HTMLElement {
    const details = element('details', 'gb-details')
    details.append(element('summary', '', '复制 / 平移 / 旋转 / 缩放 / 镜像'))
    details.append(
      element(
        'p',
        'gb-muted',
        '创建独立副本，不改变原图。镜像以过变换中心的竖直线为轴；之后再旋转、缩放、平移。',
      ),
    )
    const fields = [
      ['dx', '平移 x', '0'],
      ['dy', '平移 y', '0'],
      ['angle', '旋转角度 °', '0'],
      ['scale', '缩放倍数', '1'],
      ['px', '变换中心 x', '0'],
      ['py', '变换中心 y', '0'],
    ].map(([key, name, value]) => ({ key, ...field(name, value) }))
    for (const f of fields) details.append(f.label)
    const reflect = element('input')
    reflect.type = 'checkbox'
    reflect.setAttribute('aria-label', '镜像副本')
    details.append(this.wrap('镜像副本', reflect))
    details.append(
      this.button('生成变换副本', () => {
        const v = Object.fromEntries(fields.map((f) => [f.key, f.input.valueAsNumber]))
        this.commit(
          transformedCopy(
            this.state,
            id,
            {
              dx: v.dx,
              dy: v.dy,
              angle: v.angle,
              scale: v.scale,
              pivot: { x: v.px, y: v.py },
              reflect: reflect.checked,
            },
            this.uid,
          ),
        )
      }),
    )
    return details
  }
  private renderObjects(): void {
    const solved = solveGeoboard(this.state)
    this.objects.replaceChildren()
    for (const [index, n] of [...this.state.points, ...this.state.objects].entries()) {
      const row = element('div', 'gb-object-row'),
        button = this.button(
          `${n.label || `${names[n.kind]} ${index + 1}`}${solved.errors.has(n.id) ? ' ⚠' : ''}`,
          () => {
            if (this.disabled || this.tool === 'move' || this.tool === 'pan') this.select(n.id)
            else if (this.state.points.some((p) => p.id === n.id)) this.usePoint(n.id)
            else this.useObject(n.id)
          },
          false,
        )
      button.dataset.objectId = n.id
      button.setAttribute('aria-pressed', String(this.selected.includes(n.id)))
      button.title = solved.errors.get(n.id) || names[n.kind]
      const show = this.button(n.visible ? '隐藏' : '显示', () =>
        this.updateNode(n.id, { visible: !n.visible }),
      )
      show.setAttribute('aria-label', `${n.visible ? '隐藏' : '显示'} ${n.label || names[n.kind]}`)
      row.append(button, show)
      this.objects.append(row)
    }
  }
  private download(name: string, content: string, mime: string): void {
    const url = URL.createObjectURL(new Blob([content], { type: mime })),
      anchor = element('a')
    anchor.href = url
    anchor.download = name
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  private exportSvg(): void {
    const clone = this.canvas.cloneNode(true) as SVGSVGElement
    clone.setAttribute('xmlns', NS)
    clone.setAttribute('width', String(WIDTH))
    clone.setAttribute('height', String(HEIGHT))
    clone.removeAttribute('tabindex')
    clone.removeAttribute('class')
    clone.querySelectorAll('.gb-hit').forEach((n) => n.remove())
    clone.querySelectorAll('[data-gb-id]').forEach((n) => n.removeAttribute('data-gb-id'))
    this.download(
      'examcraft-geoboard.svg',
      new XMLSerializer().serializeToString(clone),
      'image/svg+xml',
    )
  }
}
