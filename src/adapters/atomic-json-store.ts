import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { z } from 'zod'

export const MAX_JSON_BYTES = 8 * 1024 * 1024

export async function readJsonFile(filePath: string): Promise<unknown> {
  // Open once so validation and reading refer to the same selected file.
  const handle = await open(filePath, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > MAX_JSON_BYTES)
      throw new Error('只支持不超过 8 MiB 的 JSON 文件')
    const content = await handle.readFile({ encoding: 'utf8' })
    if (Buffer.byteLength(content) > MAX_JSON_BYTES) throw new Error('JSON 文件超过 8 MiB')
    return JSON.parse(content.replace(/^\uFEFF/, '')) as unknown
  } finally {
    await handle.close()
  }
}

/** One instance per file, one desktop process. Updates serialize the whole read/modify/write. */
export class AtomicJsonStore<T> {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(
    readonly filePath: string,
    private readonly schema: z.ZodType<T>,
    private readonly initial: () => T,
  ) {}

  private serialize<R>(operation: () => Promise<R>): Promise<R> {
    const result = this.queue.then(operation)
    this.queue = result.catch(() => undefined)
    return result
  }

  private async read(): Promise<T> {
    try {
      return this.schema.parse(await readJsonFile(this.filePath))
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
        return this.schema.parse(this.initial())
      throw new Error(
        `无法读取学习数据：${this.filePath}。原文件未被覆盖；请保留该文件并修复格式或从备份恢复。`,
        { cause: error },
      )
    }
  }

  load(): Promise<T> {
    return this.serialize(() => this.read())
  }

  update(update: (value: T) => T | Promise<T>): Promise<T> {
    return this.serialize(async () => {
      const current = await this.read()
      const next = this.schema.parse(await update(current))
      const content = JSON.stringify(next, null, 2)
      if (Buffer.byteLength(content) > MAX_JSON_BYTES)
        throw new Error('数据已达到 8 MiB 上限；本次操作未保存，现有数据保持不变')
      await mkdir(dirname(this.filePath), { recursive: true })
      const temporary = `${this.filePath}.${randomUUID()}.tmp`
      try {
        const handle = await open(temporary, 'wx', 0o600)
        try {
          await handle.writeFile(content, 'utf8')
          await handle.sync()
        } finally {
          await handle.close()
        }
        // Never unlink the previous file: failure keeps its last complete state intact.
        await rename(temporary, this.filePath)
      } finally {
        await unlink(temporary).catch((error) => {
          if (error.code !== 'ENOENT') throw error
        })
      }
      return next
    })
  }
}
