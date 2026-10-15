import { useLayoutEffect, useRef } from 'react'
import type { GeoDrawing } from '../shared/types'
import type { GeoboardState } from '../shared/geoboard-types'
import { GeoboardView } from './geoboard-view'
import './geoboard.css'

/** The SVG view owns transient pointer state; the app owns every saved construction. */
export function GeoboardWorkbench({
  value,
  onChange,
  disabled = false,
  legacy,
}: {
  value?: GeoboardState
  onChange: (next: GeoboardState) => void
  disabled?: boolean
  legacy?: GeoDrawing
}) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<GeoboardView | null>(null)
  const callback = useRef(onChange)
  callback.current = onChange
  useLayoutEffect(() => {
    if (!host.current) return
    const mounted = new GeoboardView(host.current, { onChange: (next) => callback.current(next) })
    view.current = mounted
    return () => {
      mounted.destroy()
      view.current = null
    }
  }, [])
  useLayoutEffect(() => {
    view.current?.update(value, disabled, legacy)
  }, [value, disabled, legacy])
  return <div ref={host} className="geoboard-host" />
}
