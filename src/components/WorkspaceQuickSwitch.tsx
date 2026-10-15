import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { StudentQuestion } from '../shared/types'
import {
  findWorkspaceCommands,
  type WorkspaceCommand,
  type WorkspaceUiPreferences,
  type WorkspaceView,
} from '../domain/workspace-experience'

export function WorkspaceQuickSwitch({
  open,
  onClose,
  questions,
  disabled,
  motion,
  onMotion,
  onView,
  onQuestion,
}: {
  open: boolean
  onClose(): void
  questions: StudentQuestion[]
  disabled: boolean
  motion: WorkspaceUiPreferences['motion']
  onMotion(): void
  onView(view: WorkspaceView): void
  onQuestion(id: string): void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const id = useId()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const commands = useMemo(
    () => findWorkspaceCommands(questions, query, motion),
    [questions, query, motion],
  )
  const index = Math.min(active, Math.max(0, commands.length - 1))
  useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (open && !element.open) {
      setQuery('')
      setActive(0)
      element.showModal()
      search.current?.focus()
    } else if (!open && element.open) element.close()
  }, [open])
  useEffect(() => {
    if (open) document.getElementById(`${id}-option-${index}`)?.scrollIntoView({ block: 'nearest' })
  }, [index, query, open, id])
  function close() {
    dialog.current?.close()
    onClose()
  }
  function choose(command: WorkspaceCommand) {
    if (disabled) return
    close()
    if (command.kind === 'view') onView(command.target as WorkspaceView)
    else if (command.kind === 'question') onQuestion(command.target)
    else onMotion()
  }
  return (
    <dialog
      ref={dialog}
      className="workspace-command"
      aria-labelledby={`${id}-title`}
      onClose={onClose}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return
        const rect = event.currentTarget.getBoundingClientRect()
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          close()
      }}
    >
      <header className="command-heading">
        <div>
          <span className="command-eyebrow">QUICK SWITCH</span>
          <h2 id={`${id}-title`}>想去哪里，直接找</h2>
        </div>
        <button onClick={close} aria-label="关闭快速查找">
          Esc
        </button>
      </header>
      <div className="command-search">
        <span aria-hidden="true">⌕</span>
        <input
          ref={search}
          role="combobox"
          aria-label="查找题目或工具"
          aria-controls={`${id}-results`}
          aria-expanded={open}
          aria-autocomplete="list"
          aria-activedescendant={commands.length ? `${id}-option-${index}` : undefined}
          autoComplete="off"
          maxLength={200}
          placeholder="搜索题目、知识点、数学或设置…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setActive(0)
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              setActive(
                commands.length
                  ? (index + (event.key === 'ArrowDown' ? 1 : -1) + commands.length) %
                      commands.length
                  : 0,
              )
            } else if (event.key === 'Enter' && commands[index]) {
              event.preventDefault()
              choose(commands[index])
            } else if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              close()
            }
          }}
        />
      </div>
      <div
        className="command-results"
        id={`${id}-results`}
        role="listbox"
        aria-label="查找结果"
        aria-busy={disabled}
      >
        {open &&
          commands.map((command, position) => (
            <div
              key={command.id}
              id={`${id}-option-${position}`}
              role="option"
              aria-selected={index === position}
              aria-disabled={disabled}
              className="command-option"
              onClick={() => choose(command)}
              onPointerMove={() => setActive(position)}
            >
              <span className="command-icon" aria-hidden="true">
                {command.icon}
              </span>
              <span className="command-copy">
                <strong>{command.title}</strong>
                <small>{command.detail}</small>
              </span>
              <span className="command-kind">
                {command.kind === 'question' ? '题目' : command.kind === 'view' ? '工作台' : '外观'}
              </span>
            </div>
          ))}
      </div>
      {!commands.length && (
        <div className="command-empty" role="status">
          没有找到结果。试试学科名、题目名称或知识点。
        </div>
      )}
      <footer>
        <span>↑ ↓ 选择 · Enter 打开</span>
        <span>{disabled ? '当前操作完成后才能切换' : '只导航，不提交答案或调用模型'}</span>
      </footer>
    </dialog>
  )
}
