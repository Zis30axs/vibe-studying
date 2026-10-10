import { useEffect, useRef, useState } from 'react'
import {
  MAX_KNOWLEDGE_EVIDENCE,
  KNOWLEDGE_SUBJECTS,
  KNOWLEDGE_MATH_EXTRACTION_WARNING,
  KNOWLEDGE_SUBJECT_LABELS,
  type KnowledgeApi,
  type KnowledgeDocument,
  type KnowledgeEvidence,
  type KnowledgeHit,
} from '../shared/knowledge'
import type { Subject } from '../shared/types'
import type { KnowledgePackImportResult } from '../shared/knowledge-pack'
import { boundedPdfPage, boundedPdfZoom, validPdfRange } from '../domain/pdf-reader'
import { KnowledgePdfCanvas } from './KnowledgePdfCanvas'
import './knowledge-library.css'

export interface KnowledgeCitationTarget {
  documentId: string
  pageNumber: number
  /** Change this when reopening the same citation. */
  requestId?: string
}
export interface KnowledgeLibraryProps {
  api: KnowledgeApi
  selectedEvidence?: KnowledgeEvidence[]
  onSelectEvidence?: (evidence: KnowledgeEvidence[]) => void
  citation?: KnowledgeCitationTarget | null
  /** Current question subject; browsing other subjects never opts their excerpts into Advisor. */
  initialSubject?: Subject
}
const PRESET_LABEL = '政治·必修四《哲学与文化》1–5课'
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : '操作失败，请重试。'

