/**
 * Golden course repository builder.
 *
 * Produces the repository state the labs assume, in an isolated directory,
 * from the imported course history. The builder never modifies its source: it
 * fetches a single reference into a fresh repository and appends to it, so the
 * maintenance clone keeps a healthy `main` while the learner fixture carries
 * the deliberate instructional failure Lab 3 asks the class to find.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BISECT_ANCHOR_TAG,
  BISECT_BAD_SUBJECT,
  BISECT_MARKER,
  BISECT_TARGET,
  CLASS_CONFIG_FILES,
  CONFLICT_BRANCHES,
  DEFAULT_BRANCH,
  GAME_MANAGER,
  HTML_ACTUATOR,
  MAINTENANCE_ONLY_PATHS,
  PLACEHOLDERS,
  REBASE_BRANCH,
  REBASE_BRANCH_POINT,
  REBASE_COMMITS,
  SEEDED_MAIN_COMMITS,
  detectLearnerRefCollisions,
  intendedExportedRefs
} from './contract.js'
import { FIXTURE_EPOCH, git, listRefs, readBlob, tryGit } from './git.js'

/** Files whose presence proves the provenance statement survived the export. */
export const PROVENANCE_FILES = ['LICENSE', 'NOTICE'] as const

/** Name of the throwaway predicate `git bisect run` executes. */
const BISECT_CHECK = 'bisect-check.mjs'

export interface BisectFixture {
  /** Commit the builder introduced the marker at. */
  badCommit: string
  /** Subject line of that commit. */
  badSubject: string
  /** Commit a learner may safely mark `good`. */
  anchorCommit: string
  /** Tag naming that commit. */
  anchorTag: string
  /** Earlier commits in the imported history that changed the marker. */
  priorOccurrences: string[]
  /**
   * Whether marking the repository's root commit `good` also converges on
   * `badCommit`. False when the imported history contains an earlier
   * occurrence of the marker, which gives `git bisect` two boundaries.
   */
  rootAnchorSafe: boolean
}

export interface GoldenFixture {
  /** Directory holding the built repository. */
  path: string
  /** Imported course history tip, before any seeding. */
  baseCommit: string
  /** Seeded `main` tip. */
  headCommit: string
  /** Seeded branch names mapped to their tip commits. */
  branches: Record<string, string>
  /** Every reference present in the built repository. */
  refs: string[]
  bisect: BisectFixture
}

/**
 * Replaces a single literal occurrence of a string, refusing anything else.
 *
 * @param text Text to edit.
 * @param from Literal to replace.
 * @param to Replacement literal.
 * @returns The edited text.
 * @throws If `from` does not occur exactly once.
 */
export function replaceOnce(text: string, from: string, to: string): string {
  const parts = text.split(from)

  if (parts.length !== 2)
    throw new Error(
      `Expected exactly one occurrence of ${JSON.stringify(from)}, found ${
        parts.length - 1
      }`
    )

  return parts.join(to)
}

/**
 * Writes files into the work tree and records them as one commit.
 *
 * @param repo Repository directory.
 * @param subject Commit subject.
 * @param files Repository-relative paths mapped to their new contents.
 * @param timestamp Commit timestamp, in seconds since the Unix epoch.
 * @returns The new commit's object identifier.
 */
function commitFiles(
  repo: string,
  subject: string,
  files: Record<string, string>,
  timestamp: number
): string {
  for (const [path, content] of Object.entries(files))
    writeFileSync(join(repo, path), content)

  git(repo, ['add', '--', ...Object.keys(files)], { timestamp })
  git(repo, ['commit', '--quiet', '-m', subject], { timestamp })

  return git(repo, ['rev-parse', 'HEAD'])
}

/**
 * Rewrites a tracked file through a transform and commits the result.
 *
 * The result is normalised to exactly one trailing newline. Prettier enforces
 * that, and the classroom repository runs `npm run format:check` before it runs
 * its tests, so a generated file ending in a blank line would fail continuous
 * integration on formatting and hide the instructional test failure Lab 3 is
 * built around.
 *
 * @param repo Repository directory.
 * @param subject Commit subject.
 * @param path Repository-relative path of the file to edit.
 * @param edit Transform applied to the file's current contents.
 * @param timestamp Commit timestamp, in seconds since the Unix epoch.
 * @returns The new commit's object identifier.
 */
