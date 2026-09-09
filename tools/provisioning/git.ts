/**
 * Isolated Git invocation.
 *
 * Every command runs with the ambient system and global configuration
 * disabled, so a fixture built on one workstation is byte-identical to one
 * built on another regardless of the operator's personal Git settings.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { join } from 'node:path'

/** Author and committer identity stamped onto generated fixture commits. */
export const FIXTURE_IDENTITY = {
  name: 'Course Fixture Builder',
  email: 'fixture@example.invalid'
} as const

/** Fixed timestamp so repeated builds of the same input produce equal SHAs. */
export const FIXTURE_EPOCH = 1735689600

export interface GitResult {
  status: number
  stdout: string
  stderr: string
}

/**
 * Builds an environment that ignores system, global and user Git
 * configuration, disables credential and terminal prompts, and pins the commit
 * identity.
 *
 * @param repo Repository directory, used to anchor the throwaway config file.
 * @param timestamp Commit timestamp, in seconds since the Unix epoch.
 * @returns The environment to pass to a Git child process.
 */
export function isolatedGitEnv(
  repo: string,
  timestamp: number = FIXTURE_EPOCH
): NodeJS.ProcessEnv {
  const date = `${timestamp} +0000`

  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(repo, 'absent-global-gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: FIXTURE_IDENTITY.name,
    GIT_AUTHOR_EMAIL: FIXTURE_IDENTITY.email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: FIXTURE_IDENTITY.name,
    GIT_COMMITTER_EMAIL: FIXTURE_IDENTITY.email,
    GIT_COMMITTER_DATE: date
  }
}

export interface GitOptions {
  /** Text piped to the command's standard input. */
  input?: string
  /** Commit timestamp override, in seconds since the Unix epoch. */
  timestamp?: number
  /** Extra environment entries layered over the isolated defaults. */
  env?: NodeJS.ProcessEnv
}

/**
 * Runs a Git command and returns its trimmed standard output.
 *
 * @param repo Repository directory the command runs in.
 * @param args Git arguments, excluding the leading `git`.
 * @param options Input, timestamp and environment overrides.
 * @returns The command's standard output with surrounding whitespace removed.
 * @throws If Git exits with a non-zero status.
 */
export function git(
  repo: string,
  args: string[],
  options: GitOptions = {}
): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    input: options.input,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...isolatedGitEnv(repo, options.timestamp), ...options.env }
  }).trim()
}

/**
 * Runs a Git command without throwing, so callers can inspect a failure.
 *
 * @param repo Repository directory the command runs in.
 * @param args Git arguments, excluding the leading `git`.
 * @param options Input, timestamp and environment overrides.
 * @returns The exit status together with the captured output streams.
 */
export function tryGit(
  repo: string,
  args: string[],
  options: GitOptions = {}
): GitResult {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    input: options.input,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...isolatedGitEnv(repo, options.timestamp), ...options.env }
  })

  if (result.error) throw result.error

  return {
    status: result.status ?? 1,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim()
  }
}

/**
 * Reads a tracked file's contents at a given revision.
 *
 * @param repo Repository directory.
 * @param revision Commit-ish to read from.
 * @param path Repository-relative path of the file.
 * @returns The file contents, or `undefined` when the path is absent.
 */
export function readBlob(
  repo: string,
  revision: string,
  path: string
): string | undefined {
  const result = spawnSync('git', ['-C', repo, 'show', `${revision}:${path}`], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: isolatedGitEnv(repo)
  })

  if (result.error) throw result.error

  return result.status === 0 ? result.stdout : undefined
}

/**
 * Lists the references a remote advertises.
 *
 * @param repo Any repository directory, used only to invoke Git.
 * @param remote Address of the remote.
 * @returns Reference names mapped to the object identifiers they point at.
 */
export function lsRemote(repo: string, remote: string): Record<string, string> {
  const output = git(repo, ['ls-remote', remote])

  if (output === '') return {}

  return Object.fromEntries(
    output.split('\n').map((line) => {
      const [object, ref] = line.split('\t')
      return [ref, object]
    })
  )
}

/**
 * Pushes an explicit set of references to a remote.
 *
 * Deliberately not `git push --mirror`. A maintenance clone accumulates
 * remote-tracking references, and a repository that has been pushed to GitHub
 * accumulates pull request references; a mirror push would carry both, and
 * would also delete anything on the remote that the source lacks. Enumerating
 * the references keeps the transfer additive and bounded.
 *
 * @param repo Repository to push from.
 * @param remote Address of the remote.
 * @param refs Fully qualified reference names to push.
 */
export function pushRefs(repo: string, remote: string, refs: string[]): void {
  if (refs.length === 0)
    throw new Error('Refusing to push an empty reference set')

  git(repo, ['push', remote, ...refs.map((ref) => `${ref}:${ref}`)])
}

/**
 * Lists every reference in a repository as a name to object-identifier map.
 *
 * @param repo Repository directory.
 * @returns Reference names mapped to the object identifiers they point at.
 */
export function listRefs(repo: string): Record<string, string> {
  const output = git(repo, [
    'for-each-ref',
    '--format=%(refname) %(objectname)'
  ])

  if (output === '') return {}

  return Object.fromEntries(
    output.split('\n').map((line) => {
      const separator = line.lastIndexOf(' ')
      return [line.slice(0, separator), line.slice(separator + 1)]
    })
  )
}
