import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdtemp, open, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { MAX_KNOWLEDGE_PDF_BYTES } from '../shared/knowledge'
import {
  canceledKnowledgePackImport,
  KNOWLEDGE_PACK_MANIFEST_NAME,
  knowledgePackManifestSchema,
  MAX_KNOWLEDGE_PACK_BYTES,
  MAX_KNOWLEDGE_PACK_MANIFEST_BYTES,
  type KnowledgePackDocument,
  type KnowledgePackImportResult,
} from '../shared/knowledge-pack'
import { KnowledgeLibraryError, type LocalKnowledgeLibrary } from './knowledge-library'

const PACK_MESSAGES: Record<string, string> = {
  PACK_MANIFEST_INVALID: '知识包清单无效：请选择包含 1–12 份 PDF 的 pack.json',
  PACK_FILE_INVALID: '知识包只能读取同目录的普通 PDF 文件，不能使用文件链接',
  PACK_FILE_MISSING: '知识包缺少这份 PDF，请保持清单与原始 PDF 在同一文件夹',
  PACK_FILE_CHANGED: '知识包文件在读取时发生变化，请重新选择完整知识包',
  PACK_HASH_MISMATCH: 'PDF 的 SHA-256 与清单不一致，尚未导入任何新文档',
  PACK_PART_MISMATCH: 'PDF 分片的长度或 SHA-256 与清单不一致，尚未导入任何新文档',
  PACK_SIZE_LIMIT: '知识包总大小不能超过 300 MiB，单份 PDF 不能超过 50 MiB',
  PACK_STORAGE_FAILED: '无法读取或暂存知识包，请检查文件与可用磁盘空间后重试',
  PACK_CANCELED: '已取消知识包导入',
}

export class KnowledgePackError extends Error {
  constructor(readonly code: string) {
    super(PACK_MESSAGES[code] ?? PACK_MESSAGES.PACK_STORAGE_FAILED)
    this.name = 'KnowledgePackError'
  }
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new KnowledgePackError('PACK_CANCELED')
}
function isCanceled(error: unknown): boolean {
  return (
    (error instanceof KnowledgePackError && error.code === 'PACK_CANCELED') ||
    (error instanceof KnowledgeLibraryError && error.code === 'PDF_CANCELED')
  )
}
function safeError(error: unknown): string {
  // Native errors contain user paths. Never return those, parser stacks, or raw JSON over IPC.
  if (error instanceof KnowledgePackError || error instanceof KnowledgeLibraryError)
    return error.message
  if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
    return PACK_MESSAGES.PACK_FILE_MISSING
  return PACK_MESSAGES.PACK_STORAGE_FAILED
}

/** Reject links/devices before opening, then compare the opened file identity to close swap races. */
async function openRegular(path: string, maximum: number) {
  const before = await lstat(path)
  if (!before.isFile() || before.nlink !== 1) throw new KnowledgePackError('PACK_FILE_INVALID')
  if (before.size < 1 || before.size > maximum) throw new KnowledgePackError('PACK_SIZE_LIMIT')
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  )
  try {
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    )
      throw new KnowledgePackError('PACK_FILE_INVALID')
    if (opened.size !== before.size || opened.mtimeMs !== before.mtimeMs)
      throw new KnowledgePackError('PACK_FILE_CHANGED')
    return { handle, info: opened }
  } catch (error) {
    await handle.close()
    throw error
  }
}

async function readManifest(path: string, signal?: AbortSignal) {
  abortIfNeeded(signal)
  const { handle, info } = await openRegular(path, MAX_KNOWLEDGE_PACK_MANIFEST_BYTES)
  try {
    const bytes = Buffer.alloc(info.size + 1)
    let length = 0
    while (length < bytes.length) {
      abortIfNeeded(signal)
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length !== info.size) throw new KnowledgePackError('PACK_FILE_CHANGED')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))
    return knowledgePackManifestSchema.parse(JSON.parse(text))
  } finally {
    await handle.close()
  }
}