function commitEdit(
  repo: string,
  subject: string,
  path: string,
  edit: (text: string) => string,
  timestamp: number
): string {
  const current = readBlob(repo, 'HEAD', path)

  if (current === undefined)
    throw new Error(`Cannot edit ${path}: absent at HEAD`)

  return commitFiles(
    repo,
    subject,
    { [path]: `${edit(current).trimEnd()}\n` },
    timestamp
  )
}

/**
 * Line width the repository's Prettier configuration wraps prose to.
 *
 * Kept in step with `printWidth` in `.prettierrc.yml`. A generated Markdown
 * line wider than this is reflowed by `prettier --check`, which fails the
 * `Check Format` step of the classroom repository's own pipeline.
 */
const PRINT_WIDTH = 80

/**
 * Appends a Markdown section, laid out the way Prettier would lay it out.
 *
 * `.prettierrc.yml` sets `proseWrap: always`, so Prettier owns the line breaks
 * in Markdown prose: it joins a hand-wrapped paragraph back onto one line when
 * that line fits, and splits it when it does not. Generated prose is therefore
 * written unwrapped and checked against `printWidth` here, so the fixture
 * cannot emit a paragraph Prettier would rewrite.
 *
 * @param text Current file contents.
 * @param heading Section heading, without the leading `##`.
 * @param prose Paragraph text, as a single unwrapped line.
 * @returns The file contents with the section appended.
 * @throws If a generated line would exceed the configured print width.
 */
function appendMarkdownSection(
  text: string,
  heading: string,
  prose: string
): string {
  const section = `## ${heading}\n\n${prose}`

  for (const line of section.split('\n'))
    if (line.length > PRINT_WIDTH)
      throw new Error(
        `Refusing to build: generated Markdown line is ${line.length} ` +
          `characters, over the ${PRINT_WIDTH}-character print width Prettier ` +
          `enforces, so the classroom repository would fail its own format ` +
          `check: ${JSON.stringify(line)}`
      )

  return `${text.trimEnd()}\n\n${section}\n`
}

/**
 * Creates a fresh repository holding exactly one branch of the source history.
 *
 * Uses an explicit refspec rather than a clone or a mirror, so remote-tracking
 * references, pull request references and incidental working branches in the
 * source cannot leak into the fixture.
 *
 * @param sourceRepo Repository to import from.
 * @param sourceRef Reference in that repository to import.
 * @param target Directory to create.
 * @returns The imported history tip.
 */
function importHistory(
  sourceRepo: string,
  sourceRef: string,
  target: string
): string {
  mkdirSync(target, { recursive: true })

  // Bootstrap on a branch nothing will be fetched into, because Git refuses to
  // fetch directly into the branch HEAD is attached to.
  git(target, ['init', '--quiet', '--initial-branch=bootstrap'])
  git(target, ['config', 'core.autocrlf', 'false'])
  git(target, ['config', 'commit.gpgsign', 'false'])
  git(target, [
    'fetch',
    '--quiet',
    '--no-tags',
    sourceRepo,
    `${sourceRef}:refs/heads/${DEFAULT_BRANCH}`
  ])
  git(target, ['checkout', '--quiet', DEFAULT_BRANCH])

  return git(target, ['rev-parse', 'HEAD'])
}

/**
 * Finds where the bisect marker already appears in the imported history.
 *
 * The imported course history is real, and an earlier revision of it disabled
 * the same assertion Lab 3 hunts for. That gives `git bisect` a second
 * good-to-bad boundary, so the learner needs a starting point newer than the
 * last such change. This locates it instead of assuming it.
 *
 * @param repo Repository directory.
 * @param revision Reference to inspect.
 * @returns Commits that changed the marker, newest first.
 */
export function findMarkerHistory(repo: string, revision: string): string[] {
  const output = git(repo, [
    'log',
    '--format=%H',
    `-S${BISECT_MARKER}`,
    revision,
    '--',
    BISECT_TARGET
  ])

  return output === '' ? [] : output.split('\n')
}

/**
 * Writes the predicate `git bisect run` executes.
 *
 * `grep` exits 0 when it finds the marker, and `git bisect` reads exit 0 as
 * *good*, so a naive `git bisect run grep` inverts the lab's meaning. A
 * missing file exits 2, which `git bisect` also reads as bad. This predicate
 * corrects both: present is bad, absent or missing is good.
 *
 * @param repo Repository directory to write the predicate into.
 * @returns Absolute path of the predicate.
 */
