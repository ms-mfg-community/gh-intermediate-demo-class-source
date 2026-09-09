/**
 * The lab contract.
 *
 * A single machine-readable statement of the repository state each lab
 * assumes. The fixture builder produces this state, the provisioning adapter
 * reproduces it on GitHub, and `docs/lab-contract.md` documents it. Any change
 * to what a lab expects belongs here first.
 *
 * Every value below is derived from the lab markdown in `labs/`, which is
 * normative, and cross-checked against `src/game_manager.ts`.
 */

/** Path the Lab 3 bisect exercise greps. */
export const BISECT_TARGET = '__tests__/keyboard_input_manager.test.ts'

/** String whose introduction Lab 3 asks the learner to locate. */
export const BISECT_MARKER = 'expect(true).toBe(false)'

/** Tag naming the last known-good release, used as the Lab 3 bisect anchor. */
export const BISECT_ANCHOR_TAG = 'lab-baseline'

/** Default branch of the golden repository and of every per-student repo. */
export const DEFAULT_BRANCH = 'main'

/** Source file the Lab 8 conflict pairs contend over. */
export const GAME_MANAGER = 'src/game_manager.ts'

/** Source file the Lab 4 feature branch develops. */
export const HTML_ACTUATOR = 'src/html_actuator.ts'

/** Placeholder tokens substituted with per-class values at provisioning time. */
export const PLACEHOLDERS = {
  organization: '<organization>',
  classTeam: '<class-team>'
} as const

/**
 * A branch the instructor seeds before the class starts.
 */
export interface SeededBranch {
  /** Branch name, without the `refs/heads/` prefix. */
  name: string
  /** Lab that consumes the branch. */
  lab: number
  /** What the branch exists to make possible. */
  purpose: string
}

/**
 * One half of a Lab 8 conflict pair: a branch that edits a single value in
 * `src/game_manager.ts`.
 */
export interface ConflictBranch extends SeededBranch {
  /** Literal text replaced on the contended line. */
  from: string
  /** Literal text written in its place. */
  to: string
  /** Subject of the single commit the branch carries. */
  commitSubject: string
  /** Pair identifier; the two members of a pair conflict with each other. */
  pair: 'start-tiles' | 'tile-value'
  /** Whether the learner merges this branch first or resolves it second. */
  order: 'merge-first' | 'conflicts-second'
}

/**
 * Baseline values in `src/game_manager.ts` that the Lab 8 branches diverge
 * from. Verified against the committed source.
 */
export const GAME_MANAGER_BASELINE = {
  startTiles: 'static startTiles: number = 1',
  tileValue: 'const value = Math.random() < 0.9 ? 2 : 4'
} as const

/**
 * The four Lab 8 branches.
 *
 * The numeric suffix of a branch name is an identifier, not the value the
 * branch sets. `labs/8-merge-conflicts.md` prints the conflict blocks, and
 * those blocks are normative: Task 2 shows `feature/start-tiles-3` offering
 * `4` against `2` already on `main`, and Task 4 shows `feature/tile-value-1`
 * offering `0.1` against `0.5` already on `main`. Aligning suffix to value
 * would contradict the printed lab output.
 */
export const CONFLICT_BRANCHES: readonly ConflictBranch[] = [
  {
    name: 'feature/start-tiles-4',
    lab: 8,
    pair: 'start-tiles',
    order: 'merge-first',
    purpose:
      'Merged first in the GitHub UI, creating the conflict for its pair',
    commitSubject: 'Start the game with two tiles',
    from: GAME_MANAGER_BASELINE.startTiles,
    to: 'static startTiles: number = 2'
  },
  {
    name: 'feature/start-tiles-3',
    lab: 8,
    pair: 'start-tiles',
    order: 'conflicts-second',
    purpose: 'Conflicts once its pair is merged; resolved in the GitHub UI',
    commitSubject: 'Start the game with four tiles',
    from: GAME_MANAGER_BASELINE.startTiles,
    to: 'static startTiles: number = 4'
  },
  {
    name: 'feature/tile-value-2',
    lab: 8,
    pair: 'tile-value',
    order: 'merge-first',
    purpose:
      'Merged first in the GitHub UI, creating the conflict for its pair',
    commitSubject: 'Raise the chance of a tile with value 4',
    from: GAME_MANAGER_BASELINE.tileValue,
    to: 'const value = Math.random() < 0.5 ? 2 : 4'
  },
  {
    name: 'feature/tile-value-1',
    lab: 8,
    pair: 'tile-value',
    order: 'conflicts-second',
    purpose: 'Conflicts once its pair is merged; resolved on the command line',
    commitSubject: 'Raise the chance of a tile with value 4 again',
    from: GAME_MANAGER_BASELINE.tileValue,
    to: 'const value = Math.random() < 0.1 ? 2 : 4'
  }
] as const

/**
 * Repository state after a learner completes Lab 8, keeping the branch side of
 * both conflicts as the lab instructs.
 */
export const LAB_8_END_STATE = {
  startTiles: 'static startTiles: number = 4',
  tileValue: 'const value = Math.random() < 0.1 ? 2 : 4'
} as const

