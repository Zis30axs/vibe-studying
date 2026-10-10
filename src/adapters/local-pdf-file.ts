import { open } from 'node:fs/promises'

/** Only call with a path returned by the native user-controlled file picker. */
export async function readSelectedPdf(
  path: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  signal?.throwIfAborted()
  const file = await open(path, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size < 5 || info.size > maxBytes)
      throw new Error('请选择大小在允许范围内的普通 PDF 文件。')
    const buffer = Buffer.alloc(Math.min(info.size + 1, maxBytes + 1))
    let total = 0
    while (total < buffer.length) {
      signal?.throwIfAborted()
      const { bytesRead } = await file.read(buffer, total, buffer.length - total, null)
      if (!bytesRead) break
      total += bytesRead
    }
    if (total !== info.size) throw new Error('PDF 文件在读取时发生变化，请重新选择。')
    signal?.throwIfAborted()
    return new Uint8Array(buffer.subarray(0, total))
  } finally {
    await file.close()
  }
}