function writeBisectPredicate(repo: string): string {
  const path = join(repo, BISECT_CHECK)

  writeFileSync(
    path,
    [
      "import { readFileSync } from 'node:fs'",
      '',
      'let text',
      'try {',
      `  text = readFileSync(${JSON.stringify(BISECT_TARGET)}, 'utf8')`,
      '} catch {',
      '  // The file does not exist yet, so the marker cannot have been added.',
      '  process.exit(0)',
      '}',
      '',
      `process.exit(text.includes(${JSON.stringify(BISECT_MARKER)}) ? 1 : 0)`,
      ''
    ].join('\n')
  )

  return path
}

export interface BisectRun {
  /** Commit `git bisect` blamed, when it converged. */
  blamed?: string
  /** Combined output, retained so a failure can be diagnosed. */
  output: string
}

/**
 * Runs a real `git bisect run` and reports the commit it blames.
 *
 * @param repo Repository directory.
 * @param good Commit to mark good.
 * @param bad Commit to mark bad.
 * @returns The blamed commit together with the command's output.
 */
export function bisect(repo: string, good: string, bad: string): BisectRun {
  writeBisectPredicate(repo)
  tryGit(repo, ['bisect', 'reset'])

  try {
    const start = tryGit(repo, ['bisect', 'start', bad, good])
    const run = tryGit(repo, ['bisect', 'run', 'node', `./${BISECT_CHECK}`])
    const output = [start.stdout, start.stderr, run.stdout, run.stderr]
      .filter((part) => part !== '')
      .join('\n')

    return {
      blamed: /([0-9a-f]{40}) is the first '?bad'? commit/.exec(output)?.[1],
      output
    }
  } finally {
    tryGit(repo, ['bisect', 'reset'])
    rmSync(join(repo, BISECT_CHECK), { force: true })
  }
}

/**
 * Runs a real `git bisect run` and reports only the commit it blames.
 *
 * @param repo Repository directory.
 * @param good Commit to mark good.
 * @param bad Commit to mark bad.
 * @returns The blamed commit, or `undefined` when bisect did not converge.
 */
export function runBisect(
  repo: string,
  good: string,
  bad: string
): string | undefined {
  return bisect(repo, good, bad).blamed
}

/**
 * Seeds the commits Labs 2, 3 and 4 depend on onto `main`.
 *
 * @param repo Repository directory.
 * @param timestamp Base commit timestamp, in seconds since the Unix epoch.
 * @returns The seeded commits, keyed by subject.
 */
function seedMainHistory(
  repo: string,
  timestamp: number
): Record<string, string> {
  const [trim, watch, controls, broken, markup, baseline] = SEEDED_MAIN_COMMITS
  const commits: Record<string, string> = {}
  let clock = timestamp

  const removable = MAINTENANCE_ONLY_PATHS.filter(
    (path) => readBlob(repo, 'HEAD', path) !== undefined
  )

  if (removable.length === 0)
    throw new Error(
      `Refusing to build: none of ${MAINTENANCE_ONLY_PATHS.join(', ')} is ` +
        'present, so the classroom tree cannot be verified as trimmed'
    )

  git(repo, ['rm', '--quiet', '--', ...removable], { timestamp: (clock += 60) })
  git(repo, ['commit', '--quiet', '-m', trim], { timestamp: clock })
  commits[trim] = git(repo, ['rev-parse', 'HEAD'])

  commits[watch] = commitEdit(
    repo,
    watch,
    'package.json',
    (text) =>
      replaceOnce(
        text.trimEnd(),
        '    "package:watch":',
        '    "watch": "npm run package:watch",\n    "package:watch":'
      ),
    (clock += 60)
  )

  commits[controls] = commitEdit(
    repo,
    controls,
    'README.md',
    (text) =>
      appendMarkdownSection(
        text,
        'Controls',
        'Use the arrow keys to move the tiles. Matching tiles merge when they touch.'
      ),
    (clock += 60)
  )

  // The deliberate instructional failure. It exists only in the learner
  // fixture, never on the maintenance branch, so real continuous integration
  // stays green while the classroom repository starts red on purpose.
  commits[broken] = commitEdit(
    repo,
    broken,
    BISECT_TARGET,
    (text) =>
      replaceOnce(
        text.trimEnd(),
        '      expect(true).toBe(true)',
        `      // Lab 3: Git Bisect\n      ${BISECT_MARKER}`
      ),
    (clock += 60)
  )

  commits[markup] = commitEdit(
    repo,
    markup,
    'index.html',
    (text) => text.trimEnd(),
    (clock += 60)
  )

  commits[baseline] = commitEdit(
    repo,
    baseline,
    'README.md',
    (text) =>
      appendMarkdownSection(
        text,
        'Class Baseline',
        `The \`${BISECT_ANCHOR_TAG}\` tag marks the last release known to pass its tests.`
      ),
    (clock += 60)
  )

  return commits
}