/** Size/link preflight avoids reading hundreds of MiB when the pack is already invalid. */
async function measurePdf(
  root: string,
  entry: KnowledgePackDocument,
  remaining: number,
  signal?: AbortSignal,
): Promise<number> {
  let length = 0
  for (const source of entry.parts ?? [{ file: entry.file }]) {
    abortIfNeeded(signal)
    const { handle, info } = await openRegular(
      join(root, source.file),
      Math.min(MAX_KNOWLEDGE_PDF_BYTES - length, remaining - length),
    )
    try {
      if ('byteLength' in source && info.size !== source.byteLength)
        throw new KnowledgePackError('PACK_PART_MISMATCH')
      length += info.size
    } finally {
      await handle.close()
    }
  }
  return length
}

/** Stream validated bytes into private staging so later source edits cannot change the imported pack. */
async function stagePdf(
  root: string,
  entry: KnowledgePackDocument,
  target: string,
  remaining: number,
  signal?: AbortSignal,
): Promise<number> {
  abortIfNeeded(signal)
  const staged = await open(target, 'wx', 0o600)
  try {
    const hash = createHash('sha256')
    const buffer = Buffer.alloc(64 * 1024)
    let length = 0
    let header = Buffer.alloc(0)
    const sources = entry.parts ?? [{ file: entry.file, sha256: entry.sha256 }]
    for (const source of sources) {
      abortIfNeeded(signal)
      const { handle, info } = await openRegular(
        join(root, source.file),
        Math.min(MAX_KNOWLEDGE_PDF_BYTES - length, remaining - length),
      )
      try {
        if ('byteLength' in source && info.size !== source.byteLength)
          throw new KnowledgePackError('PACK_PART_MISMATCH')
        const partHash = createHash('sha256')
        let partLength = 0
        while (true) {
          abortIfNeeded(signal)
          // Read one additional byte to detect growth without allocating unbounded input.
          const available = Math.min(buffer.length, info.size + 1 - partLength)
          const { bytesRead } = await handle.read(buffer, 0, available, partLength)
          if (!bytesRead) break
          partLength += bytesRead
          if (partLength > info.size) throw new KnowledgePackError('PACK_FILE_CHANGED')
          length += bytesRead
          const bytes = buffer.subarray(0, bytesRead)
          if (header.length < 5)
            header = Buffer.concat([header, bytes.subarray(0, 5 - header.length)])
          hash.update(bytes)
          partHash.update(bytes)
          await staged.writeFile(bytes)
        }
        const after = await handle.stat()
        if (partLength !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs)
          throw new KnowledgePackError('PACK_FILE_CHANGED')
        if (partHash.digest('hex') !== source.sha256)
          throw new KnowledgePackError(entry.parts ? 'PACK_PART_MISMATCH' : 'PACK_HASH_MISMATCH')
      } finally {
        await handle.close()
      }
    }
    if (header.toString('ascii') !== '%PDF-') throw new KnowledgeLibraryError('PDF_INVALID')
    if (hash.digest('hex') !== entry.sha256) throw new KnowledgePackError('PACK_HASH_MISMATCH')
    abortIfNeeded(signal)
    return length
  } finally {
    await staged.close()
  }
}

