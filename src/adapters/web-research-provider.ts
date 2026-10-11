import { randomUUID } from 'node:crypto'
import { lookup } from 'node:dns'
import { isIP } from 'node:net'
import { request } from 'node:https'
import { Readable } from 'node:stream'
import { z } from 'zod'
import {
  WEB_RESEARCH_ENDPOINT,
  WEB_RESEARCH_LIMITS,
  buildWebResearchQuery,
  canonicalPublicResearchUrl,
  webResearchScopeSchema,
  type WebResearchBudget,
  type WebResearchResult,
  type WebResearchScope,
  type WebResearchSession,
  type WebResearchSource,
} from '../shared/web-research'
import { webResearchKeySchema } from './web-research-store'
import { containsCredentialText } from './credential-reflection'

const messages = {
  scope: '公开检索范围无效；请重新确认学科、章节、地区和年份。',
  url: '网页地址不在本次已授权的公开来源中。',
  budget: '本次联网调用已达到上限；失败或取消的调用也可能产生服务商费用。',
  auth: 'Tavily 身份验证失败，请检查密钥。',
  quota: 'Tavily 请求受限或额度不足，请检查服务额度。',
  http: '公开资料服务未完成请求；不会自动重试。',
  redirect: '网页发生重定向，已停止；请确认最终公开地址后重试。',
  network: '无法安全连接公开资料服务，请检查网络。',
  cancelled: '联网请求已取消。',
  timeout: '联网请求超时；不会自动重试。',
  size: '网页或服务响应超过安全大小限制，已停止读取。',
  content: '仅支持有限大小的 UTF-8 公开 HTML 或纯文本网页；不下载 PDF、附件或执行脚本。',
  response: '联网服务响应格式无效，未采纳该内容。',
  reflection: '联网服务响应包含敏感认证信息，已拦截。',
} as const
export class WebResearchError extends Error {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code])
    this.name = 'WebResearchError'
  }
}

/** Conservative global-unicast allowlist. Reject transition and special-purpose ranges. */
export function isPublicResearchAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number)
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    )
  }
  if (isIP(address) !== 6 || address.includes('.') || address.includes('%')) return false
  const halves = address.toLowerCase().split('::')
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves[1] ? halves[1].split(':') : []
  const groups =
    halves.length === 2
      ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
      : left
  const words = groups.map((value) => parseInt(value, 16))
  if (words.length !== 8 || words[0] < 0x2000 || words[0] > 0x3fff) return false
  return !(
    words[0] === 0x2002 ||
    (words[0] === 0x2001 && (words[1] < 0x0200 || words[1] === 0x0db8)) ||
    (words[0] === 0x3fff && words[1] < 0x1000)
  )
}

/** DNS validation happens inside this exact connection lookup; no second resolution/rebinding. */
export function createPublicResearchFetch(
  options: { lookupImpl?: typeof lookup; requestImpl?: typeof request } = {},
): typeof fetch {
  return async (input, init) =>
    new Promise((resolve, reject) => {
      const url = canonicalPublicResearchUrl(String(input))
      const req = (options.requestImpl ?? request)(
        url,
        {
          method: init?.method ?? 'GET',
          headers: init?.headers as Record<string, string>,
          signal: init?.signal ?? undefined,
          agent: false,
          lookup: (hostname, lookupOptions, callback) =>
            (options.lookupImpl ?? lookup)(hostname, { all: true }, (error, addresses) => {
              if (
                error ||
                !addresses.length ||
                addresses.some((entry) => !isPublicResearchAddress(entry.address))
              ) {
                callback(new Error('Public endpoint unavailable'), [], undefined)
                return
              }
              if (lookupOptions.all) callback(null, addresses)
              else callback(null, addresses[0].address, addresses[0].family)
            }),
        },
        (response) => {
          try {
            const headers = new Headers()
            for (const [key, value] of Object.entries(response.headers))
              if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
            resolve(
              new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, {
                status: response.statusCode ?? 500,
                headers,
              }),
            )
          } catch {
            response.destroy()
            reject(new WebResearchError('response'))
          }
        },
      )
      req.on('error', reject)
      req.end(init?.method?.toUpperCase() === 'POST' ? (init.body as string) : undefined)
    })
}
const publicResearchFetch = createPublicResearchFetch()
const clone = <T>(value: T): T => structuredClone(value)
const cleanText = (text: string, limit: number) =>
  text
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
function decodedEntities(value: string) {
  return value.replace(
    /&#(x[0-9a-f]+|\d+);|&(amp|lt|gt|quot|apos|nbsp);/gi,
    (whole, number: string | undefined, name: string | undefined) => {
      if (number) {
        const code = number.toLowerCase().startsWith('x')
          ? parseInt(number.slice(1), 16)
          : Number(number)
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
      }
      return (
        ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[
          name!.toLowerCase()
        ] ?? whole
      )
    },
  )
}
function pageText(raw: string, html: boolean): { title: string; text: string } {
  if (!html) return { title: '', text: cleanText(raw, WEB_RESEARCH_LIMITS.excerptCharacters) }
  const title = cleanText(
    decodedEntities(raw.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] ?? ''),
    200,
  )
  const text = decodedEntities(
    raw
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|template|svg|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<[^>]*>/g, ' '),
  )
  // This is plain-text evidence, never HTML rendering, execution, crawling or subresource loading.
  return { title, text: cleanText(text, WEB_RESEARCH_LIMITS.excerptCharacters) }
}
function reflection(raw: string, key: string) {
  if (containsCredentialText(raw, key)) throw new WebResearchError('reflection')
}
function yearsIn(
  source: Pick<WebResearchSource, 'title' | 'url' | 'excerpt'>,
  years: number[],
): WebResearchSource['yearEvidence'] {
  const text = `${source.title} ${source.url} ${source.excerpt}`
  return [...new Set(years)].flatMap((year) => {
    const found = new RegExp(`(?<![0-9])${year}(?![0-9])`).exec(text)
    return found
      ? [
          {
            year,
            evidence: cleanText(text.slice(Math.max(0, found.index - 45), found.index + 100), 160),
          },
        ]
      : []
  })
}
const searchEnvelope = z.object({
  results: z
    .array(
      z.object({
        title: z.string().max(10000),
        url: z.string().max(10000),
        content: z.string().max(100000),
      }),
    )
    .max(20),
  usage: z.object({ credits: z.number().min(0).max(50) }).optional(),
})