/**
 * Seeds `feature/animate-score` with the four commits Lab 4 squashes.
 *
 * The order is fixed by the todo list printed in
 * `labs/4-interactive-rebase.md` Task 2. Their cumulative effect equals
 * `solutions/4-interactive-rebase/html_actuator.ts`, which is what makes the
 * lab's squash-then-merge produce the documented result.
 *
 * @param repo Repository directory.
 * @param branchPoint Commit on `main` the branch diverges from.
 * @param timestamp Base commit timestamp, in seconds since the Unix epoch.
 * @returns The branch tip.
 */
function seedRebaseBranch(
  repo: string,
  branchPoint: string,
  timestamp: number
): string {
  const [animate, resize, removeComment, revert] = REBASE_COMMITS
  let clock = timestamp

  git(repo, ['checkout', '--quiet', '-b', REBASE_BRANCH.name, branchPoint])

  const styles = readBlob(repo, 'HEAD', 'style/main.css')
  if (styles === undefined) throw new Error('style/main.css absent at HEAD')

  commitEdit(
    repo,
    animate,
    HTML_ACTUATOR,
    (text) =>
      replaceOnce(
        text.trimEnd(),
        '    // Lab 4: Animate the score update',
        [
          '    // Lab 4: Animate the score update',
          '    if (difference > 0) {',
          "      const addition = document.createElement('div')",
          "      addition.classList.add('score-addition')",
          "      addition.textContent = '+' + difference",
          '',
          '      HTMLActuator.scoreContainer.appendChild(addition)',
          '    }'
        ].join('\n')
      ),
    (clock += 60)
  )

  commitEdit(
    repo,
    resize,
    'style/main.css',
    (text) => replaceOnce(text.trimEnd(), '  right: 30px;', '  right: 42px;'),
    (clock += 60)
  )

  commitEdit(
    repo,
    removeComment,
    HTML_ACTUATOR,
    (text) =>
      replaceOnce(
        text.trimEnd(),
        '    // @ts-expect-error This will be used in the future\n',
        ''
      ),
    (clock += 60)
  )

  // Restores the scoreboard styling, so the branch's net effect is exactly the
  // published solution rather than the solution plus an abandoned experiment.
  commitFiles(repo, revert, { 'style/main.css': styles }, clock + 60)

  const tip = git(repo, ['rev-parse', 'HEAD'])
  git(repo, ['checkout', '--quiet', DEFAULT_BRANCH])

  return tip
}

/**
 * Seeds the four Lab 8 branches, each editing one contended line.
 *
 * @param repo Repository directory.
 * @param branchPoint Commit on `main` the branches diverge from.
 * @param timestamp Base commit timestamp, in seconds since the Unix epoch.
 * @returns Branch names mapped to their tip commits.
 */
function seedConflictBranches(
  repo: string,
  branchPoint: string,
  timestamp: number
): Record<string, string> {
  const tips: Record<string, string> = {}
  let clock = timestamp

  for (const branch of CONFLICT_BRANCHES) {
    git(repo, ['checkout', '--quiet', '-b', branch.name, branchPoint])

    tips[branch.name] = commitEdit(
      repo,
      branch.commitSubject,
      GAME_MANAGER,
      (text) => replaceOnce(text.trimEnd(), branch.from, branch.to),
      (clock += 60)
    )

    git(repo, ['checkout', '--quiet', DEFAULT_BRANCH])
  }

  return tips
}

export interface GoldenBuildOptions {
  /** Repository to import the course history from. */
  sourceRepo: string
  /** Directory to build into. Must not already exist. */
  target: string
  /** Reference in the source repository to import. */
  sourceRef?: string
  /** Base commit timestamp, in seconds since the Unix epoch. */
  timestamp?: number
}

