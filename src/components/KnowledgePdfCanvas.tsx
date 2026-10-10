import { useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import type { KnowledgeApi, KnowledgeDocument } from '../shared/knowledge'
import { boundedPdfPage, boundedPdfScale, boundedPdfZoom } from '../domain/pdf-reader'

interface Props {
  api: Pick<KnowledgeApi, 'getKnowledgePdf'>
  document: KnowledgeDocument
  pageNumber: number
  zoom: number
}
export function KnowledgePdfCanvas({ api, document, pageNumber, zoom }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const renderTask = useRef<RenderTask | null>(null)
  const closeDocument = useRef<(() => void) | null>(null)
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [width, setWidth] = useState(480)
  const [status, setStatus] = useState('正在打开本地 PDF…')
  const [error, setError] = useState('')
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    let current = true
    let loading: { destroy(): void } | undefined
    setPdf(null)
    setVisible(false)
    setError('')
    setStatus('正在打开本地 PDF…')
    const timeout = window.setTimeout(() => {
      if (!current) return
      current = false
      loading?.destroy()
      setStatus('')
      setError('PDF 打开超时，请收起后重新展开原文阅读。')
    }, 30_000)
    void Promise.all([api.getKnowledgePdf(document.id), import('./pdf-assets')])
      .then(async ([bytes, module]) => {
        if (!current) return
        const next = module.loadLocalPdf(bytes)
        loading = next
        closeDocument.current = () => next.destroy()
        const loaded = await next.task.promise
        if (!current) return
        if (loaded.numPages !== document.pageCount)
          throw new Error('PDF 页数与缓存不一致，请重新导入此文件。')
        window.clearTimeout(timeout)
        setPdf(loaded)
      })
      .catch((reason: unknown) => {
        if (!current) return
        setStatus('')
        window.clearTimeout(timeout)
        setError(reason instanceof Error ? reason.message : 'PDF 打开失败，请重新导入文件。')
        loading?.destroy()
      })
    return () => {
      current = false
      window.clearTimeout(timeout)
      closeDocument.current = null
      renderTask.current?.cancel()
      renderTask.current = null
      loading?.destroy()
    }
  }, [api, document.id, document.pageCount])

  useEffect(() => {
    const element = host.current
    if (!element) return
    const update = () => setWidth(Math.max(120, element.clientWidth - 24))
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!pdf || !canvas.current) return
    let current = true
    let ownTask: RenderTask | undefined
    const target = canvas.current
    const previous = renderTask.current
    previous?.cancel()
    setVisible(false)
    setError('')
    setStatus('正在绘制页面…')
    const timeout = window.setTimeout(() => {
      if (!current) return
      current = false
      window.clearTimeout(timeout)
      ownTask?.cancel()
      closeDocument.current?.()
      setStatus('')
      setError('页面绘制超时，请收起后重新展开原文阅读。')
    }, 30_000)
    void (async () => {
      // PDF.js prohibits overlapping renders to a canvas; wait for cancellation.
      await previous?.promise.catch(() => {})
      if (!current) return
      const page = await pdf.getPage(boundedPdfPage(pageNumber, pdf.numPages))
      if (!current) return
      const base = page.getViewport({ scale: 1 })
      const ratio = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
      const scale = boundedPdfScale(base.width, base.height, width, zoom, ratio)
      const viewport = page.getViewport({ scale })
      target.width = Math.max(1, Math.floor(viewport.width))
      target.height = Math.max(1, Math.floor(viewport.height))
      target.style.width = `${Math.min(width * boundedPdfZoom(zoom), viewport.width / ratio)}px`
      target.style.height = 'auto'
      const { AnnotationMode } = await import('./pdf-assets')
      if (!current) return
      // Canvas only: no annotation/link layers, scripting manager, forms or embeds.
      ownTask = page.render({ canvas: target, viewport, annotationMode: AnnotationMode.DISABLE })
      renderTask.current = ownTask
      await ownTask.promise
      if (!current) return
      window.clearTimeout(timeout)
      setVisible(true)
      setStatus('')
    })().catch((reason: unknown) => {
      if (!current) return
      setStatus('')
      window.clearTimeout(timeout)
      setError(reason instanceof Error ? reason.message : '页面绘制失败，请重试。')
    })
    return () => {
      current = false
      window.clearTimeout(timeout)
      ownTask?.cancel()
    }
  }, [pdf, pageNumber, zoom, width])

  return (
    <div className="knowledge-pdf-stage" ref={host} aria-busy={Boolean(status)}>
      {status && (
        <p className="knowledge-pdf-status" role="status">
          {status}
        </p>
      )}
      {error && (
        <p className="knowledge-error" role="alert">
          {error}
        </p>
      )}
      <canvas
        ref={canvas}
        className={visible ? '' : 'knowledge-canvas-pending'}
        aria-label={`${document.title}，PDF 物理第 ${boundedPdfPage(pageNumber, document.pageCount)} 页`}
        role="img"
      />
    </div>
  )
}
