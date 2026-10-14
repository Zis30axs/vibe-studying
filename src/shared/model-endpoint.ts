/** Normalize an API prefix without restricting its host, port or DNS addresses. */
export function canonicalModelBaseUrl(input: string): string {
  try {
    const url = new URL(input)
    if (
      input.length > 300 ||
      !['http:', 'https:'].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.href.includes('?') ||
      url.href.includes('#')
    )
      throw new Error()
    return url.href.replace(/\/$/, '')
  } catch {
    throw new Error('请输入 HTTP 或 HTTPS Base URL，不含账号、密码、查询参数或片段。')
  }
}