export class TavilyWebResearchProvider {
  private apiKey: string
  private fetchImpl: typeof fetch
  private timeoutMs: number
  constructor(options: { apiKey: string; fetchImpl?: typeof fetch; timeoutMs?: number }) {
    const key = webResearchKeySchema.safeParse(options.apiKey)
    if (!key.success) throw new WebResearchError('auth')
    this.apiKey = key.data
    this.fetchImpl = options.fetchImpl ?? publicResearchFetch
    this.timeoutMs = Number.isFinite(options.timeoutMs)
      ? Math.min(30000, Math.max(1, options.timeoutMs!))
      : 15000
  }
  createSession(scope: WebResearchScope): WebResearchSession {
    reflection(JSON.stringify(scope), this.apiKey)
    let parsed: WebResearchScope
    try {
      parsed = webResearchScopeSchema.parse(scope)
    } catch {
      throw new WebResearchError('scope')
    }
    return new TavilyResearchSession(clone(parsed), (url, method, body, signal) =>
      this.read(url, method, body, signal),
    )
  }
  private async read(
    url: string,
    method: 'POST' | 'GET',
    body: unknown,
    signal?: AbortSignal,
  ): Promise<{ text: string; html: boolean }> {
    if (signal?.aborted) throw new WebResearchError('cancelled')
    reflection(url, this.apiKey)
    canonicalPublicResearchUrl(url)
    const controller = new AbortController()
    let interruption: WebResearchError | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let cancel = () => {}
    const interrupted = new Promise<never>((_, reject) => {
      const stop = (code: 'cancelled' | 'timeout') => {
        interruption ??= new WebResearchError(code)
        controller.abort()
        reject(interruption)
      }
      cancel = () => stop('cancelled')
      signal?.addEventListener('abort', cancel, { once: true })
      timer = setTimeout(() => stop('timeout'), this.timeoutMs)
    })
    const operation = async () => {
      const headers: Record<string, string> = {
        Accept: method === 'POST' ? 'application/json' : 'text/html, text/plain',
        'Accept-Encoding': 'identity',
      }
      if (method === 'POST') {
        headers.Authorization = `Bearer ${this.apiKey}`
        headers['Content-Type'] = 'application/json'
      }
      // The credential is only sent to this fixed endpoint; GET never receives it/cookies/referrers.
      if (method === 'POST' && url !== `${WEB_RESEARCH_ENDPOINT}/search`)
        throw new WebResearchError('url')
      const response = await this.fetchImpl(url, {
        method,
        headers,
        body: method === 'POST' ? JSON.stringify(body) : undefined,
        redirect: 'error',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      })
      const discard = () => {
        void response.body?.cancel().catch(() => undefined)
      }
      if (controller.signal.aborted) {
        discard()
        throw interruption ?? new WebResearchError('cancelled')
      }
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        discard()
        throw new WebResearchError('redirect')
      }
      if (!response.ok) {
        discard()
        throw new WebResearchError(
          method === 'POST' && [401, 403].includes(response.status)
            ? 'auth'
            : method === 'POST' && [429, 432, 433].includes(response.status)
              ? 'quota'
              : 'http',
        )
      }
      const type = response.headers.get('content-type') ?? ''
      const mime = type.split(';')[0].trim().toLowerCase()
      const encoding = response.headers.get('content-encoding')
      if (encoding && encoding.toLowerCase() !== 'identity') {
        discard()
        throw new WebResearchError('content')
      }
      if (
        (method === 'POST'
          ? mime !== 'application/json'
          : !['text/html', 'text/plain'].includes(mime)) ||
        /charset\s*=\s*['"]?(?!utf-8(?:[;'"\s]|$)|us-ascii(?:[;'"\s]|$))[^;'"\s]+/i.test(type)
      ) {
        discard()
        throw new WebResearchError('content')
      }
      const length = response.headers.get('content-length')
      if (length && (!/^\d+$/.test(length) || Number(length) > WEB_RESEARCH_LIMITS.responseBytes)) {
        discard()
        throw new WebResearchError('size')
      }
      if (!response.body) throw new WebResearchError('response')
      const reader = response.body.getReader()
      const abortRead = () => {
        void reader.cancel().catch(() => undefined)
      }
      controller.signal.addEventListener('abort', abortRead, { once: true })
      let total = 0
      const chunks: Uint8Array[] = []
      try {
        while (true) {
          const part = await reader.read()
          if (controller.signal.aborted) throw interruption ?? new WebResearchError('cancelled')
          if (part.done) break
          total += part.value.byteLength
          if (total > WEB_RESEARCH_LIMITS.responseBytes) throw new WebResearchError('size')
          chunks.push(part.value)
        }
        let text: string
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
        } catch {
          throw new WebResearchError('content')
        }
        reflection(text, this.apiKey)
        if (method === 'POST') {
          try {
            reflection(JSON.stringify(JSON.parse(text)), this.apiKey)
          } catch (error) {
            if (error instanceof WebResearchError) throw error
            throw new WebResearchError('response')
          }
        } else {
          const plain = pageText(text, mime === 'text/html')
          reflection(plain.title + ' ' + plain.text, this.apiKey)
        }
        return { text, html: mime === 'text/html' }
      } finally {
        controller.signal.removeEventListener('abort', abortRead)
        void reader.cancel().catch(() => undefined)
      }
    }
    try {
      return await Promise.race([operation(), interrupted])
    } catch (error) {
      throw (
        interruption ??
        (error instanceof WebResearchError ? error : new WebResearchError('network'))
      )
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
    }
  }
}