async function readStagedPdf(path: string, expectedHash: string, signal?: AbortSignal) {
  abortIfNeeded(signal)
  const { handle, info } = await openRegular(path, MAX_KNOWLEDGE_PDF_BYTES)
  try {
    const bytes = Buffer.alloc(info.size + 1)
    let length = 0
    while (length < bytes.length) {
      abortIfNeeded(signal)
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    const source = bytes.subarray(0, length)
    if (length !== info.size || createHash('sha256').update(source).digest('hex') !== expectedHash)
      throw new KnowledgePackError('PACK_FILE_CHANGED')
    abortIfNeeded(signal)
    return source
  } finally {
    await handle.close()
  }
}

/**
 * Trusted main-process boundary: path MUST come from a native file picker, never renderer input.
 * A pack is a directory plus pack.json; archives, links and remote URLs are not supported.
 * Preflight is all-or-nothing. Parsing/commits are deliberately atomic per document, not per pack.
 */
export async function importKnowledgePackFromSelectedManifest(
  path: string,
  library: Pick<LocalKnowledgeLibrary, 'importBytes'>,
  options: { signal?: AbortSignal } = {},
): Promise<KnowledgePackImportResult> {
  if (options.signal?.aborted) return canceledKnowledgePackImport()
  let manifest
  let root: string
  try {
    if (!isAbsolute(path) || basename(path) !== KNOWLEDGE_PACK_MANIFEST_NAME)
      throw new KnowledgePackError('PACK_MANIFEST_INVALID')
    const selectedRoot = dirname(path)
    if (!(await lstat(selectedRoot)).isDirectory())
      throw new KnowledgePackError('PACK_FILE_INVALID')
    root = await realpath(selectedRoot)
    manifest = await readManifest(join(root, KNOWLEDGE_PACK_MANIFEST_NAME), options.signal)
  } catch (error) {
    if (isCanceled(error)) return canceledKnowledgePackImport()
    if (error instanceof KnowledgePackError) throw error
    throw new KnowledgePackError('PACK_MANIFEST_INVALID')
  }

  const result: KnowledgePackImportResult = {
    ...canceledKnowledgePackImport(),
    canceled: false,
    packTitle: manifest.title,
    items: manifest.documents.map(({ file, title, subject }) => ({
      file,
      title,
      subject,
      status: 'pending',
    })),
  }
  let staging: string | undefined
  try {
    abortIfNeeded(options.signal)
    let measured = 0
    for (const [index, entry] of manifest.documents.entries()) {
      try {
        measured += await measurePdf(
          root,
          entry,
          MAX_KNOWLEDGE_PACK_BYTES - measured,
          options.signal,
        )
      } catch (error) {
        if (isCanceled(error)) throw error
        result.items[index].status = 'failed'
        result.items[index].error = safeError(error)
        result.failedCount++
      }
    }
    if (result.failedCount) return result
    // mkdtemp creates an owner-only directory; sources are never edited or stripped of watermarks.
    staging = await mkdtemp(join(tmpdir(), 'examcraft-private-pack-'))
    let total = 0
    for (const [index, entry] of manifest.documents.entries()) {
      try {
        total += await stagePdf(
          root,
          entry,
          join(staging, `${index}.pdf`),
          MAX_KNOWLEDGE_PACK_BYTES - total,
          options.signal,
        )
      } catch (error) {
        if (isCanceled(error)) throw error
        await rm(join(staging, `${index}.pdf`), { force: true })
        result.items[index].status = 'failed'
        result.items[index].error = safeError(error)
        result.failedCount++
      }
    }
    // A missing/changed/unverified file must not cause an unintended partial pack import.
    if (result.failedCount) return result
    abortIfNeeded(options.signal)
    result.validationPassed = true

    for (const [index, entry] of manifest.documents.entries()) {
      try {
        abortIfNeeded(options.signal)
        const bytes = await readStagedPdf(
          join(staging, `${index}.pdf`),
          entry.sha256,
          options.signal,
        )
        const imported = await library.importBytes(entry.title, bytes, {
          signal: options.signal,
          subject: entry.subject,
          edition: entry.edition,
          editionConfirmed: entry.editionConfirmed,
        })
        if (imported.canceled) throw new KnowledgePackError('PACK_CANCELED')
        // A late cancel after commit must report the saved item before stopping the next one.
        result.items[index].status = imported.duplicate ? 'duplicate' : 'imported'
        result.items[index].documentId = imported.document.id
        result.documents.push(imported.document)
        if (imported.duplicate) result.duplicateCount++
        else result.importedCount++
      } catch (error) {
        if (isCanceled(error)) throw error
        result.items[index].status = 'failed'
        result.items[index].error = safeError(error)
        result.failedCount++
      }
    }
    return result
  } catch (error) {
    if (isCanceled(error)) {
      result.canceled = true
      return result
    }
    throw new KnowledgePackError('PACK_STORAGE_FAILED')
  } finally {
    if (staging) {
      try {
        await rm(staging, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 })
      } catch {
        // Report saved documents truthfully even if the OS prevents temporary-file cleanup.
        result.warning = '导入结果已保留，但系统未能清理私有临时副本，请检查可用磁盘空间。'
      }
    }
  }
}
