interface EventSource {
  on(event: string, listener: () => void): unknown
}
/** Native-window events are authoritative; renderer cleanup/IPC is only an extra guard. */
export function bindWindowWorkCancellation(
  window: EventSource & { webContents: EventSource },
  cancel: () => void,
): void {
  for (const event of ['hide', 'minimize', 'close', 'closed']) window.on(event, cancel)
  for (const event of ['render-process-gone', 'destroyed']) window.webContents.on(event, cancel)
}
