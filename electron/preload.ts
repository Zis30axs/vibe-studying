import { contextBridge, ipcRenderer } from 'electron'
import type { ExamCraftApi } from '../src/shared/types'

const api: ExamCraftApi = Object.freeze<ExamCraftApi>({
  getEmbeddingConfig: () => ipcRenderer.invoke('examcraft:get-embedding-config'),
  saveEmbeddingConfig: (input) => ipcRenderer.invoke('examcraft:save-embedding-config', input),
  diagnoseEmbedding: (input) => ipcRenderer.invoke('examcraft:diagnose-embedding', input),
  prepareEmbedding: (input) => ipcRenderer.invoke('examcraft:prepare-embedding', input),
  confirmEmbedding: (input) => ipcRenderer.invoke('examcraft:confirm-embedding', input),
  searchEmbeddingLocal: (input) => ipcRenderer.invoke('examcraft:search-embedding-local', input),
  clearEmbeddingIndex: (input) => ipcRenderer.invoke('examcraft:clear-embedding-index', input),
  refreshReviewKnowledge: (input) =>
    ipcRenderer.invoke('examcraft:refresh-review-knowledge', input),
  listReviewKnowledge: (input) => ipcRenderer.invoke('examcraft:list-review-knowledge', input),
  updateReviewKnowledgeLabel: (input) =>
    ipcRenderer.invoke('examcraft:update-review-knowledge-label', input),
  associateReviewKnowledge: (input) =>
    ipcRenderer.invoke('examcraft:associate-review-knowledge', input),
  removeReviewKnowledgeAssociation: (input) =>
    ipcRenderer.invoke('examcraft:remove-review-knowledge-association', input),
  removeReviewKnowledgeNode: (input) =>
    ipcRenderer.invoke('examcraft:remove-review-knowledge-node', input),
  getWebResearchConfig: () => ipcRenderer.invoke('examcraft:get-web-research-config'),
  saveWebResearchConfig: (input) => ipcRenderer.invoke('examcraft:save-web-research-config', input),
  startAgentRun: (input) => ipcRenderer.invoke('examcraft:start-agent-run', input),
  getAgentRun: (runId) => ipcRenderer.invoke('examcraft:get-agent-run', runId),
  cancelAgentRun: (runId) => ipcRenderer.invoke('examcraft:cancel-agent-run', runId),
  acceptAgentProposal: (input) => ipcRenderer.invoke('examcraft:accept-agent-proposal', input),
  discardAgentProposal: (input) => ipcRenderer.invoke('examcraft:discard-agent-proposal', input),
  restoreLearningSnapshot: (input) =>
    ipcRenderer.invoke('examcraft:restore-learning-snapshot', input),
  getLearningGraph: () => ipcRenderer.invoke('examcraft:get-learning-graph'),
  acceptModuleSuggestion: (input) =>
    ipcRenderer.invoke('examcraft:accept-module-suggestion', input),
  rejectLearningHelp: (id) => ipcRenderer.invoke('examcraft:reject-learning-help', id),
  getAppearance: () => ipcRenderer.invoke('examcraft:get-appearance'),
  saveAppearance: (preferences) => ipcRenderer.invoke('examcraft:save-appearance', preferences),
  chooseWallpaper: () => ipcRenderer.invoke('examcraft:choose-wallpaper'),
  removeWallpaper: () => ipcRenderer.invoke('examcraft:remove-wallpaper'),
  resetAppearance: () => ipcRenderer.invoke('examcraft:reset-appearance'),
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
  getModelConfig: (role) => ipcRenderer.invoke('examcraft:get-model-config', role),
  getModelConsents: () => ipcRenderer.invoke('examcraft:get-model-consents'),
  grantModelConsent: (input) => ipcRenderer.invoke('examcraft:grant-model-consent', input),
  revokeModelConsent: (input) => ipcRenderer.invoke('examcraft:revoke-model-consent', input),
  cancelModelReview: () => ipcRenderer.invoke('examcraft:cancel-model-review'),
  getModelDebug: () => ipcRenderer.invoke('examcraft:get-model-debug'),
  setModelDebugEnabled: (enabled) =>
    ipcRenderer.invoke('examcraft:set-model-debug-enabled', enabled),
  clearModelDebug: () => ipcRenderer.invoke('examcraft:clear-model-debug'),
  copyModelDebug: () => ipcRenderer.invoke('examcraft:copy-model-debug'),
  getModelProfiles: () => ipcRenderer.invoke('examcraft:get-model-profiles'),
  saveModelProfile: (input) => ipcRenderer.invoke('examcraft:save-model-profile', input),
  assignModelProfiles: (input) => ipcRenderer.invoke('examcraft:assign-model-profiles', input),
  deleteModelProfile: (input) => ipcRenderer.invoke('examcraft:delete-model-profile', input),
  diagnoseModel: (input) => ipcRenderer.invoke('examcraft:diagnose-model', input),
  cancelModelDiagnostic: (id) => ipcRenderer.invoke('examcraft:cancel-model-diagnostic', id),
  saveModelConfig: (input) => ipcRenderer.invoke('examcraft:save-model-config', input),
  askAdvisor: (input, localDraft) => ipcRenderer.invoke('examcraft:ask-advisor', input, localDraft),
  cancelAdvisor: (id) => ipcRenderer.invoke('examcraft:cancel-advisor', id),
  reviewModules: (input, localDraft) =>
    ipcRenderer.invoke('examcraft:review-modules', input, localDraft),
  cancelModuleReview: (id) => ipcRenderer.invoke('examcraft:cancel-module-review', id),
  generateGeographyQuestion: (input, localContext) =>
    ipcRenderer.invoke('examcraft:generate-geography-question', input, localContext),
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
