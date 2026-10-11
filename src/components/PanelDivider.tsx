import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react'

interface Props {
  label: string
  controls: string
  value: number
  min: number
  max: number
  reverse?: boolean
  onResize: (width: number) => void
  onReset: () => void
}
/** Accessible vertical splitter; pointer capture avoids global listeners and leaked drags. */
export function PanelDivider({
  label,
  controls,
  value,
  min,
  max,
  reverse = false,
  onResize,
  onReset,
}: Props) {
  const drag = useRef<{ pointer: number; x: number; value: number } | null>(null)
  const element = useRef<HTMLDivElement>(null)
  function stop() {
    const current = drag.current
    drag.current = null
    if (current && element.current?.hasPointerCapture(current.pointer))
      element.current.releasePointerCapture(current.pointer)
  }
  useEffect(() => {
    window.addEventListener('blur', stop)
    window.addEventListener('resize', stop)
    return () => {
      stop()
      window.removeEventListener('blur', stop)
      window.removeEventListener('resize', stop)
    }
  }, [])
  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.focus()
    drag.current = { pointer: event.pointerId, x: event.clientX, value }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 40 : 10
    let next: number | undefined
    if (event.key === 'ArrowLeft') next = value + (reverse ? step : -step)
    if (event.key === 'ArrowRight') next = value + (reverse ? -step : step)
    if (event.key === 'Home') next = min
    if (event.key === 'End') next = max
    if (next !== undefined) {
      event.preventDefault()
      onResize(next)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      onReset()
    } else if (event.key === 'Escape') stop()
  }
  return (
    <div
      ref={element}
      className="panel-divider"
      data-workspace-layout-control
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation="vertical"
      aria-controls={controls}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      aria-valuetext={`${Math.round(value)} 像素；方向键调整，Shift 加速，Home / End 最小 / 最大，Enter 重置`}
      title={`${label} · 拖动或方向键调整 · 双击重置`}
      onPointerDown={pointerDown}
      onPointerMove={(event) => {
        const current = drag.current
        if (current?.pointer === event.pointerId)
          onResize(current.value + (event.clientX - current.x) * (reverse ? -1 : 1))
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={() => {
        drag.current = null
      }}
      onDoubleClick={onReset}
      onKeyDown={keyDown}
    >
      <span />
    </div>
  )
}
