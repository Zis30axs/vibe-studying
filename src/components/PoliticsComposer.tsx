import { useId, useState } from 'react'
import type { AnswerBlock, BlockCategory } from '../shared/types'
import './politics.css'

interface PoliticsComposerProps {
  availableBlocks: AnswerBlock[]
  blocks: AnswerBlock[]
  onChange: (blocks: AnswerBlock[]) => void
  disabled?: boolean
}

const categories: { value: BlockCategory; label: string; prompt: string }[] = [
  { value: 'principle', label: '原理', prompt: '选用与设问相关的知识原理' },
  { value: 'material', label: '材料', prompt: '提取材料中的事实与信息' },
  { value: 'analysis', label: '分析', prompt: '把原理与材料连接起来' },
  { value: 'conclusion', label: '结论', prompt: '回应设问，形成结论或建议' },
]

const MAX_BLOCKS = 30

export function PoliticsComposer({
  availableBlocks,
  blocks,
  onChange,
  disabled = false,
}: PoliticsComposerProps) {
  const id = useId()
  const [customCategory, setCustomCategory] = useState<BlockCategory>('analysis')
  const [announcement, setAnnouncement] = useState('')
  const atLimit = blocks.length >= MAX_BLOCKS
  const nonemptyBlocks = blocks.filter((block) => block.text.trim())
  const characterCount = blocks.reduce((count, block) => count + block.text.length, 0)

  function addBlock(template?: AnswerBlock) {
    if (disabled || atLimit) return
    const category = template?.category ?? customCategory
    const label =
      template?.label ??
      `自定义${categories.find((item) => item.value === category)?.label ?? '模块'}`
    onChange([...blocks, { id: crypto.randomUUID(), category, label, text: template?.text ?? '' }])
    setAnnouncement(`已添加“${label}”，当前有 ${blocks.length + 1} 个模块。`)
  }

  function editBlock(blockId: string, changes: Partial<Pick<AnswerBlock, 'text' | 'label'>>) {
    if (disabled) return
    onChange(blocks.map((block) => (block.id === blockId ? { ...block, ...changes } : block)))
  }

  function moveBlock(blockId: string, direction: -1 | 1) {
    if (disabled) return
    const currentIndex = blocks.findIndex((block) => block.id === blockId)
    const targetIndex = currentIndex + direction
    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= blocks.length) return
    const nextBlocks = [...blocks]
    const [movingBlock] = nextBlocks.splice(currentIndex, 1)
    nextBlocks.splice(targetIndex, 0, movingBlock)
    onChange(nextBlocks)
    setAnnouncement(`“${movingBlock.label}”已移至第 ${targetIndex + 1} 位。`)
  }

  function removeBlock(blockId: string) {
    if (disabled) return
    const removingBlock = blocks.find((block) => block.id === blockId)
    onChange(blocks.filter((block) => block.id !== blockId))
    setAnnouncement(`已移除“${removingBlock?.label ?? '模块'}”。`)
  }

  return (
    <section className="politics-composer" aria-labelledby={`${id}-heading`}>
      <header className="politics-heading">
        <div>
          <h3 id={`${id}-heading`}>主观题组装台</h3>
          <p className="muted">选择模块、补充论证，再按自己的思路调整顺序。</p>
        </div>
        <span className="politics-count">
          {blocks.length} / {MAX_BLOCKS} 个模块
        </span>
      </header>

      <div className="politics-columns">
        <section className="politics-bank" aria-labelledby={`${id}-bank`}>
          <h4 id={`${id}-bank`}>参考模块</h4>
          <p className="muted politics-help">请判断模块是否适合本题。选中模块不代表作答正确。</p>
          {categories.map((category) => {
            const candidates = availableBlocks.filter((block) => block.category === category.value)
            return (
              <section
                className="politics-category"
                key={category.value}
                aria-labelledby={`${id}-bank-${category.value}`}
              >
                <h5 id={`${id}-bank-${category.value}`}>
                  <span className={`politics-tag politics-tag-${category.value}`}>
                    {category.label}
                  </span>
                  <span className="muted">{candidates.length}</span>
                </h5>
                {candidates.length ? (
                  candidates.map((block) => (
                    <article className="politics-template" key={block.id}>
                      <strong>{block.label}</strong>
                      <p>{block.text}</p>
                      <button
                        type="button"
                        className="politics-add"
                        disabled={disabled || atLimit}
                        aria-label={`添加模块：${block.label}`}
                        onClick={() => addBlock(block)}
                      >
                        + 添加到答案
                      </button>
                    </article>
                  ))
                ) : (
                  <p className="muted politics-category-empty">{category.prompt}，可自建模块。</p>
                )}
              </section>
            )
          })}
          <div className="politics-custom">
            <label htmlFor={`${id}-custom-category`}>自建模块类型</label>
            <div className="politics-custom-actions">
              <select
                id={`${id}-custom-category`}
                value={customCategory}
                disabled={disabled || atLimit}
                onChange={(event) => setCustomCategory(event.target.value as BlockCategory)}
              >
                {categories.map((category) => (
                  <option key={category.value} value={category.value}>
                    {category.label}
                  </option>
                ))}
              </select>
              <button type="button" disabled={disabled || atLimit} onClick={() => addBlock()}>
                + 空白模块
              </button>
            </div>
            {atLimit && (
              <p className="politics-limit">已达到 30 个模块的上限，可先合并或移除模块。</p>
            )}
          </div>
        </section>

        <section className="politics-answer" aria-labelledby={`${id}-answer`}>
          <div className="politics-answer-heading">
            <h4 id={`${id}-answer`}>我的答案顺序</h4>
            <span className="muted">{characterCount} 字符</span>
          </div>
          <p className="muted politics-help">每个模块都可独立编辑；上移、下移决定答案中的顺序。</p>
          {blocks.length ? (
            <ol className="politics-sequence">
              {blocks.map((block, index) => {
                const category = categories.find((item) => item.value === block.category)
                return (
                  <li className="politics-block" key={block.id}>
                    <div className="politics-block-heading">
                      <span className="politics-position">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <span className={`politics-tag politics-tag-${block.category}`}>
                        {category?.label ?? '模块'}
                      </span>
                      <div className="politics-block-actions">
                        <button
                          type="button"
                          disabled={disabled || index === 0}
                          aria-label={`上移第 ${index + 1} 个模块：${block.label}`}
                          onClick={() => moveBlock(block.id, -1)}
                        >
                          ↑ 上移
                        </button>
                        <button
                          type="button"
                          disabled={disabled || index === blocks.length - 1}
                          aria-label={`下移第 ${index + 1} 个模块：${block.label}`}
                          onClick={() => moveBlock(block.id, 1)}
                        >
                          ↓ 下移
                        </button>
                        <button
                          type="button"
                          disabled={disabled}
                          aria-label={`移除第 ${index + 1} 个模块：${block.label}`}
                          onClick={() => removeBlock(block.id)}
                        >
                          移除
                        </button>
                      </div>
                    </div>
                    <label className="politics-field-label" htmlFor={`${id}-label-${block.id}`}>
                      模块标题
                    </label>
                    <input
                      id={`${id}-label-${block.id}`}
                      value={block.label}
                      disabled={disabled}
                      maxLength={120}
                      onChange={(event) => editBlock(block.id, { label: event.target.value })}
                    />
                    <label className="politics-field-label" htmlFor={`${id}-text-${block.id}`}>
                      模块正文
                    </label>
                    <textarea
                      id={`${id}-text-${block.id}`}
                      value={block.text}
                      disabled={disabled}
                      maxLength={4000}
                      rows={4}
                      placeholder={category?.prompt}
                      onChange={(event) => editBlock(block.id, { text: event.target.value })}
                    />
                    <span className="politics-text-count muted">
                      {block.text.length} / 4000 字符
                    </span>
                  </li>
                )
              })}
            </ol>
          ) : (
            <div className="politics-empty">
              <span aria-hidden="true">原理 → 材料 → 分析 → 结论</span>
              <p>从左侧添加参考模块，或创建空白模块开始作答。</p>
              <small className="muted">这只是组织思路的参考顺序，可按题目要求调整。</small>
            </div>
          )}
        </section>
      </div>

      <section className="politics-preview" aria-labelledby={`${id}-preview`}>
        <div className="politics-answer-heading">
          <h4 id={`${id}-preview`}>组装预览</h4>
          <span className="muted">{nonemptyBlocks.length} 个有内容的模块</span>
        </div>
        <div className="politics-structure" aria-label="模块结构统计">
          {categories.map((category) => (
            <span key={category.value}>
              {category.label}{' '}
              <strong>
                {nonemptyBlocks.filter((block) => block.category === category.value).length}
              </strong>
            </span>
          ))}
        </div>
        <p className="muted politics-help">
          结构统计仅帮助检查表达完整性，不是评分，也不判断内容是否正确。
        </p>
        <div className="politics-preview-text">
          {nonemptyBlocks.length ? (
            nonemptyBlocks.map((block) => <p key={block.id}>{block.text.trim()}</p>)
          ) : (
            <p className="muted">有内容的模块将按上方顺序显示在这里。</p>
          )}
        </div>
      </section>
      <span className="politics-sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
    </section>
  )
}
