import type {
  ArgumentCanvas,
  ArgumentDocument,
  ArgumentGroup,
  ArgumentNode,
  ArgumentPosition,
} from '../shared/types'
import {
  argumentCanvas,
  assertArgumentRoots,
  flattenArgument,
  insertArgumentNode,
  removeArgumentNode,
} from './argument'

export const ARGUMENT_CARD_WIDTH = 224
export const ARGUMENT_CARD_HEIGHT = 130
export const ARGUMENT_GROUP_GAP = 6
export const ARGUMENT_SNAP_DISTANCE = 18
export type ArgumentEntity = { type: 'node' | 'group'; id: string }
export interface ArgumentBounds extends ArgumentPosition {
  width: number
  height: number
}
const validId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value) &&
  !['__proto__', 'prototype', 'constructor'].includes(value)

/** Persisted grouping is explicit, flat structure, never inferred from coordinates. */
export function assertArgumentGroups(
  value: unknown,
  roots: ArgumentNode[],
  partial = false,
): asserts value is ArgumentGroup[] {
  if (value === undefined) return
  assertArgumentRoots(roots)
  if (!Array.isArray(value) || value.length > 40) throw new Error('大模块最多 40 个')
  const nodeIds = new Set(flattenArgument(roots).map(({ node }) => node.id))
  const ids = new Set<string>(),
    members = new Set<string>()
  for (const group of value) {
    if (
      !group ||
      typeof group !== 'object' ||
      Array.isArray(group) ||
      Object.keys(group).some(
        (key) => !['id', 'label', 'memberIds', ...(partial ? ['partial'] : [])].includes(key),
      ) ||
      !validId(group.id) ||
      ids.has(group.id) ||
      nodeIds.has(group.id) ||
      typeof group.label !== 'string' ||
      group.label.length > 120 ||
      !Array.isArray(group.memberIds) ||
      group.memberIds.length < (partial ? 1 : 2) ||
      group.memberIds.length > 80 ||
      (partial && typeof group.partial !== 'boolean') ||
      (partial && !group.partial && group.memberIds.length < 2)
    )
      throw new Error('大模块格式、编号或成员无效')
    ids.add(group.id)
    for (const id of group.memberIds) {
      if (!validId(id) || !nodeIds.has(id) || members.has(id))
        throw new Error('大模块成员必须是唯一的已有小模块，不能嵌套大模块')
      members.add(id)
    }
  }
}

export function argumentGroupFor(
  document: ArgumentDocument,
  nodeId: string,
): ArgumentGroup | undefined {
  return document.groups?.find((group) => group.memberIds.includes(nodeId))
}

/** Used after intentional removals, not to silently accept corrupt persisted input. */
export function pruneArgumentGroups(document: ArgumentDocument): ArgumentDocument {
  const ids = new Set(flattenArgument(document.roots).map(({ node }) => node.id))
  if (!document.groups) return document
  return {
    ...document,
    groups: document.groups
      .map((group) => ({ ...group, memberIds: group.memberIds.filter((id) => ids.has(id)) }))
      .filter((group) => group.memberIds.length > 1),
  }
}

export function argumentGroupBounds(group: ArgumentGroup, canvas: ArgumentCanvas): ArgumentBounds {
  const points = group.memberIds.map((id) => canvas.positions[id])
  if (!points.length || points.some((point) => !point)) throw new Error('找不到大模块成员位置')
  const x = Math.min(...points.map((p) => p.x)) - 8
  const y = Math.min(...points.map((p) => p.y)) - 40
  return {
    x,
    y,
    width: Math.max(...points.map((p) => p.x)) + ARGUMENT_CARD_WIDTH + 8 - x,
    height: Math.max(...points.map((p) => p.y)) + ARGUMENT_CARD_HEIGHT + 8 - y,
  }
}

export function argumentEntityMembers(
  document: ArgumentDocument,
  entity: ArgumentEntity,
): string[] {
  if (entity.type === 'group') {
    const group = document.groups?.find((group) => group.id === entity.id)
    if (!group) throw new Error('找不到大模块')
    return [...group.memberIds]
  }
  if (!flattenArgument(document.roots).some(({ node }) => node.id === entity.id))
    throw new Error('找不到小模块')
  return [entity.id]
}

function entityBounds(
  document: ArgumentDocument,
  entity: ArgumentEntity,
  canvas: ArgumentCanvas,
): ArgumentBounds {
  return entity.type === 'group'
    ? argumentGroupBounds(
        document.groups!.find((group) => group.id === entity.id)!,
        canvas,
      )
    : { ...canvas.positions[entity.id], width: ARGUMENT_CARD_WIDTH, height: ARGUMENT_CARD_HEIGHT }
}