/**
 * Builds the golden course repository.
 *
 * @param options Source repository, target directory and timing.
 * @returns A description of the state that was built.
 * @throws If provenance files are missing, a seeded reference would collide
 * with one a learner must create, or the seeded bisect does not converge.
 */
export function buildGoldenRepository(
  options: GoldenBuildOptions
): GoldenFixture {
  const { sourceRepo, target } = options
  const sourceRef = options.sourceRef ?? 'HEAD'
  const timestamp = options.timestamp ?? FIXTURE_EPOCH

  const collisions = detectLearnerRefCollisions(
    Object.keys(listRefs(sourceRepo)).filter((ref) =>
      ref.startsWith('refs/heads/')
    )
  )
  if (collisions.length > 0)
    throw new Error(
      `Refusing to build: seeded state collides with references learners create: ${collisions.join(
        ', '
      )}`
    )

  const baseCommit = importHistory(sourceRepo, sourceRef, target)
  for (const file of PROVENANCE_FILES)
    if (readBlob(target, baseCommit, file) === undefined)
      throw new Error(
        `Refusing to build: ${file} is absent from the imported history`
      )

  const priorOccurrences = findMarkerHistory(target, baseCommit)
  const newestPrior = priorOccurrences[0]
  const rootAnchorSafe = newestPrior === undefined

  if (
    newestPrior !== undefined &&
    readBlob(target, newestPrior, BISECT_TARGET)?.includes(BISECT_MARKER)
  )
    throw new Error(
      'Refusing to build: the imported history already ends with the bisect ' +
        'marker present, so seeding it again cannot create a boundary'
    )

  const anchorCommit =
    newestPrior ?? git(target, ['rev-list', '--max-parents=0', baseCommit])
  const mainCommits = seedMainHistory(target, timestamp)
  const headCommit = git(target, ['rev-parse', DEFAULT_BRANCH])

  git(target, [
    'tag',
    '--annotate',
    '--message',
    'Last release known to pass its tests',
    BISECT_ANCHOR_TAG,
    anchorCommit
  ])

  const branches: Record<string, string> = {
    [REBASE_BRANCH.name]: seedRebaseBranch(
      target,
      mainCommits[REBASE_BRANCH_POINT],
      timestamp + 3600
    ),
    ...seedConflictBranches(target, headCommit, timestamp + 7200)
  }

  const badCommit = mainCommits[BISECT_BAD_SUBJECT]
  const verification = bisect(target, anchorCommit, headCommit)

  if (verification.blamed !== badCommit)
    throw new Error(
      `Refusing to build: git bisect blamed ${
        verification.blamed ?? 'no commit'
      }, expected the seeded ${BISECT_BAD_SUBJECT} commit ${badCommit}.\n${
        verification.output
      }`
    )

  return {
    path: target,
    baseCommit,
    headCommit,
    branches,
    refs: Object.keys(listRefs(target)).sort(),
    bisect: {
      badCommit,
      badSubject: BISECT_BAD_SUBJECT,
      anchorCommit,
      anchorTag: BISECT_ANCHOR_TAG,
      priorOccurrences,
      rootAnchorSafe
    }
  }
}

/**
 * Finds files carrying a class placeholder token.
 *
 * A content scan, and therefore a diagnostic rather than a source of truth
 * about what to rewrite: it cannot tell a file that carries class
 * configuration from one that documents the placeholder mechanism.
 * `CLASS_CONFIG_FILES` decides what `renderPlaceholders` writes; this reports
 * what is actually there, so the two can be compared.
 *
 * @param repo Repository directory.
 * @param revision Reference to inspect.
 * @returns Repository-relative paths, sorted.
 */
export function findPlaceholders(repo: string, revision: string): string[] {
  const found = new Set<string>()

  for (const token of Object.values(PLACEHOLDERS)) {
    const result = tryGit(repo, [
      'grep',
      '--name-only',
      '--fixed-strings',
      token,
      revision
    ])

    if (result.status === 0)
      for (const line of result.stdout.split('\n'))
        if (line !== '') found.add(line.slice(line.indexOf(':') + 1))
  }

  return [...found].sort()
}

/**
 * Finds class-configuration files that have not been rendered yet.
 *
 * This is the question a provisioning run needs answered — "does this tree
 * still hold unsubstituted class configuration?" — as opposed to the broader
 * question `findPlaceholders` answers. Tokens left in the tooling and its
 * documentation are the intended state and never appear here.
 *
 * @param repo Repository directory.
 * @param revision Reference to inspect.
 * @returns Repository-relative paths, sorted.
 */