export function KnowledgeLibrary({
  api,
  selectedEvidence = [],
  onSelectEvidence,
  citation,
  initialSubject = 'politics',
}: KnowledgeLibraryProps) {
  const [open, setOpen] = useState(false)
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [browseSubject, setBrowseSubject] = useState<Subject>(initialSubject)
  const browseSubjectRef = useRef(initialSubject)
  const previousInitialSubject = useRef(initialSubject)
  const [metadataTitle, setMetadataTitle] = useState('')
  const [metadataSubject, setMetadataSubject] = useState<Subject>(initialSubject)
  const [metadataEdition, setMetadataEdition] = useState('')
  const [metadataConfirmed, setMetadataConfirmed] = useState(false)
  const [savingMetadata, setSavingMetadata] = useState(false)
  const [loadingList, setLoadingList] = useState(true)
  const [importing, setImporting] = useState(false)
  const [cancelingImport, setCancelingImport] = useState(false)
  const [searching, setSearching] = useState(false)
  const [saving, setSaving] = useState(false)
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState('all')
  const [rangeStart, setRangeStart] = useState('1')
  const [rangeEnd, setRangeEnd] = useState('1')
  const [rangeLabel, setRangeLabel] = useState('')
  const [editingScopeId, setEditingScopeId] = useState<string | null>(null)
  const [hits, setHits] = useState<KnowledgeHit[]>([])
  const [searched, setSearched] = useState(false)
  const [pageNumber, setPageNumber] = useState(1)
  const [pageInput, setPageInput] = useState('1')
  const [zoom, setZoom] = useState(1)
  const [readerOpen, setReaderOpen] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [packResult, setPackResult] = useState<KnowledgePackImportResult | null>(null)
  const mounted = useRef(true)
  const importRequest = useRef<string | null>(null)
  const canceledImportRequest = useRef<string | null>(null)
  const importContextVersion = useRef(0)
  const searchVersion = useRef(0)
  const listVersion = useRef(0)
  const scopeVersion = useRef(0)
  const scopeWritePending = useRef(false)
  const metadataVersion = useRef(0)
  const metadataWritePending = useRef(false)
  const processedCitation = useRef<KnowledgeCitationTarget | null>(null)
  const subjectDocuments = documents.filter((item) => item.subject === browseSubject)
  const document = subjectDocuments.find((item) => item.id === selectedId)
  const evidenceSubjectMatches = browseSubject === initialSubject
  const subjectLabel = KNOWLEDGE_SUBJECT_LABELS[browseSubject]
  const selectedScope = document?.scopes.find((item) => item.id === scope)
  const rangeValid = Boolean(
    document && validPdfRange(Number(rangeStart), Number(rangeEnd), document.pageCount),
  )

  useEffect(() => {
    mounted.current = true
    const version = ++listVersion.current
    setLoadingList(true)
    void api
      .listKnowledgeDocuments()
      .then((items) => {
        if (!mounted.current || version !== listVersion.current) return
        setDocuments(items)
        setSelectedId((previous) =>
          items.some((item) => item.id === previous && item.subject === browseSubjectRef.current)
            ? previous
            : items.find((item) => item.subject === browseSubjectRef.current)?.id || '',
        )
      })
      .catch((reason: unknown) => {
        if (mounted.current && version === listVersion.current) setError(messageOf(reason))
      })
      .finally(() => {
        if (mounted.current && version === listVersion.current) setLoadingList(false)
      })
    return () => {
      mounted.current = false
      searchVersion.current++
      scopeVersion.current++
      metadataVersion.current++
      const request = importRequest.current
      importRequest.current = null
      if (request) void api.cancelKnowledgeImport(request).catch(() => {})
    }
  }, [api])

  useEffect(() => {
    if (!citation) {
      processedCitation.current = null
      return
    }
    if (processedCitation.current === citation) return
    setOpen(true)
    setReaderOpen(true)
    const target = documents.find((item) => item.id === citation.documentId)
    if (!target) {
      if (!loadingList) setError('引用的 PDF 当前不在本地知识库中，请重新导入原文件。')
      return
    }
    processedCitation.current = citation
    importContextVersion.current++
    if (importRequest.current) cancelImport()
    if (target.id !== selectedId) onSelectEvidence?.([])
    searchVersion.current++
    scopeVersion.current++
    metadataVersion.current++
    browseSubjectRef.current = target.subject
    setBrowseSubject(target.subject)
    setSelectedId(target.id)
    setPageNumber(boundedPdfPage(citation.pageNumber, target.pageCount))
    setHits([])
    setSearched(false)
    setSearching(false)
    setScope('all')
    setError('')
  }, [citation, documents, loadingList, selectedId, onSelectEvidence])

  useEffect(() => {
    if (previousInitialSubject.current === initialSubject) return
    previousInitialSubject.current = initialSubject
    chooseSubject(initialSubject)
  }, [initialSubject])

  useEffect(() => {
    setMetadataTitle(document?.title ?? '')
    setMetadataSubject(document?.subject ?? browseSubject)
    setMetadataEdition(document?.edition ?? '')
    setMetadataConfirmed(document?.editionConfirmed ?? false)
  }, [
    document?.id,
    document?.title,
    document?.subject,
    document?.edition,
    document?.editionConfirmed,
    browseSubject,
  ])

  useEffect(() => {
    setPageInput(String(pageNumber))
  }, [pageNumber])

  function invalidateSearch() {
    searchVersion.current++
    setHits([])
    setSearched(false)
    setSearching(false)
    setError('')
  }
  function chooseDocument(id: string, supersedeImport = true) {
    if (supersedeImport) importContextVersion.current++
    if (supersedeImport && importRequest.current) cancelImport()
    onSelectEvidence?.([])
    invalidateSearch()
    scopeVersion.current++
    metadataVersion.current++
    setEditingScopeId(null)
    setSelectedId(id)
    setPageNumber(1)
    setPageInput('1')
    setZoom(1)
    setScope('all')
    setRangeStart('1')
    setRangeEnd(String(documents.find((item) => item.id === id)?.pageCount ?? 1))
    setRangeLabel('')
    setNotice('')
  }
  function chooseSubject(subject: Subject) {
    browseSubjectRef.current = subject
    setBrowseSubject(subject)
    setQuery('')
    chooseDocument(documents.find((item) => item.subject === subject)?.id ?? '')
  }
  function cancelImport() {
    const request = importRequest.current
    if (!request || canceledImportRequest.current === request) return
    canceledImportRequest.current = request
    setCancelingImport(true)
    setNotice('正在取消导入。已保存的资料会保留，处理结束后显示准确结果。')
    void api.cancelKnowledgeImport(request).catch((reason: unknown) => {
      if (mounted.current && importRequest.current === request) setError(messageOf(reason))
    })
  }
  async function importPdf(kind: 'pdf' | 'pack' = 'pdf') {
    if (importRequest.current) return
    const request = crypto.randomUUID()
    importRequest.current = request
    canceledImportRequest.current = null
    const contextVersion = importContextVersion.current
    setCancelingImport(false)
    setImporting(true)
    setPackResult(null)
    setError('')
    setNotice(
      kind === 'pack'
        ? '在系统文件选择器中选择资料包内的 pack.json；请将清单与全部 PDF 放在同一文件夹。文件只在本机处理。'
        : `在系统文件选择器中选择 ${subjectLabel} PDF。只在本机缓存和建立文本索引。`,
    )
    try {
      const result =
        kind === 'pack'
          ? await api.importKnowledgePack(request)
          : await api.importKnowledgePdf(request, { subject: browseSubjectRef.current })
      if (!mounted.current || importRequest.current !== request) return
      const sameContext = contextVersion === importContextVersion.current
      const cancellationRequested = canceledImportRequest.current === request
      if (!('documents' in result) && result.canceled) {
        if (sameContext) setNotice('未导入文件。')
        return
      }
      const imported = 'documents' in result ? result.documents : [result.document]
      if ('documents' in result && sameContext) setPackResult(result)
      listVersion.current++
      setLoadingList(false)
      setDocuments((previous) => [
        ...imported,
        ...previous.filter((item) => !imported.some((next) => next.id === item.id)),
      ])
      const first =
        imported.find((item) => item.subject === browseSubjectRef.current) ?? imported[0]
      if (first && sameContext && !result.canceled && !cancellationRequested) {
        browseSubjectRef.current = first.subject
        setBrowseSubject(first.subject)
        chooseDocument(first.id, false)
        setRangeEnd(String(first.pageCount))
        setReaderOpen(true)
      }
      // A canceled batch can still have committed documents. Make them available
      // without reopening a different subject or replacing newer navigation.
      if (result.canceled || cancellationRequested) {
        setSelectedId(
          (previous) =>
            previous ||
            imported.find((item) => item.subject === browseSubjectRef.current)?.id ||
            '',
        )
      }
      if (sameContext)
        setNotice(
          'documents' in result
            ? result.canceled
              ? `资料包导入已取消；已新增 ${result.importedCount} 份，复用 ${result.duplicateCount} 份，失败 ${result.failedCount} 份，未处理 ${result.items.filter((item) => item.status === 'pending').length} 份。已保存资料仍可离线使用。`
              : !result.validationPassed
                ? '资料包校验未通过，没有导入资料。请检查下方文件问题后重试。'
                : `${cancellationRequested ? '取消前资料包已处理' : '资料包已处理'}：新增 ${result.importedCount} 份，复用 ${result.duplicateCount} 份，失败 ${result.failedCount} 份。请核对各科教材版本。`
            : 'duplicate' in result && result.duplicate
              ? '此 PDF 已在本地缓存，已打开原文档并保留原有学科与版本。'
              : cancellationRequested
                ? '取消前 PDF 已保存在本机，可离线使用。'
                : 'PDF 已保存在本机，可离线阅读和检索。请核对教材名称与版本。',
        )
    } catch (reason) {
      if (
        mounted.current &&
        importRequest.current === request &&
        contextVersion === importContextVersion.current
      )
        setError(messageOf(reason))
    } finally {
      if (mounted.current && importRequest.current === request) {
        importRequest.current = null
        canceledImportRequest.current = null
        setImporting(false)
        setCancelingImport(false)
      }
    }
  }
  async function search() {
    if (
      !document ||
      !query.trim() ||
      searching ||
      metadataWritePending.current ||
      (scope === 'custom' && !rangeValid)
    )
      return
    const version = ++searchVersion.current
    setSearching(true)
    setSearched(false)
    setHits([])
    setError('')
    try {
      const result = await api.searchKnowledge({
        documentId: document.id,
        subject: browseSubject,
        query: query.trim(),
        limit: 20,
        ...(scope === 'custom'
          ? { startPage: Number(rangeStart), endPage: Number(rangeEnd) }
          : selectedScope
            ? { scopeId: selectedScope.id }
            : {}),
      })
      if (!mounted.current || version !== searchVersion.current) return
      // Do not let a malformed or stale transport response mix subjects/documents.
      setHits(
        result.filter((item) => item.subject === browseSubject && item.documentId === document.id),
      )
      setSearched(true)
    } catch (reason) {
      if (mounted.current && version === searchVersion.current) setError(messageOf(reason))
    } finally {
      if (mounted.current && version === searchVersion.current) setSearching(false)
    }
  }
  async function saveScope() {
    if (
      !document ||
      !rangeValid ||
      !rangeLabel.trim() ||
      scopeWritePending.current ||
      metadataWritePending.current
    )
      return
    scopeWritePending.current = true
    const version = ++scopeVersion.current
    const id = editingScopeId ?? crypto.randomUUID()
    setSaving(true)
    setError('')
    try {
      const updated = await api.saveKnowledgeScopes({
        documentId: document.id,
        scopes: [
          ...document.scopes.filter((item) => item.id !== id),
          {
            id,
            label: rangeLabel.trim(),
            startPage: Number(rangeStart),
            endPage: Number(rangeEnd),
          },
        ],
      })
      if (!mounted.current) return
      listVersion.current++
      setLoadingList(false)
      setDocuments((previous) => previous.map((item) => (item.id === updated.id ? updated : item)))
      if (version !== scopeVersion.current) return
      invalidateSearch()
      onSelectEvidence?.([])
      setEditingScopeId(null)
      setScope(id)
      setNotice('章节标签与物理页范围已保存在本机。')
    } catch (reason) {
      if (mounted.current && version === scopeVersion.current) setError(messageOf(reason))
    } finally {
      scopeWritePending.current = false
      if (mounted.current) setSaving(false)
    }
  }
  async function saveMetadata() {
    if (
      !document ||
      !metadataTitle.trim() ||
      metadataWritePending.current ||
      scopeWritePending.current
    )
      return
    metadataWritePending.current = true
    const version = ++metadataVersion.current
    const documentId = document.id
    setSavingMetadata(true)
    setError('')
    // Metadata changes invalidate previously previewed evidence and its consent.
    onSelectEvidence?.([])
    invalidateSearch()
    try {
      const updated = await api.updateKnowledgeDocumentMetadata({
        documentId,
        title: metadataTitle.trim(),
        subject: metadataSubject,
        edition: metadataEdition.trim(),
        editionConfirmed: Boolean(metadataEdition.trim()) && metadataConfirmed,
      })
      if (!mounted.current) return
      listVersion.current++
      setLoadingList(false)
      setDocuments((previous) => previous.map((item) => (item.id === updated.id ? updated : item)))
      if (version !== metadataVersion.current) return
      invalidateSearch()
      onSelectEvidence?.([])
      browseSubjectRef.current = updated.subject
      setBrowseSubject(updated.subject)
      setNotice('教材名称、学科与版本已保存在本机。原 PDF 和章节范围未改动。')
    } catch (reason) {
      if (mounted.current && version === metadataVersion.current) setError(messageOf(reason))
    } finally {
      metadataWritePending.current = false
      if (mounted.current) setSavingMetadata(false)
    }
  }
  function toggleEvidence(hit: KnowledgeHit) {
    if (
      !onSelectEvidence ||
      !document ||
      !evidenceSubjectMatches ||
      metadataWritePending.current ||
      hit.subject !== initialSubject ||
      hit.documentId !== document.id
    )
      return
    const previous = selectedEvidence.filter((item) => item.chunkId !== hit.chunkId)
    if (previous.length !== selectedEvidence.length) {
      onSelectEvidence(previous)
      return
    }
    if (selectedEvidence.length >= MAX_KNOWLEDGE_EVIDENCE) return
    const { score: _score, ...evidence } = hit
    onSelectEvidence([...selectedEvidence, evidence])
  }
  function openPage(page: number) {
    if (!document) return
    setPageNumber(boundedPdfPage(page, document.pageCount))
    setReaderOpen(true)
  }
  function togglePanel(next: boolean) {
    setOpen(next)
    if (next) {
      const version = ++listVersion.current
      void api
        .listKnowledgeDocuments()
        .then((items) => {
          if (!mounted.current || version !== listVersion.current) return
          if (
            selectedEvidence.some(
              (evidence) =>
                !items.some(
                  (item) =>
                    item.id === evidence.documentId &&
                    item.subject === evidence.subject &&
                    item.title === evidence.documentTitle,
                ),
            )
          ) {
            onSelectEvidence?.([])
          }
          setDocuments(items)
          setSelectedId((previous) =>
            items.some((item) => item.id === previous && item.subject === browseSubjectRef.current)
              ? previous
              : items.find((item) => item.subject === browseSubjectRef.current)?.id || '',
          )
          setLoadingList(false)
        })
        .catch((reason: unknown) => {
          if (mounted.current && version === listVersion.current) {
            setError(messageOf(reason))
            setLoadingList(false)
          }
        })
    }
    if (!next) {
      importContextVersion.current++
      invalidateSearch()
      cancelImport()
      scopeVersion.current++
      metadataVersion.current++
    }
  }

  return (
    <section className="knowledge-library" aria-label="教材 PDF 知识库" data-advisor-exclude>
      <button
        className="knowledge-summary"
        aria-expanded={open}
        aria-controls="knowledge-library-body"
        onClick={() => togglePanel(!open)}
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        <strong>{subjectLabel} PDF 知识库</strong>
        <span className="knowledge-summary-meta">
          {subjectDocuments.length ? `${subjectDocuments.length} 份本科资料` : '导入教材后开始'}
        </span>
        {selectedEvidence.length > 0 && (
          <span className="knowledge-badge">已选 {selectedEvidence.length} 条证据</span>
        )}
      </button>
      {open && (
        <div id="knowledge-library-body" className="knowledge-body">
          <div className="knowledge-import-row">
            <p>本地阅读与关键词检索。只有你另行确认的证据片段才会发送给 Advisor。</p>
            <button onClick={() => void importPdf()} disabled={importing}>
              {importing ? '正在导入…' : '导入本地 PDF'}
            </button>
            <button onClick={() => void importPdf('pack')} disabled={importing}>
              导入教材资料包
            </button>
            {importing && (
              <button onClick={cancelImport} disabled={cancelingImport}>
                {cancelingImport ? '正在取消…' : '取消导入'}
              </button>
            )}
          </div>
          <div className="knowledge-subject-row">
            <label>
              知识库学科
              <select
                value={browseSubject}
                onChange={(event) => chooseSubject(event.target.value as Subject)}
              >
                {KNOWLEDGE_SUBJECTS.map((subject) => (
                  <option key={subject} value={subject}>
                    {KNOWLEDGE_SUBJECT_LABELS[subject]}
                  </option>
                ))}
              </select>
            </label>
            <span>
              当前题目：{KNOWLEDGE_SUBJECT_LABELS[initialSubject]} · 仅同科摘录可选作 Advisor 证据
            </span>
          </div>
          {!evidenceSubjectMatches && (
            <p className="knowledge-warning" role="status">
              正在浏览{subjectLabel}资料；当前题目为{KNOWLEDGE_SUBJECT_LABELS[initialSubject]}
              ，这里的摘录不能选作本题证据。
            </p>
          )}
          {error && (
            <p className="knowledge-error" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="knowledge-notice" role="status">
              {notice}
            </p>
          )}
          {packResult?.warning && (
            <p className="knowledge-warning" role="status">
              {packResult.warning}
            </p>
          )}
          {packResult &&
            packResult.items.some(
              (item) => item.status === 'failed' || item.status === 'pending',
            ) && (
              <ul className="knowledge-pack-results" aria-label="教材资料包导入结果">
                {packResult.items
                  .filter((item) => item.status === 'failed' || item.status === 'pending')
                  .map((item) => (
                    <li key={item.file}>
                      <strong>
                        {KNOWLEDGE_SUBJECT_LABELS[item.subject]} · {item.title}
                      </strong>
                      <span>
                        {item.status === 'pending'
                          ? '尚未导入'
                          : item.error || '导入失败，请检查本地文件后重试。'}
                      </span>
                    </li>
                  ))}
              </ul>
            )}
          {loadingList && <p role="status">正在读取本地知识库…</p>}
          {!loadingList && subjectDocuments.length === 0 && (
            <div className="knowledge-empty">
              <strong>先导入你自己的{subjectLabel} PDF</strong>
              <p>此学科尚无本地资料。教材名称、学科与版本均可编辑；请按所用版本核对物理页码。</p>
              {browseSubject === 'politics' && (
                <p>预设“{PRESET_LABEL}”仅为标签，不代表已核对章节页码。</p>
              )}
              <span>支持带文本层的 PDF；扫描件可以阅读，但当前不支持 OCR。</span>
            </div>
          )}
          {subjectDocuments.length > 0 && (
            <label className="knowledge-document-label">
              PDF 文档
              <select value={selectedId} onChange={(event) => chooseDocument(event.target.value)}>
                {subjectDocuments.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.title} · {item.edition || '版本未确认'} · {item.pageCount} 页
                  </option>
                ))}
              </select>
            </label>
          )}
          {document && (
            <>
              <div className="knowledge-document-meta">
                <span>
                  {document.pageCount} 个物理页 · {document.textPageCount} 页有可提取文本
                </span>
                <span>仅本机缓存 · {(document.byteLength / 1024 / 1024).toFixed(1)} MB</span>
              </div>
              <details className="knowledge-metadata-editor">
                <summary>
                  教材信息 · {document.edition || '版本未确认'}
                  {document.edition && !document.editionConfirmed ? '（推定，待核对）' : ''} · 编辑
                </summary>
                <fieldset className="knowledge-metadata-fields" disabled={savingMetadata}>
                  <div className="knowledge-metadata-grid">
                    <label>
                      教材名称
                      <input
                        value={metadataTitle}
                        maxLength={200}
                        onChange={(event) => {
                          metadataVersion.current++
                          setMetadataTitle(event.target.value)
                        }}
                      />
                    </label>
                    <label>
                      教材学科
                      <select
                        value={metadataSubject}
                        onChange={(event) => {
                          metadataVersion.current++
                          setMetadataSubject(event.target.value as Subject)
                        }}
                      >
                        {KNOWLEDGE_SUBJECTS.map((subject) => (
                          <option key={subject} value={subject}>
                            {KNOWLEDGE_SUBJECT_LABELS[subject]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="knowledge-edition-field">
                      教材版本 / 册次
                      <input
                        value={metadataEdition}
                        maxLength={200}
                        placeholder="例如：出版社、年级、必修册次、出版年份"
                        onChange={(event) => {
                          metadataVersion.current++
                          setMetadataEdition(event.target.value)
                          setMetadataConfirmed(false)
                        }}
                      />
                    </label>
                  </div>
                  <label className="knowledge-confirm-edition">
                    <input
                      type="checkbox"
                      checked={metadataConfirmed}
                      disabled={!metadataEdition.trim()}
                      onChange={(event) => {
                        metadataVersion.current++
                        setMetadataConfirmed(event.target.checked)
                      }}
                    />
                    我已对照 PDF 封面 / 版权页核对上述版本
                  </label>
                  <p>导入清单或文件名中的版本仅是待核对信息。这里可修改，不会改写教材原文件。</p>
                  <button
                    type="button"
                    disabled={!metadataTitle.trim() || savingMetadata || saving}
                    onClick={() => void saveMetadata()}
                  >
                    {savingMetadata ? '正在保存教材信息…' : '保存教材信息'}
                  </button>
                </fieldset>
              </details>
              {browseSubject === 'math' && (
                <p className="knowledge-warning" role="status">
                  {KNOWLEDGE_MATH_EXTRACTION_WARNING}
                </p>
              )}
              {document.textPageCount === 0 && (
                <p className="knowledge-warning" role="status">
                  此 PDF 未提取到可检索文本，可能是扫描件或文字编码受限。可继续阅读；当前不支持
                  OCR。
                </p>
              )}
              <div className="knowledge-layout">
                <div className="knowledge-search-column">
                  <form
                    className="knowledge-search-form"
                    onSubmit={(event) => {
                      event.preventDefault()
                      void search()
                    }}
                  >
                    <label>
                      检索范围
                      <select
                        value={scope}
                        onChange={(event) => {
                          invalidateSearch()
                          scopeVersion.current++
                          onSelectEvidence?.([])
                          setEditingScopeId(null)
                          setScope(event.target.value)
                          if (event.target.value === 'custom') {
                            setRangeStart('1')
                            setRangeEnd(String(document.pageCount))
                          }
                        }}
                      >
                        <option value="all">当前文档 · 全部物理页</option>
                        <option value="custom">手动选择物理页范围</option>
                        {document.scopes.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.label} · {item.startPage}–{item.endPage} 页
                          </option>
                        ))}
                      </select>
                    </label>
                    {selectedScope && (
                      <div className="knowledge-scope-note">
                        <span>
                          已标记范围：物理第 {selectedScope.startPage}–{selectedScope.endPage} 页
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            invalidateSearch()
                            scopeVersion.current++
                            onSelectEvidence?.([])
                            setEditingScopeId(selectedScope.id)
                            setRangeStart(String(selectedScope.startPage))
                            setRangeEnd(String(selectedScope.endPage))
                            setRangeLabel(selectedScope.label)
                            setScope('custom')
                          }}
                        >
                          调整范围
                        </button>
                      </div>
                    )}
                    {scope === 'custom' && (
                      <fieldset className="knowledge-range-editor">
                        <legend>手动核对教材版本与物理页码</legend>
                        <div className="knowledge-range-numbers">
                          <label>
                            起始物理页
                            <input
                              type="number"
                              min="1"
                              max={document.pageCount}
                              value={rangeStart}
                              onChange={(event) => {
                                invalidateSearch()
                                scopeVersion.current++
                                onSelectEvidence?.([])
                                setRangeStart(event.target.value)
                              }}
                            />
                          </label>
                          <span>至</span>
                          <label>
                            结束物理页
                            <input
                              type="number"
                              min="1"
                              max={document.pageCount}
                              value={rangeEnd}
                              onChange={(event) => {
                                invalidateSearch()
                                scopeVersion.current++
                                onSelectEvidence?.([])
                                setRangeEnd(event.target.value)
                              }}
                            />
                          </label>
                        </div>
                        {!rangeValid && (
                          <p className="knowledge-error">
                            请输入 1–{document.pageCount} 内从小到大的整数页码。
                          </p>
                        )}
                        <label>
                          章节标签（可选）
                          <input
                            value={rangeLabel}
                            maxLength={120}
                            placeholder="例如：我已核对的第 1–5 课"
                            onChange={(event) => {
                              scopeVersion.current++
                              setRangeLabel(event.target.value)
                            }}
                          />
                        </label>
                        {browseSubject === 'politics' && (
                          <button
                            type="button"
                            className="knowledge-preset"
                            onClick={() => {
                              scopeVersion.current++
                              setRangeLabel(PRESET_LABEL)
                            }}
                          >
                            使用必修四 1–5 课标签
                          </button>
                        )}
                        <p>标签不会自动推断章节页码或生成教材内容。</p>
                        <button
                          type="button"
                          disabled={
                            !rangeValid ||
                            !rangeLabel.trim() ||
                            saving ||
                            savingMetadata ||
                            (!editingScopeId && document.scopes.length >= 100)
                          }
                          onClick={() => void saveScope()}
                        >
                          {saving ? '正在保存…' : '保存章节范围'}
                        </button>
                      </fieldset>
                    )}
                    <label>
                      PDF 关键词
                      <input
                        value={query}
                        maxLength={300}
                        placeholder={
                          browseSubject === 'politics'
                            ? '输入原文关键词，如：实践 认识'
                            : '输入当前教材中的原文关键词'
                        }
                        onChange={(event) => {
                          invalidateSearch()
                          setQuery(event.target.value)
                        }}
                      />
                    </label>
                    <button
                      type="submit"
                      disabled={
                        !query.trim() ||
                        searching ||
                        savingMetadata ||
                        document.textPageCount === 0 ||
                        (scope === 'custom' && !rangeValid)
                      }
                    >
                      {searching ? '检索中…' : '检索本地文本'}
                    </button>
                  </form>
                  <p className="knowledge-extraction-note">
                    基于文本层匹配，公式、表格、多栏阅读顺序可能不完整。引用前请对照原页。
                  </p>
                  {searched && (
                    <p className="knowledge-result-count" role="status">
                      {hits.length
                        ? `找到 ${hits.length} 条片段（最多展示 20 条）`
                        : '当前范围没有匹配片段。试试原文中的短关键词，或调整页码范围。'}
                    </p>
                  )}
                  {hits.length > 0 && (
                    <ol className="knowledge-hits" aria-label="PDF 检索结果">
                      {hits.map((hit) => {
                        const checked = selectedEvidence.some(
                          (item) => item.chunkId === hit.chunkId,
                        )
                        return (
                          <li key={hit.chunkId}>
                            <div className="knowledge-hit-heading">
                              <strong>{hit.documentTitle}</strong>
                              <button type="button" onClick={() => openPage(hit.pageNumber)}>
                                查看第 {hit.pageNumber} 页
                              </button>
                            </div>
                            <p>{hit.text}</p>
                            {onSelectEvidence && (
                              <label className="knowledge-evidence-toggle">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  disabled={
                                    !evidenceSubjectMatches ||
                                    savingMetadata ||
                                    hit.subject !== initialSubject ||
                                    (!checked && selectedEvidence.length >= MAX_KNOWLEDGE_EVIDENCE)
                                  }
                                  aria-label={`选作 Advisor 证据：${hit.documentTitle}，第 ${hit.pageNumber} 页`}
                                  onChange={() => toggleEvidence(hit)}
                                />
                                选作 Advisor 证据
                              </label>
                            )}
                          </li>
                        )
                      })}
                    </ol>
                  )}
                  {onSelectEvidence && (
                    <div className="knowledge-evidence-summary">
                      <span>
                        已选 {selectedEvidence.length}/{MAX_KNOWLEDGE_EVIDENCE}{' '}
                        条证据。选中不会立即发送。
                      </span>
                      {selectedEvidence.length > 0 && (
                        <button type="button" onClick={() => onSelectEvidence([])}>
                          清空证据
                        </button>
                      )}
                    </div>
                  )}
                </div>
                <div className="knowledge-reader-column">
                  <button
                    className="knowledge-reader-heading"
                    onClick={() => setReaderOpen(!readerOpen)}
                    aria-expanded={readerOpen}
                  >
                    <span>{readerOpen ? '▾' : '▸'} 原文阅读</span>
                    <small>物理页码可能与书上页码不同</small>
                  </button>
                  {readerOpen && (
                    <>
                      <div className="knowledge-reader-toolbar">
                        <button
                          aria-label="上一页"
                          disabled={pageNumber <= 1}
                          onClick={() => openPage(pageNumber - 1)}
                        >
                          ‹
                        </button>
                        <form
                          onSubmit={(event) => {
                            event.preventDefault()
                            openPage(Number(pageInput))
                            setPageInput(
                              String(boundedPdfPage(Number(pageInput), document.pageCount)),
                            )
                          }}
                        >
                          <input
                            aria-label="PDF 物理页"
                            type="number"
                            min="1"
                            max={document.pageCount}
                            value={pageInput}
                            onChange={(event) => setPageInput(event.target.value)}
                            onBlur={() => {
                              openPage(Number(pageInput))
                              setPageInput(
                                String(boundedPdfPage(Number(pageInput), document.pageCount)),
                              )
                            }}
                          />
                          <span>/ {document.pageCount}</span>
                        </form>
                        <button
                          aria-label="下一页"
                          disabled={pageNumber >= document.pageCount}
                          onClick={() => openPage(pageNumber + 1)}
                        >
                          ›
                        </button>
                        <label>
                          缩放
                          <select
                            aria-label="PDF 缩放"
                            value={zoom}
                            onChange={(event) =>
                              setZoom(boundedPdfZoom(Number(event.target.value)))
                            }
                          >
                            <option value={0.5}>50%</option>
                            <option value={0.75}>75%</option>
                            <option value={1}>适合宽度</option>
                            <option value={1.5}>150%</option>
                            <option value={2}>200%</option>
                          </select>
                        </label>
                      </div>
                      <KnowledgePdfCanvas
                        key={document.id}
                        api={api}
                        document={document}
                        pageNumber={pageNumber}
                        zoom={zoom}
                      />
                      <p className="knowledge-security-note">
                        PDF 脚本、表单和外部链接不会执行或打开。
                      </p>
                    </>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  )
}
