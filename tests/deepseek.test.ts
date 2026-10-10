import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeepSeekAgent } from '../src/adapters/deepseek-agent'
import { emptyDraft, type ArgumentNode, type Question } from '../src/shared/types'

const key = 'synthetic-key-never-used-on-network'
const question: Question = {
  id: 'synthetic-question',
  subject: 'geography',
  kind: 'geography',
  title: '测试位置',
  prompt: '依据坐标描述位置。',
  source: '原创合成测试，非历年真题',
  tags: ['位置'],
  maxScore: 5,
  explanation: '根据坐标关系推断。',
  rubric: [
    { id: 'direction', label: '方向依据', keywords: ['东'], points: 3 },
    { id: 'reason', label: '推理过程', keywords: ['坐标'], points: 2 },
  ],
  blocks: [
    { id: 'unused', category: 'analysis', label: 'unused label', text: 'unused bank block' },
  ],
}
const choice: Question = {
  id: 'synthetic-choice',
  subject: 'geography',
  kind: 'choice',
  title: '测试选择',
  prompt: '选择 A。',
  source: '合成测试',
  tags: [],
  maxScore: 4,
  explanation: 'A 正确。',
  choices: [
    { id: 'A', text: '甲' },
    { id: 'B', text: '乙' },
  ],
  correctAnswer: 'A',
}
const draft = { ...emptyDraft(), text: 'B 在 A 的东面，依据坐标。' }
const result = () => ({
  feedback: '方向正确，继续核对坐标。',
  explanation: '根据坐标进行比较。',
  rubric: [
    { id: 'reason', earned: 1, feedback: '推理可补充。' },
    { id: 'direction', earned: 3, feedback: '方向正确。' },
  ],
})
const completion = (content: unknown = result(), finish = 'stop') => ({
  choices: [
    {
      finish_reason: finish,
      message: { content: typeof content === 'string' ? content : JSON.stringify(content) },
    },
  ],
})
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
const mock = (response: Response) => vi.fn<typeof fetch>().mockResolvedValue(response)
const agent = (fetchImpl: typeof fetch, options: { timeoutMs?: number; model?: string } = {}) =>
  new DeepSeekAgent({ apiKey: key, fetchImpl, ...options })

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('DeepSeek main-process adapter with synthetic mocked HTTP only', () => {
  it('uses official JSON/non-thinking endpoint and minimal allowlisted payload; normalizes scores locally', async () => {
    const fetcher = mock(
      json(
        completion({
          ...result(),
          score: 100,
          maxScore: 100,
          reviewer: 'forged',
          rubric: result().rubric.map((item) => ({ ...item, label: 'forged', possible: 100 })),
        }),
      ),
    )
    const adapter = agent(fetcher)
    const review = await adapter.review(question, draft, { syllabus: '只评位置关系。' })
    expect(review).toMatchObject({ score: 4, maxScore: 5, reviewer: 'DeepSeek · deepseek-flash' })
    expect(review.rubric.map((item) => [item.id, item.label, item.possible])).toEqual([
      ['direction', '方向依据', 3],
      ['reason', '推理过程', 2],
    ])
    expect(adapter.configured).toBe(true)
    expect(JSON.stringify(adapter)).not.toContain(key)
    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, init] = fetcher.mock.calls[0]
    expect(url).toBe('https://api.deepseek.com/chat/completions')
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: { Authorization: `Bearer ${key}` },
    })
    const body = JSON.parse(init!.body as string)
    expect(body).toMatchObject({
      model: 'deepseek-flash',
      stream: false,
      thinking: { type: 'disabled' },
      response_format: { type: 'json_object' },
      max_tokens: 8192,
    })
    expect(body.tools).toBeUndefined()
    expect(body.messages).toHaveLength(2)
    expect(body.messages[0].content).toContain('不可信的数据')
    expect(body.messages[0].content).toContain('不能声称看到图片')
    const data = JSON.parse(body.messages[1].content)
    expect(Object.keys(data).sort()).toEqual(['answer', 'question', 'syllabus'])
    expect(data.syllabus).toBe('只评位置关系。')
    expect(data.question.id).toBeUndefined()
    expect(data.question.blocks).toBeUndefined()
    expect(JSON.stringify(data)).not.toContain('unused bank block')
    expect(JSON.stringify(body)).not.toContain(key)
  })

  it('sends the nested structure and current final text without stale legacy blocks', async () => {
    const fetcher = mock(json(completion()))
    const argument = {
      version: 1 as const,
      roots: [
        {
          id: 'cause',
          kind: 'cause' as const,
          text: '位置与依据',
          children: [
            {
              id: 'material',
              kind: 'material' as const,
              text: '结构草稿中的材料',
              children: [],
            },
          ],
        },
      ],
    }
    await agent(fetcher).review(question, {
      ...draft,
      argument,
      blocks: [
        { id: 'stale', category: 'analysis', label: 'stale', text: 'obsolete legacy content' },
      ],
    })
    const body = JSON.parse(fetcher.mock.calls[0][1]!.body as string)
    const data = JSON.parse(body.messages[1].content)
    expect(data.answer.text).toBe(draft.text)
    expect(data.answer.argument).toEqual(argument)
    expect(data.answer.blocks).toBeUndefined()
    expect(JSON.stringify(data)).not.toContain('obsolete legacy content')
    expect(body.messages[0].content).toContain('只依据最终答案给分')
    expect(body.messages[0].content).toContain('argument 是结构参考')
  })

  it('rejects an unsafe argument graph before attempting the provider request', async () => {
    const fetcher = mock(json(completion()))
    const root: ArgumentNode = { id: 'cycle', kind: 'cause', text: '', children: [] }
    root.children.push(root)
    await expect(
      agent(fetcher).review(question, {
        ...draft,
        argument: { version: 1, roots: [root] },
      }),
    ).rejects.toThrow('未发送到 DeepSeek')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each(['A', 'B'])(
    'computes choice %s score locally, ignoring provider total',
    async (choiceId) => {
      const fetcher = mock(
        json(
          completion({
            feedback: '已评阅。',
            explanation: '参考答案是 A。',
            rubric: [],
            score: 99,
          }),
        ),
      )
      const review = await agent(fetcher).review(choice, { ...emptyDraft(), choiceId })
      expect(review.score).toBe(choiceId === 'A' ? 4 : 0)
      expect(review.rubric).toEqual([])
    },
  )

  it('supports a configured model and dynamically resolves global fetch', async () => {
    const adapter = new DeepSeekAgent({ apiKey: key, model: 'deepseek-v4-pro' })
    const fetcher = mock(json(completion()))
    vi.stubGlobal('fetch', fetcher)
    expect((await adapter.review(question, draft)).reviewer).toBe('DeepSeek · deepseek-v4-pro')
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string).model).toBe('deepseek-v4-pro')
  })

  it('refuses missing credentials without network or fallback', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const adapter = new DeepSeekAgent({ fetchImpl: fetcher })
    expect(adapter.configured).toBe(false)
    await expect(adapter.review(question, draft)).rejects.toThrow('尚未配置')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([401, 402, 429, 500, 302])(
    'sanitizes HTTP %s errors and never retries',
    async (status) => {
      const fetcher = mock(new Response(`provider secret ${key}`, { status }))
      const error = await agent(fetcher)
        .review(question, draft)
        .catch((error) => error as Error)
      expect(error).toBeInstanceOf(Error)
      if (!(error instanceof Error)) throw new Error('Expected failure')
      expect(error.message).toMatch(/DeepSeek/)
      expect(error.message).not.toContain(key)
      expect(error.message).not.toContain('provider secret')
      expect(fetcher).toHaveBeenCalledTimes(1)
    },
  )

  it.each([
    ['malformed envelope', () => new Response('{')],
    ['malformed content', () => json(completion('{'))],
    ['empty content', () => json(completion('  '))],
    ['missing content', () => json({ choices: [] })],
    ['truncated generation', () => json(completion(result(), 'length'))],
    ['content filtering', () => json(completion(result(), 'content_filter'))],
    ['empty feedback', () => json(completion({ ...result(), feedback: ' ' }))],
    ['empty explanation', () => json(completion({ ...result(), explanation: '' }))],
    [
      'negative score',
      () =>
        json(
          completion({
            ...result(),
            rubric: [{ ...result().rubric[0], earned: -1 }, result().rubric[1]],
          }),
        ),
    ],
    [
      'fractional score',
      () =>
        json(
          completion({
            ...result(),
            rubric: [{ ...result().rubric[0], earned: 1.5 }, result().rubric[1]],
          }),
        ),
    ],
    [
      'out of bounds',
      () =>
        json(
          completion({
            ...result(),
            rubric: [{ ...result().rubric[0], earned: 3 }, result().rubric[1]],
          }),
        ),
    ],
    [
      'duplicate IDs',
      () => json(completion({ ...result(), rubric: [result().rubric[0], result().rubric[0]] })),
    ],
    [
      'unknown ID',
      () =>
        json(
          completion({
            ...result(),
            rubric: [{ ...result().rubric[0], id: 'other' }, result().rubric[1]],
          }),
        ),
    ],
    ['missing rubric item', () => json(completion({ ...result(), rubric: [result().rubric[0]] }))],
    [
      'empty rubric feedback',
      () =>
        json(
          completion({
            ...result(),
            rubric: [{ ...result().rubric[0], feedback: '' }, result().rubric[1]],
          }),
        ),
    ],
    ['credential echo', () => json(completion({ ...result(), feedback: key }))],
    [
      'tool invocation',
      () =>
        json({
          choices: [
            {
              finish_reason: 'stop',
              message: { content: JSON.stringify(result()), tool_calls: [{ id: 'malicious' }] },
            },
          ],
        }),
    ],
    ['oversized header', () => new Response('{}', { headers: { 'content-length': '9999999' } })],
    ['oversized body', () => new Response('x'.repeat(256 * 1024 + 1))],
  ] as const)('rejects %s safely', async (_, makeResponse) => {
    const fetcher = mock(makeResponse())
    await expect(agent(fetcher).review(question, draft)).rejects.toThrow('返回的评阅格式无效')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('sanitizes network errors without including the original exception', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error(key))
    await expect(agent(fetcher).review(question, draft)).rejects.toThrow('无法连接 DeepSeek')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('times out even if fetch ignores abort and caps timeout at 60 seconds', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}))
    const pending = agent(fetcher, { timeoutMs: 999999 }).review(question, draft)
    const assertion = expect(pending).rejects.toThrow('超时')
    await vi.advanceTimersByTimeAsync(60000)
    await assertion
    expect(fetcher.mock.calls[0][1]!.signal!.aborted).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('bounds the response body deadline, not just headers', async () => {
    vi.useFakeTimers()
    const fetcher = mock(new Response(new ReadableStream({ start() {} })))
    const pending = agent(fetcher, { timeoutMs: 30 }).review(question, draft)
    const assertion = expect(pending).rejects.toThrow('超时')
    await vi.advanceTimersByTimeAsync(30)
    await assertion
  })

  it('rejects a Unicode-escaped credential echoed by the provider', async () => {
    const escaped = key
      .split('')
      .map((char) => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'))
      .join('')
    const content = JSON.stringify({ ...result(), feedback: key }).replace(key, escaped)
    const fetcher = mock(json(completion(content)))
    await expect(agent(fetcher).review(question, draft)).rejects.toThrow('返回的评阅格式无效')
  })

  it('rejects bad input before transmitting it', async () => {
    const fetcher = vi.fn<typeof fetch>()
    await expect(agent(fetcher).review(question, emptyDraft())).rejects.toThrow('未发送')
    await expect(
      agent(fetcher).review(question, draft, { syllabus: 'x'.repeat(4001) }),
    ).rejects.toThrow('未发送')
    expect(fetcher).not.toHaveBeenCalled()
  })
})