export function unrenderedClassConfig(
  repo: string,
  revision: string
): string[] {
  const carrying = new Set(findPlaceholders(repo, revision))

  return CLASS_CONFIG_FILES.filter((path) => carrying.has(path)).sort()
}

/** What a render substituted, and what it deliberately left alone. */
export interface RenderReport {
  /** Allow-listed files rewritten with the class values, sorted. */
  rendered: string[]
  /**
   * Files still carrying a token afterwards, sorted.
   *
   * Not a failure. These include the placeholder mechanism and Lab 0's URL
   * templates, where the learner supplies both owner and repository from their
   * assigned URL. Keeping the mechanism intact lets a customer render the next
   * class from the delivered bundle.
   */
  retained: string[]
}

/**
 * Substitutes the class placeholders and records the result as one commit.
 *
 * The generic material keeps the placeholders, so no customer name is ever
 * committed to the reusable repository. Substitution happens on a per-class
 * copy, immediately before that class's repositories are seeded.
 *
 * Only `CLASS_CONFIG_FILES` are rewritten. Deriving the write set from a
 * content scan instead would rewrite the tooling that owns the tokens and the
 * documentation that explains them.
 *
 * @param repo Repository directory to render in place.
 * @param values Organization and class team to substitute.
 * @param timestamp Commit timestamp, in seconds since the Unix epoch.
 * @returns What was rewritten and what was left carrying tokens by design.
 * @throws If either value is blank or still looks like a placeholder.
 */
export function renderPlaceholders(
  repo: string,
  values: { organization: string; classTeam: string },
  timestamp: number = FIXTURE_EPOCH
): RenderReport {
  for (const [key, value] of Object.entries(values))
    if (value.trim() === '' || value.includes('<') || value.includes('>'))
      throw new Error(`Refusing to render: ${key} is not a concrete value`)

  const files: Record<string, string> = {}

  for (const path of CLASS_CONFIG_FILES) {
    const current = readBlob(repo, 'HEAD', path)
    if (current === undefined) continue

    const substituted = current
      .split(PLACEHOLDERS.organization)
      .join(values.organization)
      .split(PLACEHOLDERS.classTeam)
      .join(values.classTeam)

    if (substituted !== current) files[path] = substituted
  }

  const rendered = Object.keys(files).sort()

  if (rendered.length > 0) {
    for (const [path, content] of Object.entries(files))
      writeFileSync(join(repo, path), content)

    git(repo, ['add', '--', ...rendered], { timestamp })
    git(repo, ['commit', '--quiet', '-m', 'Apply class configuration'], {
      timestamp
    })
  }

  return { rendered, retained: findPlaceholders(repo, 'HEAD') }
}

/**
 * Resolves conflict markers by keeping one side, as Lab 8 instructs.
 *
 * Both Lab 8 resolutions keep the pull request's change, but the side that
 * represents differs with direction: merging a branch into `main` puts the
 * branch on the `theirs` side, while merging `main` into a branch puts it on
 * the `ours` side. Marker labels are not asserted anywhere, because the GitHub
 * UI writes the branch name where the command line writes `HEAD`.
 *
 * @param text File contents containing conflict markers.
 * @param keep Which side of each conflict to retain.
 * @returns The resolved contents.
 * @throws If the text holds no conflict.
 */
export function resolveConflict(text: string, keep: 'ours' | 'theirs'): string {
  const output: string[] = []
  let side: 'none' | 'ours' | 'theirs' = 'none'
  let conflicts = 0

  for (const line of text.split('\n')) {
    if (line.startsWith('<<<<<<<')) {
      side = 'ours'
      conflicts += 1
    } else if (line.startsWith('=======') && side === 'ours') side = 'theirs'
    else if (line.startsWith('>>>>>>>') && side === 'theirs') side = 'none'
    else if (side === 'none' || side === keep) output.push(line)
  }

  if (conflicts === 0) throw new Error('No conflict markers to resolve')

  return output.join('\n')
}

/**
 * Reports references the built fixture holds that the contract does not export.
 *
 * @param fixture A built fixture.
 * @returns Reference names present in the fixture but outside the contract.
 */
export function unexpectedRefs(fixture: GoldenFixture): string[] {
  const intended = new Set(intendedExportedRefs())
  return fixture.refs.filter((ref) => !intended.has(ref))
}
