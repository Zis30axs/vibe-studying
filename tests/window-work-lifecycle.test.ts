import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { bindWindowWorkCancellation } from '../electron/window-work-lifecycle'
describe('authoritative native lifecycle cancellation', () => {
  it.each(['hide', 'minimize', 'close', 'closed', 'render-process-gone', 'destroyed'])(
    'cancels on %s without renderer cooperation',
    (event) => {
      const window = Object.assign(new EventEmitter(), { webContents: new EventEmitter() })
      const cancel = vi.fn()
      bindWindowWorkCancellation(window, cancel)
      const source = ['render-process-gone', 'destroyed'].includes(event)
        ? window.webContents
        : window
      source.emit(event)
      expect(cancel).toHaveBeenCalledTimes(1)
    },
  )
  it('does not cancel ordinary focus changes', () => {
    const window = Object.assign(new EventEmitter(), { webContents: new EventEmitter() })
    const cancel = vi.fn()
    bindWindowWorkCancellation(window, cancel)
    window.emit('blur')
    window.emit('focus')
    expect(cancel).not.toHaveBeenCalled()
  })
})