type ReadSource = (
  url: string,
  method: 'POST' | 'GET',
  body: unknown,
  signal?: AbortSignal,
) => Promise<{ text: string; html: boolean }>
class TavilyResearchSession implements WebResearchSession {
  private sources = new Map<string, WebResearchSource>()
  private byUrl = new Map<string, string>()
  private jobs = new Map<string, Promise<WebResearchResult>>()
  private searchesUsed = 0
  private fetchesUsed = 0
  private reportedCredits: number | null = null
  private readonly id = randomUUID()
  constructor(
    private readonly scope: WebResearchScope,
    private readonly read: ReadSource,
  ) {
    for (const url of scope.approvedUrls)
      this.addSource({
        title: new URL(url).hostname,
        url,
        excerpt: '',
        retrievedAt: null,
        retrieved: false,
        yearEvidence: [],
        provenance: 'user-approved-url',
        untrusted: true,
        verification: 'unverified',
      })
  }
  private addSource(source: Omit<WebResearchSource, 'sourceId'>): WebResearchSource {
    const sourceId = this.byUrl.get(source.url) ?? `web-${this.id}-${this.sources.size + 1}`
    const previous = this.sources.get(sourceId)
    if (previous?.provenance === 'direct-fetch' && source.provenance === 'tavily-search')
      return previous
    const next = { ...source, sourceId }
    this.sources.set(sourceId, next)
    this.byUrl.set(source.url, sourceId)
    return next
  }
  getSources() {
    return clone([...this.sources.values()])
  }
  getBudget(): WebResearchBudget {
    return {
      searchesUsed: this.searchesUsed,
      searchesLimit: WEB_RESEARCH_LIMITS.searches,
      fetchesUsed: this.fetchesUsed,
      fetchesLimit: WEB_RESEARCH_LIMITS.fetches,
      estimatedSearchCredits: this.searchesUsed,
      reportedCredits: this.reportedCredits,
    }
  }
  private result(sources: WebResearchSource[]): WebResearchResult {
    return clone({ sources, budget: this.getBudget(), untrusted: true })
  }
  private async job(
    key: string,
    signal: AbortSignal | undefined,
    start: () => Promise<WebResearchResult>,
  ): Promise<WebResearchResult> {
    if (signal?.aborted) throw new WebResearchError('cancelled')
    // Retain failed/cancelled outcomes too. A repeated tool call never silently spends again.
    let job = this.jobs.get(key)
    if (!job) {
      job = start()
      this.jobs.set(key, job)
    }
    let abortObserver = () => {}
    try {
      const value = signal
        ? await new Promise<WebResearchResult>((resolve, reject) => {
            abortObserver = () => reject(new WebResearchError('cancelled'))
            signal.addEventListener('abort', abortObserver, { once: true })
            job!.then(resolve, reject)
          })
        : await job
      if (signal?.aborted) throw new WebResearchError('cancelled')
      return this.result(value.sources.map((source) => this.sources.get(source.sourceId) ?? source))
    } finally {
      signal?.removeEventListener('abort', abortObserver)
    }
  }
  search(input: { year?: number }, signal?: AbortSignal): Promise<WebResearchResult> {
    const parsed = z.strictObject({ year: z.number().int().optional() }).safeParse(input)
    if (
      !parsed.success ||
      (parsed.data.year !== undefined && !this.scope.years.includes(parsed.data.year))
    )
      return Promise.reject(new WebResearchError('scope'))
    const query = buildWebResearchQuery(this.scope, parsed.data.year)
    return this.job(`search:${query}`, signal, async () => {
      if (this.searchesUsed >= WEB_RESEARCH_LIMITS.searches) throw new WebResearchError('budget')
      this.searchesUsed++
      const raw = await this.read(
        `${WEB_RESEARCH_ENDPOINT}/search`,
        'POST',
        {
          query,
          search_depth: 'basic',
          auto_parameters: false,
          topic: 'general',
          chunks_per_source: 1,
          max_results: WEB_RESEARCH_LIMITS.resultsPerSearch,
          include_answer: false,
          include_raw_content: false,
          include_images: false,
          include_favicon: false,
          include_usage: true,
        },
        signal,
      )
      if (signal?.aborted) throw new WebResearchError('cancelled')
      let envelope: z.infer<typeof searchEnvelope>
      try {
        envelope = searchEnvelope.parse(JSON.parse(raw.text))
      } catch {
        throw new WebResearchError('response')
      }
      const sources: WebResearchSource[] = []
      for (const item of envelope.results.slice(0, WEB_RESEARCH_LIMITS.resultsPerSearch)) {
        let url: string
        try {
          url = canonicalPublicResearchUrl(item.url)
        } catch {
          continue
        }
        const next = {
          title: cleanText(item.title, 200) || new URL(url).hostname,
          url,
          excerpt: cleanText(item.content, WEB_RESEARCH_LIMITS.excerptCharacters),
          retrievedAt: new Date().toISOString(),
          retrieved: true,
          yearEvidence: [] as WebResearchSource['yearEvidence'],
          provenance: 'tavily-search' as const,
          untrusted: true as const,
          verification: 'unverified' as const,
        }
        next.yearEvidence = yearsIn(next, this.scope.years)
        sources.push(this.addSource(next))
      }
      if (envelope.usage)
        this.reportedCredits = (this.reportedCredits ?? 0) + envelope.usage.credits
      return this.result([...new Map(sources.map((source) => [source.sourceId, source])).values()])
    })
  }
  fetch(input: { sourceId: string }, signal?: AbortSignal): Promise<WebResearchResult> {
    const parsed = z.strictObject({ sourceId: z.string().max(100) }).safeParse(input)
    const source = parsed.success ? this.sources.get(parsed.data.sourceId) : undefined
    if (!source) return Promise.reject(new WebResearchError('url'))
    return this.job(`fetch:${source.sourceId}`, signal, async () => {
      if (this.fetchesUsed >= WEB_RESEARCH_LIMITS.fetches) throw new WebResearchError('budget')
      this.fetchesUsed++
      const raw = await this.read(source.url, 'GET', undefined, signal)
      if (signal?.aborted) throw new WebResearchError('cancelled')
      const page = pageText(raw.text, raw.html)
      const next = {
        ...source,
        title: page.title || source.title,
        excerpt: page.text,
        retrievedAt: new Date().toISOString(),
        retrieved: true,
        provenance: 'direct-fetch' as const,
      }
      next.yearEvidence = yearsIn(next, this.scope.years)
      return this.result([this.addSource(next)])
    })
  }
}
