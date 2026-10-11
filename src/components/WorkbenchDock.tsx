import { useId, useState, type ReactNode } from 'react'

/** Keep the answer in view; larger tools are an explicit, reversible choice. */
export function WorkbenchDock({
  title,
  initiallyOpen = false,
  selfSizing = false,
  children,
}: {
  title: string
  initiallyOpen?: boolean
  selfSizing?: boolean
  children: ReactNode | ((open: boolean) => ReactNode)
}) {
  const bodyId = useId()
  const [open, setOpen] = useState(initiallyOpen)
  const [expanded, setExpanded] = useState(false)
  return (
    <section
      className={`workbench-dock ${expanded ? 'is-expanded' : ''} ${selfSizing ? 'self-sizing' : ''}`}
      aria-label={`${title}面板`}
    >
      <div className="workbench-dock-bar">
        <button
          type="button"
          aria-controls={bodyId}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <span aria-hidden="true">{open ? '▾' : '▸'}</span> {title}
        </button>
        <span>
          {selfSizing ? '按需展开 · 拖动栏间分隔线调整宽度' : '按需展开 · 拖动右下角调整高度'}
        </span>
        {open && !selfSizing && (
          <button type="button" aria-pressed={expanded} onClick={() => setExpanded(!expanded)}>
            {expanded ? '紧凑视图' : '扩大视图'}
          </button>
        )}
      </div>
      <div id={bodyId} className="workbench-dock-body" hidden={!open}>
        {typeof children === 'function' ? children(open) : children}
      </div>
    </section>
  )
}
