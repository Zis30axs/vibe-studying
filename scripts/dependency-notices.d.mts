export interface LockedPackage {
  version?: string
  dev?: boolean
  optional?: boolean
  license?: string
  optionalDependencies?: Record<string, string>
}
export function collectDependencyNotices(
  root: string,
  packages: Record<string, LockedPackage>,
): Promise<string[]>
