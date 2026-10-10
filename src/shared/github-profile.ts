/** Public display information only. This is not authentication or verified account ownership. */
export interface GitHubDisplayProfile {
  login: string
  name: string | null
  avatarDataUrl: string | null
}
