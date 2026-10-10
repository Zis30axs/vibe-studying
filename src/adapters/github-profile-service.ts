import { join } from 'node:path'
import { z } from 'zod'
import { AtomicJsonStore } from './atomic-json-store'
import type { GitHubDisplayProfile } from '../shared/github-profile'

class ProfileError extends Error {}

const usernamePattern = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i
const MAX_PROFILE_BYTES = 64 * 1024
const MAX_AVATAR_BYTES = 512 * 1024
const avatarDataPattern = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z\d+/]+={0,2}$/
const profileSchema = z
  .object({
    login: z.string().regex(usernamePattern),
    name: z.string().max(100).nullable(),
    avatarDataUrl: z.string().max(700_000).regex(avatarDataPattern).nullable(),
  })
  .strict()
  .nullable()

function username(input: unknown): string {
  if (typeof input !== 'string' || !usernamePattern.test(input.trim()))
    throw new ProfileError('请输入有效的 GitHub 用户名（1–39 位字母、数字或单个连字符）。')
  return input.trim()
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new ProfileError('获取 GitHub 资料超时，请重试。'))
    if (signal.aborted) {
      void work.catch(() => undefined)
      abort()
      return
    }
    signal.addEventListener('abort', abort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

async function boundedBody(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const length = response.headers.get('content-length')
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) {
    void response.body?.cancel().catch(() => undefined)
    throw new ProfileError('GitHub 返回的数据过大。')
  }
  if (!response.body) throw new ProfileError('GitHub 返回了空响应。')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await abortable(reader.read(), signal)
      if (next.done) break
      size += next.value.byteLength
      if (size > limit) throw new ProfileError('GitHub 返回的数据过大。')
      chunks.push(next.value)
    }
  } finally {
    void reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  return Buffer.concat(chunks)
}

function avatarEndpoint(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'avatars.githubusercontent.com' ||
      url.port ||
      url.username ||
      url.password ||
      !/^\/u\/\d+$/.test(url.pathname)
    )
      return null
    // Never forward arbitrary API-provided hosts, paths, or query parameters.
    return `https://avatars.githubusercontent.com${url.pathname}?s=128`
  } catch {
    return null
  }
}

function rasterType(bytes: Uint8Array): string | null {
  const data = Buffer.from(bytes)
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png'
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'jpeg'
  if (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP')
    return 'webp'
  return null
}

/** Main process only. No OAuth, tokens, private APIs, or ownership verification. */
export class GitHubProfileService {
  private readonly store: AtomicJsonStore<GitHubDisplayProfile | null>
  constructor(
    directory: string,
    private readonly fetcher: typeof fetch = (...args) => fetch(...args),
  ) {
    this.store = new AtomicJsonStore(
      join(directory, 'github-display-profile.json'),
      profileSchema,
      () => null,
    )
  }
  get(): Promise<GitHubDisplayProfile | null> {
    return this.store.load()
  }
  async clear(): Promise<void> {
    await this.store.update(() => null)
  }
  bind(input: unknown): Promise<GitHubDisplayProfile> {
    const requested = username(input)
    return this.store
      .update(async () => {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 10_000)
        try {
          const response = await abortable(
            this.fetcher(`https://api.github.com/users/${requested}`, {
              headers: {
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2026-03-10',
                'User-Agent': 'ExamCraft',
              },
              redirect: 'error',
              credentials: 'omit',
              signal: controller.signal,
            }),
            controller.signal,
          )
          if (!response.ok) void response.body?.cancel().catch(() => undefined)
          if (response.status === 404)
            throw new ProfileError('未找到此 GitHub 用户，请检查用户名。')
          if (response.status === 403 || response.status === 429)
            throw new ProfileError('GitHub 请求暂时受限，请稍后再试。')
          if (!response.ok) throw new ProfileError('GitHub 暂时无法访问，请稍后再试。')
          const raw: unknown = JSON.parse(
            Buffer.from(await boundedBody(response, MAX_PROFILE_BYTES, controller.signal)).toString(
              'utf8',
            ),
          )
          if (!raw || typeof raw !== 'object') throw new ProfileError('GitHub 资料格式无效。')
          const data = raw as Record<string, unknown>
          const login = username(data.login)
          if (login.toLowerCase() !== requested.toLowerCase())
            throw new ProfileError('返回的 GitHub 用户名不一致，请检查后重试。')
          const name =
            typeof data.name === 'string'
              ? data.name
                  .replace(/[\u0000-\u001f\u007f]/g, '')
                  .trim()
                  .slice(0, 100) || null
              : null
          let avatarDataUrl: string | null = null
          const endpoint = avatarEndpoint(data.avatar_url)
          if (endpoint) {
            try {
              const avatar = await abortable(
                this.fetcher(endpoint, {
                  redirect: 'error',
                  credentials: 'omit',
                  signal: controller.signal,
                }),
                controller.signal,
              )
              if (avatar.ok) {
                const bytes = await boundedBody(avatar, MAX_AVATAR_BYTES, controller.signal)
                const format = rasterType(bytes)
                if (format)
                  avatarDataUrl = `data:image/${format};base64,${Buffer.from(bytes).toString('base64')}`
              }
            } catch {
              /* Public name remains useful with an offline/local initials fallback. */
            }
          }
          return { login, name, avatarDataUrl }
        } catch (error) {
          if (error instanceof ProfileError) throw error
          throw new ProfileError('无法获取 GitHub 公开资料，请检查网络后重试。')
        } finally {
          clearTimeout(timer)
        }
      })
      .then((profile) => profile!)
  }
}
