import type {
  AnswerDraft,
  ArgumentContainerKind,
  ArgumentDocument,
  ArgumentKind,
  ArgumentNode,
} from '../shared/types'

export const MAX_ARGUMENT_NODES = 80
export const MAX_ARGUMENT_DEPTH = 6
export const MAX_ARGUMENT_TEXT_LENGTH = 4000
export const MAX_ARGUMENT_GENERATED_LENGTH = 20000
export const argumentContainerKinds = ['cause', 'contrast', 'point'] as const
export const argumentKinds = [
  'principle',
  'material',
  'analysis',
  'conclusion',
  ...argumentContainerKinds,
] as const

export function isArgumentContainer(kind: ArgumentKind): kind is ArgumentContainerKind {
  return (argumentContainerKinds as readonly string[]).includes(kind)
}

const containerLabels: Record<ArgumentContainerKind, string> = {
  cause: '因果关系',
  contrast: '对比分析',
  point: '分点论述',
}

/** Called only after the iterative guard, so recursive rendering is always bounded. */
function renderRoots(roots: ArgumentNode[]): string {
  const render = (node: ArgumentNode, depth: number): string => {
    const text = node.text.trim()
    const children = node.children.map((child) => render(child, depth + 1)).filter(Boolean)
    if (!isArgumentContainer(node.kind)) return text
    // An empty container must never manufacture an apparent answer.
    if (!text && !children.length) return ''
    const heading = `${containerLabels[node.kind]}${text ? `：${text}` : '：'}`
    return [
      heading,
      ...children.map(
        (child, index) =>
          `${'  '.repeat(depth)}${index + 1}. ${child.replace(/\n/g, `\n${'  '.repeat(depth)}`)}`,
      ),
    ].join('\n')
  }
  return roots
    .map((node) => render(node, 1))
    .filter(Boolean)
    .join('\n\n')
}

/**
 * Validate object identity before any recursive parser, clone, or renderer runs.
 * Rejects cycles AND repeated objects/arrays; IDs are globally unique in the tree.
 */
export function assertArgumentRoots(input: unknown): asserts input is ArgumentNode[] {
  if (!Array.isArray(input)) throw new Error('论证模块必须是数组')
  if (input.length > MAX_ARGUMENT_NODES) throw new Error('论证模块最多 80 个')
  const seen = new Set<object>([input])
  const ids = new Set<string>()
  const stack: { value: unknown; depth: number }[] = input.map((value) => ({ value, depth: 1 }))
  let count = 0
  let textLength = 0
  while (stack.length) {
    const { value, depth } = stack.pop()!
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('论证模块格式无效')
    if (seen.has(value)) throw new Error('论证模块不能包含循环或共享节点')
    seen.add(value)
    if (++count > MAX_ARGUMENT_NODES) throw new Error('论证模块最多 80 个')
    if (depth > MAX_ARGUMENT_DEPTH) throw new Error('论证模块最多嵌套 6 层')
    const node = value as Record<string, unknown>
    if (Object.keys(node).some((key) => !['id', 'kind', 'text', 'children'].includes(key)))
      throw new Error('论证模块包含未知字段')
    if (
      typeof node.id !== 'string' ||
      node.id.length > 80 ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(node.id) ||
      ['__proto__', 'prototype', 'constructor'].includes(node.id)
    )
      throw new Error('论证模块 ID 无效')
    if (ids.has(node.id)) throw new Error('论证模块 ID 必须唯一')
    ids.add(node.id)
    if (!(argumentKinds as readonly unknown[]).includes(node.kind))
      throw new Error('论证模块类型无效')
    if (typeof node.text !== 'string' || node.text.length > MAX_ARGUMENT_TEXT_LENGTH)
      throw new Error('每个论证模块的文字最多 4000 字')
    if ((textLength += node.text.trim().length) > MAX_ARGUMENT_GENERATED_LENGTH)
      throw new Error('生成的答案最多 20000 字')
    if (!Array.isArray(node.children)) throw new Error('论证模块的子模块必须是数组')
    if (seen.has(node.children)) throw new Error('论证模块不能包含循环或共享节点')
    seen.add(node.children)
    if (!isArgumentContainer(node.kind as ArgumentKind) && node.children.length)
      throw new Error('只有因果、对比、分点容器可以嵌套子模块')
    if (node.children.length > MAX_ARGUMENT_NODES) throw new Error('论证模块最多 80 个')
    for (const child of node.children) stack.push({ value: child, depth: depth + 1 })
  }
  if (renderRoots(input as ArgumentNode[]).length > MAX_ARGUMENT_GENERATED_LENGTH)
    throw new Error('生成的答案最多 20000 字')
}