/** Same delta for all members, including at coordinate limits; no layout/semantic mutation. */
export function translateArgumentEntity(
  document: ArgumentDocument,
  entity: ArgumentEntity,
  dx: number,
  dy: number,
): ArgumentCanvas {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new Error('画布位移无效')
  const canvas = argumentCanvas(document)
  const ids = argumentEntityMembers(document, entity)
  dx = Math.max(
    -100000 - Math.min(...ids.map((id) => canvas.positions[id].x)),
    Math.min(100000 - Math.max(...ids.map((id) => canvas.positions[id].x)), dx),
  )
  dy = Math.max(
    -100000 - Math.min(...ids.map((id) => canvas.positions[id].y)),
    Math.min(100000 - Math.max(...ids.map((id) => canvas.positions[id].y)), dy),
  )
  for (const id of ids) {
    canvas.positions[id].x += dx
    canvas.positions[id].y += dy
  }
  return canvas
}

function pack(group: ArgumentGroup, canvas: ArgumentCanvas, origin?: ArgumentPosition): void {
  const bounds = origin ?? argumentGroupBounds(group, canvas)
  const columns = group.memberIds.length > 4 ? 2 : 1
  const rows = Math.ceil(group.memberIds.length / columns)
  const x = Math.max(
    -99992,
    Math.min(100000 - (columns - 1) * (ARGUMENT_CARD_WIDTH + ARGUMENT_GROUP_GAP), bounds.x + 8),
  )
  const y = Math.max(
    -99960,
    Math.min(100000 - (rows - 1) * (ARGUMENT_CARD_HEIGHT + ARGUMENT_GROUP_GAP), bounds.y + 40),
  )
  group.memberIds.forEach((id, index) => {
    canvas.positions[id] = {
      x: x + (index % columns) * (ARGUMENT_CARD_WIDTH + ARGUMENT_GROUP_GAP),
      y: y + Math.floor(index / columns) * (ARGUMENT_CARD_HEIGHT + ARGUMENT_GROUP_GAP),
    }
  })
}

/** Merge flat groups, preserving target identity/order and both explicit labels. */
export function mergeArgumentEntities(
  document: ArgumentDocument,
  source: ArgumentEntity,
  target: ArgumentEntity,
  newId = `group-${crypto.randomUUID()}`,
): ArgumentDocument {
  assertArgumentGroups(document.groups, document.roots)
  const sourceIds = argumentEntityMembers(document, source),
    targetIds = argumentEntityMembers(document, target)
  if (sourceIds.some((id) => targetIds.includes(id))) throw new Error('不能将大模块移入自身')
  // Explicit node extraction happens before it can be merged with another entity.
  if (
    (source.type === 'node' && argumentGroupFor(document, source.id)) ||
    (target.type === 'node' && argumentGroupFor(document, target.id))
  )
    throw new Error('请先拆出小模块，或合并整个大模块')
  const canvas = argumentCanvas(document),
    origin = entityBounds(document, target, canvas)
  const existing =
    target.type === 'group' ? document.groups!.find((group) => group.id === target.id) : undefined
  const sourceGroup =
    source.type === 'group' ? document.groups!.find((group) => group.id === source.id) : undefined
  const label = [
    ...new Set([existing?.label ?? '', sourceGroup?.label ?? ''].filter(Boolean)),
  ].join(' / ')
  if (label.length > 120) throw new Error('组合后的标签超过 120 字，请先精简标签；原大模块已保留')
  const group: ArgumentGroup = {
    id: existing?.id ?? newId,
    label,
    memberIds: [...targetIds, ...sourceIds],
  }
  const groups = (document.groups ?? [])
    .filter((group) => group.id !== source.id && group.id !== target.id)
    .map((group) => structuredClone(group))
  groups.push(group)
  assertArgumentGroups(groups, document.roots)
  pack(group, canvas, {
    x: origin.x - (target.type === 'node' ? 8 : 0),
    y: origin.y - (target.type === 'node' ? 40 : 0),
  })
  return { ...document, groups, canvas }
}

export function ungroupArgument(document: ArgumentDocument, groupId: string): ArgumentDocument {
  if (!document.groups?.some((group) => group.id === groupId)) throw new Error('找不到大模块')
  return {
    ...document,
    groups: document.groups
      .filter((group) => group.id !== groupId)
      .map((group) => structuredClone(group)),
  }
}

export function extractArgumentNode(
  document: ArgumentDocument,
  nodeId: string,
  position?: ArgumentPosition,
): ArgumentDocument {
  const group = argumentGroupFor(document, nodeId)
  if (!group) return document
  const canvas = argumentCanvas(document),
    bounds = argumentGroupBounds(group, canvas)
  const groups = document
    .groups!.map((entry) => ({
      ...entry,
      memberIds: entry.memberIds.filter((id) => id !== nodeId),
    }))
    .filter((entry) => entry.memberIds.length > 1)
  const remaining = groups.find((entry) => entry.id === group.id)
  if (remaining) pack(remaining, canvas, bounds)
  const point = position ?? { x: bounds.x + bounds.width + 24, y: canvas.positions[nodeId].y }
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error('画布位置无效')
  canvas.positions[nodeId] = {
    x: Math.max(-100000, Math.min(100000, point.x)),
    y: Math.max(-100000, Math.min(100000, point.y)),
  }
  return { ...document, groups, canvas }
}