/** Branch the Lab 4 interactive rebase exercise operates on. */
export const REBASE_BRANCH: SeededBranch = {
  name: 'feature/animate-score',
  lab: 4,
  purpose: 'Stale work-in-progress branch, four commits behind main'
}

/**
 * Commit subjects on `feature/animate-score`, in order.
 *
 * `git rebase --interactive main` lists only commits absent from `main`, and
 * `labs/4-interactive-rebase.md` Task 2 prints a four-entry todo list, so the
 * branch carries exactly four commits. The lab squashes them into one, whose
 * cumulative effect equals `solutions/4-interactive-rebase/html_actuator.ts`.
 */
export const REBASE_COMMITS = [
  'Animate score update',
  'Update scoreboard size',
  'Remove comment',
  'Revert change'
] as const

/** Commit subjects appended to `main` by the fixture builder, in order. */
export const SEEDED_MAIN_COMMITS = [
  'Add watch script',
  'Document the game controls',
  'Disable broken test',
  'Tidy the game rules markup',
  'Note the class baseline in the README'
] as const

/** Subject of the seeded commit that Lab 3 asks the learner to find. */
export const BISECT_BAD_SUBJECT = 'Disable broken test'

/**
 * A pull request the instructor opens before the class starts.
 *
 * Two pairs share a title by design, so a pull request is identified by its
 * head and base branches, never by its title.
 */
export interface SeededPullRequest {
  title: string
  head: string
  base: string
  lab: number
}

/** The four pull requests Lab 8 reviews, resolves and merges. */
export const SEEDED_PULL_REQUESTS: readonly SeededPullRequest[] = [
  {
    title: 'Increase the number of starting tiles',
    head: 'feature/start-tiles-4',
    base: DEFAULT_BRANCH,
    lab: 8
  },
  {
    title: 'Increase the number of starting tiles',
    head: 'feature/start-tiles-3',
    base: DEFAULT_BRANCH,
    lab: 8
  },
  {
    title: 'Increase rate of tiles with value 4',
    head: 'feature/tile-value-2',
    base: DEFAULT_BRANCH,
    lab: 8
  },
  {
    title: 'Increase rate of tiles with value 4',
    head: 'feature/tile-value-1',
    base: DEFAULT_BRANCH,
    lab: 8
  }
] as const

/**
 * Issues seeded before the class starts.
 *
 * Empty by evidence, not by omission. Every one of the eleven labs was read
 * for a dependency on a pre-existing issue and none has one: Lab 6 has the
 * learner author `CODEOWNERS` and the ruleset, and Lab 11 drives IssueOps
 * through pull request comments rather than issues. The provisioning adapter
 * still supports issue seeding so an instructor can add orientation issues
 * through configuration.
 */
export const SEEDED_ISSUES: readonly { title: string; body: string }[] = []

/**
 * References the learner creates during the class.
 *
 * Seeding any of these would remove the exercise that creates it, so the
 * builder and the provisioner both refuse to create a reference on this list.
 */
export const LEARNER_CREATED_REFS: readonly SeededBranch[] = [
  { name: 'feature/rules', lab: 1, purpose: 'Learner adds the game rules' },
  { name: 'fix/unit-test', lab: 3, purpose: 'Learner repairs the broken test' },
  {
    name: 'feature/new-game',
    lab: 5,
    purpose: 'Learner cherry-picks a commit'
  },
  { name: 'fix/stuck-tiles', lab: 7, purpose: 'Learner walks the GitHub flow' }
] as const

/** Every branch the fixture builder creates, in creation order. */
export const SEEDED_BRANCHES: readonly SeededBranch[] = [
  REBASE_BRANCH,
  ...CONFLICT_BRANCHES
] as const

/**
 * References exported into the delivery bundle.
 *
 * Stated as an explicit allow-list rather than derived from whatever the
 * working repository happens to hold, so remote-tracking references, pull
 * request references GitHub manages, and incidental working branches cannot
 * reach a customer.
 */
export function intendedExportedRefs(): string[] {
  return [
    `refs/heads/${DEFAULT_BRANCH}`,
    ...SEEDED_BRANCHES.map((branch) => `refs/heads/${branch.name}`),
    `refs/tags/${BISECT_ANCHOR_TAG}`
  ]
}

/** Reference namespaces that must never appear in an exported bundle. */
export const FORBIDDEN_REF_PREFIXES = [
  'refs/remotes/',
  'refs/pull/',
  'refs/notes/',
  'refs/stash'
] as const

/**
 * Finds seeded references that collide with references a learner is expected
 * to create.
 *
 * @param inherited Reference names already present in the source repository.
 * @returns Colliding reference names, empty when the contract is satisfiable.
 */
export function detectLearnerRefCollisions(inherited: string[]): string[] {
  const reserved = new Set(
    LEARNER_CREATED_REFS.map((ref) => `refs/heads/${ref.name}`)
  )
  const seeded = new Set([
    ...SEEDED_BRANCHES.map((branch) => `refs/heads/${branch.name}`),
    ...inherited
  ])

  return [...reserved].filter((ref) => seeded.has(ref)).sort()
}
