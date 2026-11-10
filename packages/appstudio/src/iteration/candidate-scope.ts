export interface CandidateEditScope {
  entry: string
  sourceRoots: readonly string[]
  sourceExtensions: readonly string[]
  assetRoots: readonly string[]
  protectedPaths: readonly string[]
}

const assetExtensions = ['.json', '.svg', '.txt']

export function candidatePathEditable(path: string, scope: CandidateEditScope): boolean {
  if (scope.protectedPaths.some(protectedPath => protectedPath.toLowerCase() === path.toLowerCase())) return false
  const matches = (roots: readonly string[], extensions: readonly string[]) =>
    roots.some(root => path.startsWith(root + '/')) && extensions.some(extension => path.endsWith(extension))
  return path === scope.entry || matches(scope.sourceRoots, scope.sourceExtensions) || matches(scope.assetRoots, assetExtensions)
}