function cloneRoots(roots: ArgumentNode[]): ArgumentNode[] {
  return roots.map((node) => ({ ...node, children: cloneRoots(node.children) }))
}

export function generateArgumentText(roots: ArgumentNode[]): string {
  assertArgumentRoots(roots)
  return renderRoots(roots)
}

/** Preserve legacy records on disk; migrate a copy only when the editor needs a tree. */
export function argumentFromDraft(draft: AnswerDraft): ArgumentDocument {
  if (draft.argument) {
    if (draft.argument.version !== 1) throw new Error('论证模块版本不受支持')
    assertArgumentRoots(draft.argument.roots)
    return { version: 1, roots: cloneRoots(draft.argument.roots) }
  }
  const roots: ArgumentNode[] = draft.blocks.map((block) => ({
    id: block.id,
    kind: block.category,
    text: block.text,
    children: [],
  }))
  // Keep free-form final text independent; only pre-existing blocks become nodes.
  assertArgumentRoots(roots)
  return { version: 1, roots }
}

/** New structured drafts have an explicit, editable final answer. Ignore stale legacy blocks. */
export function finalAnswerText(draft: AnswerDraft): string {
  return draft.argument
    ? draft.text
    : [draft.text, ...draft.blocks.map((block) => block.text)].filter(Boolean).join('\n')
}

interface NodeLocation {
  node: ArgumentNode
  siblings: ArgumentNode[]
  index: number
}
function locate(roots: ArgumentNode[], id: string): NodeLocation | undefined {
  for (let index = 0; index < roots.length; index++) {
    const node = roots[index]
    if (node.id === id) return { node, siblings: roots, index }
    const nested = locate(node.children, id)
    if (nested) return nested
  }
}
function targetChildren(roots: ArgumentNode[], parentId: string | null): ArgumentNode[] {
  if (parentId === null) return roots
  const parent = locate(roots, parentId)?.node
  if (!parent) throw new Error('找不到目标容器')
  if (!isArgumentContainer(parent.kind)) throw new Error('只能放入因果、对比或分点容器')
  return parent.children
}
function checkIndex(children: ArgumentNode[], index: number): void {
  if (!Number.isInteger(index) || index < 0 || index > children.length)
    throw new Error('目标位置无效')
}

/** Index addresses a target socket BEFORE source removal, including the socket after its last child. */
export function moveArgumentNode(
  roots: ArgumentNode[],
  id: string,
  parentId: string | null,
  index: number,
): ArgumentNode[] {
  assertArgumentRoots(roots)
  const next = cloneRoots(roots)
  const source = locate(next, id)
  if (!source) throw new Error('找不到要移动的模块')
  if (id === parentId || (parentId !== null && locate(source.node.children, parentId)))
    throw new Error('不能把模块移入自身或其子模块')
  const target = targetChildren(next, parentId)
  checkIndex(target, index)
  const adjustedIndex = target === source.siblings && source.index < index ? index - 1 : index
  source.siblings.splice(source.index, 1)
  target.splice(adjustedIndex, 0, source.node)
  assertArgumentRoots(next)
  return next
}

/** Remove a whole subtree. The original tree and its children remain unchanged. */
export function removeArgumentNode(roots: ArgumentNode[], id: string): ArgumentNode[] {
  assertArgumentRoots(roots)
  const next = cloneRoots(roots)
  const source = locate(next, id)
  if (!source) throw new Error('找不到要删除的模块')
  source.siblings.splice(source.index, 1)
  return next
}

export function insertArgumentNode(
  roots: ArgumentNode[],
  node: ArgumentNode,
  parentId: string | null,
  index: number,
): ArgumentNode[] {
  assertArgumentRoots(roots)
  assertArgumentRoots([node])
  const next = cloneRoots(roots)
  const target = targetChildren(next, parentId)
  checkIndex(target, index)
  target.splice(index, 0, cloneRoots([node])[0])
  assertArgumentRoots(next)
  return next
}
