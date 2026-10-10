import type { ArgumentDocument, ArgumentRevisions, ArgumentSnapshot } from '../shared/types'
import { argumentCanvas, assertArgumentRoots } from './argument'

export const MAX_ARGUMENT_REVISIONS = 40
export const MAX_ARGUMENT_REVISION_BYTES = 1024 * 1024
const validId = (id: unknown): id is string =>
  typeof id === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id) &&
  !['__proto__', 'prototype', 'constructor'].includes(id)

/** Validate topology and bound storage before recursive schema parsing or cloning. */
export function assertArgumentRevisions(value: unknown): asserts value is ArgumentRevisions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('版本树格式无效')
  const timeline = value as ArgumentRevisions
  if (
    !Array.isArray(timeline.nodes) ||
    !timeline.nodes.length ||
    timeline.nodes.length > MAX_ARGUMENT_REVISIONS
  )
    throw new Error(`版本树最多保存 ${MAX_ARGUMENT_REVISIONS} 个检查点；现有历史已保留`)
  const nodes = new Map<string, ArgumentRevisions['nodes'][number]>()
  for (const node of timeline.nodes) {
    if (!node || typeof node !== 'object' || !validId(node.id) || nodes.has(node.id))
      throw new Error('版本 ID 无效或重复')
    if (node.parentId !== null && !validId(node.parentId)) throw new Error('父版本 ID 无效')
    if (
      !Number.isSafeInteger(node.createdAt) ||
      node.createdAt < 0 ||
      node.createdAt > 8640000000000000
    )
      throw new Error('版本时间无效')
    if (typeof node.label !== 'string' || !node.label.trim() || node.label.length > 80)
      throw new Error('请填写 1–80 字的版本名称')
    if (node.source !== 'manual' && node.source !== 'ai') throw new Error('版本来源无效')
    if (
      !node.snapshot ||
      typeof node.snapshot !== 'object' ||
      Array.isArray(node.snapshot) ||
      Object.keys(node.snapshot).some((key) => key !== 'roots' && key !== 'canvas')
    )
      throw new Error('版本快照格式无效')
    assertArgumentRoots(node.snapshot.roots)
    nodes.set(node.id, node)
  }
  if (!validId(timeline.headId) || !nodes.has(timeline.headId)) throw new Error('当前版本不存在')
  if (timeline.nodes.filter((node) => node.parentId === null).length !== 1)
    throw new Error('版本树必须有一个起点')
  for (const node of timeline.nodes) {
    const visited = new Set<string>()
    let current: typeof node | undefined = node
    while (current) {
      if (visited.has(current.id)) throw new Error('版本树不能包含循环')
      visited.add(current.id)
      if (current.parentId === null) break
      const parent = nodes.get(current.parentId)
      if (!parent) throw new Error('父版本不存在')
      if (parent.createdAt > current.createdAt) throw new Error('子版本时间早于父版本')
      current = parent
    }
  }
  // JSON serialization can also reject unexpected circular canvas data before cloning.
  if (new TextEncoder().encode(JSON.stringify(timeline)).byteLength > MAX_ARGUMENT_REVISION_BYTES)
    throw new Error('版本树已达到 1 MiB 存储上限；未创建检查点，现有历史已保留')
}

function snapshot(document: ArgumentDocument): ArgumentSnapshot {
  assertArgumentRoots(document.roots)
  return { roots: structuredClone(document.roots), canvas: argumentCanvas(document) }
}

/** Pure explicit commit. Refuse at limits rather than deleting branches or current ancestry. */
export function checkpointArgument(
  document: ArgumentDocument,
  options: { label: string; source?: 'manual' | 'ai'; now?: number; id?: string },
): ArgumentDocument {
  if (document.revisions) assertArgumentRevisions(document.revisions)
  const revisions: ArgumentRevisions = {
    headId: options.id ?? `rev-${crypto.randomUUID()}`,
    nodes: structuredClone(document.revisions?.nodes ?? []),
  }
  revisions.nodes.push({
    id: revisions.headId,
    parentId: document.revisions?.headId ?? null,
    label: options.label.trim(),
    source: options.source ?? 'manual',
    createdAt:
      options.now ?? Math.max(Date.now(), ...revisions.nodes.map((node) => node.createdAt)),
    snapshot: snapshot(document),
  })
  assertArgumentRevisions(revisions)
  return { ...structuredClone(document), revisions }
}

/** Restore logical structure + canvas only; the caller's final answer text is untouched. */
export function restoreArgumentRevision(
  document: ArgumentDocument,
  revisionId: string,
): ArgumentDocument {
  if (!document.revisions) throw new Error('尚无可恢复的检查点')
  assertArgumentRevisions(document.revisions)
  const node = document.revisions.nodes.find((entry) => entry.id === revisionId)
  if (!node) throw new Error('找不到要恢复的版本')
  return {
    version: 1,
    ...structuredClone(node.snapshot),
    revisions: { ...structuredClone(document.revisions), headId: revisionId },
  }
}

export function hasArgumentDraftChanges(document: ArgumentDocument): boolean {
  const head = document.revisions?.nodes.find((node) => node.id === document.revisions?.headId)
  if (!head) return true
  return (
    JSON.stringify(snapshot(document)) !==
    JSON.stringify(snapshot({ version: 1, ...head.snapshot }))
  )
}

/** Accept one AI edit atomically, retaining uncommitted work as its own baseline. */
export function checkpointAcceptedEdit(
  document: ArgumentDocument,
  editedRoots: ArgumentDocument['roots'],
  label: string,
): ArgumentDocument {
  const baseline = hasArgumentDraftChanges(document)
    ? checkpointArgument(document, { label: '接受建议前', source: 'manual' })
    : document
  return checkpointArgument(
    { ...baseline, roots: structuredClone(editedRoots) },
    { label, source: 'ai' },
  )
}
