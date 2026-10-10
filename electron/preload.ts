import { contextBridge, ipcRenderer } from 'electron'
import type { ExamCraftApi } from '../src/shared/types'

const api: ExamCraftApi = Object.freeze<ExamCraftApi>({
  listKnowledgeDocuments: () => ipcRenderer.invoke('examcraft:list-knowledge-documents'),
  importKnowledgePdf: (requestId, options) =>
    ipcRenderer.invoke('examcraft:import-knowledge-pdf', requestId, options),
  importKnowledgePack: (requestId) =>
    ipcRenderer.invoke('examcraft:import-knowledge-pack', requestId),
  updateKnowledgeDocumentMetadata: (input) =>
    ipcRenderer.invoke('examcraft:update-knowledge-metadata', input),
  cancelKnowledgeImport: (requestId) =>
    ipcRenderer.invoke('examcraft:cancel-knowledge-import', requestId),
  getKnowledgePdf: (id) => ipcRenderer.invoke('examcraft:get-knowledge-pdf', id),
  searchKnowledge: (input) => ipcRenderer.invoke('examcraft:search-knowledge', input),
  saveKnowledgeScopes: (input) => ipcRenderer.invoke('examcraft:save-knowledge-scopes', input),
  getGitHubProfile: () => ipcRenderer.invoke('examcraft:get-github-profile'),
  setGitHubProfile: (username) => ipcRenderer.invoke('examcraft:set-github-profile', username),
  clearGitHubProfile: () => ipcRenderer.invoke('examcraft:clear-github-profile'),
  getModelConfig: () => ipcRenderer.invoke('examcraft:get-model-config'),
  saveModelConfig: (input) => ipcRenderer.invoke('examcraft:save-model-config', input),
  askAdvisor: (input) => ipcRenderer.invoke('examcraft:ask-advisor', input),
  cancelAdvisor: (id) => ipcRenderer.invoke('examcraft:cancel-advisor', id),
  reviewModules: (input) => ipcRenderer.invoke('examcraft:review-modules', input),
  cancelModuleReview: (id) => ipcRenderer.invoke('examcraft:cancel-module-review', id),
  generateGeographyQuestion: (input) =>
    ipcRenderer.invoke('examcraft:generate-geography-question', input),
  acceptGeneratedQuestion: (token) =>
    ipcRenderer.invoke('examcraft:accept-generated-question', token),
  rejectGeneratedQuestion: (token) =>
    ipcRenderer.invoke('examcraft:reject-generated-question', token),
  cancelQuestionGeneration: (id) => ipcRenderer.invoke('examcraft:cancel-question-generation', id),
  getGenerationStatus: () => ipcRenderer.invoke('examcraft:generation-status'),
  listQuestions: () => ipcRenderer.invoke('examcraft:list-questions'),
  loadState: () => ipcRenderer.invoke('examcraft:load-state'),
  saveDraft: (questionId, draft) => ipcRenderer.invoke('examcraft:save-draft', questionId, draft),
  submitAnswer: (questionId, draft, options) =>
    ipcRenderer.invoke('examcraft:submit-answer', questionId, draft, options),
  importQuestionBank: () => ipcRenderer.invoke('examcraft:import-bank'),
  getCapabilities: () => ipcRenderer.invoke('examcraft:capabilities'),
})
contextBridge.exposeInMainWorld('examcraft', api)
