/**
 * Delivery bundle export.
 *
 * A bundle is the handover artifact: inert bytes carrying Git history, which
 * a customer imports into their own tenant. It assumes nothing about their
 * identity provider, their forking policy or their network posture.
 *
 * The reference list is enumerated from the lab contract rather than derived
 * from whatever the working repository happens to hold. A maintenance clone
 * accumulates remote-tracking references, and a repository that has been
 * pushed to GitHub accumulates pull request references; neither belongs in a
 * customer's copy, and neither can reach one through an explicit allow-list.
 */
import { statSync } from 'node:fs'
import { FORBIDDEN_REF_PREFIXES, intendedExportedRefs } from './contract.js'
import { git, listRefs, tryGit } from './git.js'

export interface BundleExport {
  /** Path of the written bundle. */
  path: string
  /** References the bundle carries. */
  refs: string[]
  /** Size of the bundle in bytes. */
  bytes: number
}

/**
 * Lists the references a bundle carries.
 *
 * @param repo Any repository directory, used only to invoke Git.
 * @param bundle Path of the bundle to inspect.
 * @returns Reference names carried by the bundle, sorted.
 */
export function bundleRefs(repo: string, bundle: string): string[] {
  const output = git(repo, ['bundle', 'list-heads', bundle])

  if (output === '') return []

  return output
    .split('\n')
    .map((line) => line.slice(line.indexOf(' ') + 1))
    .sort()
}

export interface BundleOptions {
  /** Repository to export from. */
  repo: string
  /** Path of the bundle to write. */
  output: string
  /** References to export. Defaults to the lab contract's list. */
  refs?: string[]
  /**
   * Whether to record `HEAD` alongside the references. Without it a clone
   * from the bundle has no default branch to check out, and the customer
   * lands in an empty working tree.
   */
  includeHead?: boolean
}

/**
 * Writes a delivery bundle holding exactly the contract's references.
 *
 * @param options Source repository, output path and optional reference list.
 * @returns A description of what was written.
 * @throws If a reference is missing, falls in an excluded namespace, or the
 * written bundle does not carry exactly the requested references.
 */
export function exportBundle(options: BundleOptions): BundleExport {
  const { repo, output } = options
  const refs = [...(options.refs ?? intendedExportedRefs())].sort()
  const includeHead = options.includeHead !== false

  if (refs.length === 0)
    throw new Error('Refusing to export: no references were requested')

  for (const ref of refs)
    for (const prefix of FORBIDDEN_REF_PREFIXES)
      if (ref.startsWith(prefix))
        throw new Error(
          `Refusing to export: ${ref} is in the excluded ${prefix} namespace`
        )

  const present = listRefs(repo)
  const missing = refs.filter((ref) => !(ref in present))

  if (missing.length > 0)
    throw new Error(
      `Refusing to export: the repository has no ${missing.join(', ')}`
    )

  git(repo, [
    'bundle',
    'create',
    output,
    ...(includeHead ? ['HEAD'] : []),
    ...refs
  ])

  const verified = tryGit(repo, ['bundle', 'verify', output])
  if (verified.status !== 0)
    throw new Error(`Bundle verification failed: ${verified.stderr}`)

  const allowed = includeHead ? [...refs, 'HEAD'] : refs
  const written = bundleRefs(repo, output)
  const unexpected = written.filter((ref) => !allowed.includes(ref))

  if (unexpected.length > 0)
    throw new Error(
      `Refusing to hand over a bundle carrying ${unexpected.join(', ')}`
    )

  return { path: output, refs: written, bytes: statSync(output).size }
}
