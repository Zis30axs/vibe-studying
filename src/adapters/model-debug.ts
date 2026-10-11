import {
  MODEL_DEBUG_LIMIT,
  sanitizeModelDebugEvent,
  type ModelDebugEvent,
  type ModelDebugRecord,
  type ModelDebugState,
} from '../shared/model-debug'

/** Main-process memory only. It has no filesystem, network, request or credential access. */
export class ModelDebugStore {
  private enabled = false
  private records: ModelDebugRecord[] = []
  private sequence = 0

  getState(): ModelDebugState {
    return {
      enabled: this.enabled,
      limit: MODEL_DEBUG_LIMIT,
      records: this.records.map((record) => ({
        ...record,
        ...(record.connection ? { connection: { ...record.connection } } : {}),
        ...(record.schemaPaths ? { schemaPaths: [...record.schemaPaths] } : {}),
      })),
    }
  }
  setEnabled(enabled: boolean): ModelDebugState {
    if (typeof enabled !== 'boolean') throw new Error('Debug 开关无效。')
    this.enabled = enabled
    if (!enabled) this.records = []
    return this.getState()
  }
  clear(): ModelDebugState {
    this.records = []
    return this.getState()
  }
  record = (event: ModelDebugEvent): void => {
    if (!this.enabled) return
    const safe = sanitizeModelDebugEvent(event)
    if (!safe) return
    this.records.push({ id: ++this.sequence, ...safe })
    if (this.records.length > MODEL_DEBUG_LIMIT)
      this.records.splice(0, this.records.length - MODEL_DEBUG_LIMIT)
  }
  copyText(): string {
    return JSON.stringify({ format: 'examcraft-model-debug-v1', ...this.getState() }, null, 2)
  }
}
