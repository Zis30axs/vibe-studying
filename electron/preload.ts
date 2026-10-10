import { contextBridge, ipcRenderer } from 'electron'
import type { ExamCraftApi } from '../src/shared/types'

const api: ExamCraftApi = Object.freeze<ExamCraftApi>({
  listQuestions: () => ipcRenderer.invoke('examcraft:list-questions'),
  loadState: () => ipcRenderer.invoke('examcraft:load-state'),
  saveDraft: (questionId, draft) => ipcRenderer.invoke('examcraft:save-draft', questionId, draft),
  submitAnswer: (questionId, draft) =>
    ipcRenderer.invoke('examcraft:submit-answer', questionId, draft),
  importQuestionBank: () => ipcRenderer.invoke('examcraft:import-bank'),
  getCapabilities: () => ipcRenderer.invoke('examcraft:capabilities'),
})
contextBridge.exposeInMainWorld('examcraft', api)