export function removeArgumentGroup(document: ArgumentDocument, groupId: string): ArgumentDocument {
  const ids = argumentEntityMembers(document, { type: 'group', id: groupId })
  let roots = document.roots
  for (const id of ids)
    if (flattenArgument(roots).some(({ node }) => node.id === id))
      roots = removeArgumentNode(roots, id)
  const next = pruneArgumentGroups({ ...document, roots })
  return { ...next, canvas: argumentCanvas(next) }
}

export function duplicateArgumentGroup(
  document: ArgumentDocument,
  groupId: string,
  makeId: () => string = () => crypto.randomUUID(),
): ArgumentDocument {
  const group = document.groups?.find((group) => group.id === groupId)
  if (!group) throw new Error('找不到大模块')
  const selected = new Set(group.memberIds),
    mapping = new Map<string, string>()
  const copies: ArgumentNode[] = []
  const clone = (node: ArgumentNode): ArgumentNode => {
    const id = makeId()
    mapping.set(node.id, id)
    return { ...node, id, children: node.children.map(clone) }
  }
  const visit = (nodes: ArgumentNode[]) => {
    for (const node of nodes) {
      if (selected.has(node.id)) copies.push(clone(node))
      else visit(node.children)
    }
  }
  visit(document.roots)
  let roots = document.roots
  for (const copy of copies) roots = insertArgumentNode(roots, copy, null, roots.length)
  const copy: ArgumentGroup = {
    id: makeId(),
    label: group.label,
    memberIds: group.memberIds.map((id) => mapping.get(id)!),
  }
  const groups = [...(document.groups ?? []).map((entry) => structuredClone(entry)), copy]
  assertArgumentGroups(groups, roots)
  const canvas = argumentCanvas({ ...document, roots }),
    bounds = argumentGroupBounds(group, canvas)
  pack(copy, canvas, { x: bounds.x + bounds.width + 24, y: bounds.y })
  return { ...document, roots, groups, canvas }
}

/** Preview only. Calling this on load, typing, keyboard moves, or zoom never commits a group. */
export function findArgumentSnapTarget(
  document: ArgumentDocument,
  source: ArgumentEntity,
  canvas: ArgumentCanvas,
): ArgumentEntity | null {
  const sourceIds = new Set(argumentEntityMembers(document, source))
  const sourceGroup = source.type === 'node' ? argumentGroupFor(document, source.id) : undefined
  const grouped = new Set(document.groups?.flatMap((group) => group.memberIds) ?? [])
  const targets: ArgumentEntity[] = [
    ...(document.groups ?? [])
      .filter(
        (group) => group.id !== sourceGroup?.id && !group.memberIds.some((id) => sourceIds.has(id)),
      )
      .map((group) => ({ type: 'group' as const, id: group.id })),
    ...flattenArgument(document.roots)
      .filter(({ node }) => !grouped.has(node.id) && !sourceIds.has(node.id))
      .map(({ node }) => ({ type: 'node' as const, id: node.id })),
  ]
  const a = entityBounds(document, source, canvas)
  let best: ArgumentEntity | null = null,
    score = Infinity
  for (const target of targets) {
    const b = entityBounds(document, target, canvas)
    const gap = Math.hypot(
      Math.max(0, a.x - b.x - b.width, b.x - a.x - a.width),
      Math.max(0, a.y - b.y - b.height, b.y - a.y - a.height),
    )
    const distance =
      gap * 1000000 +
      Math.hypot(a.x + a.width / 2 - b.x - b.width / 2, a.y + a.height / 2 - b.y - b.height / 2)
    if (gap <= ARGUMENT_SNAP_DISTANCE && distance < score) {
      score = distance
      best = target
    }
  }
  return best
}

export function isArgumentNodeOutsideGroup(
  document: ArgumentDocument,
  nodeId: string,
  canvas: ArgumentCanvas,
): boolean {
  const group = argumentGroupFor(document, nodeId)
  if (!group) return false
  const bounds = argumentGroupBounds(group, argumentCanvas(document)),
    point = canvas.positions[nodeId]
  const x = point.x + ARGUMENT_CARD_WIDTH / 2,
    y = point.y + ARGUMENT_CARD_HEIGHT / 2
  return x < bounds.x || x > bounds.x + bounds.width || y < bounds.y || y > bounds.y + bounds.height
}

/** Only selected IDs and labels cross the AI boundary. Never infer subquestion labels. */
export function reviewArgumentGroups(document: ArgumentDocument, roots: ArgumentNode[]) {
  const included = new Set(flattenArgument(roots).map(({ node }) => node.id))
  return (document.groups ?? [])
    .map(({ id, label, memberIds }) => ({
      id,
      label,
      memberIds: memberIds.filter((id) => included.has(id)),
      partial: memberIds.some((id) => !included.has(id)),
    }))
    .filter((group) => group.memberIds.length > 0)
}
