/** @jest-environment node */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BISECT_ANCHOR_TAG,
  BISECT_MARKER,
  BISECT_TARGET,
  CONFLICT_BRANCHES,
  DEFAULT_BRANCH,
  FORBIDDEN_REF_PREFIXES,
  GAME_MANAGER,
  HTML_ACTUATOR,
  LAB_8_END_STATE,
  LEARNER_CREATED_REFS,
  REBASE_BRANCH,
  REBASE_COMMITS,
  detectLearnerRefCollisions,
  intendedExportedRefs
} from '../tools/provisioning/contract.js'
import {
  buildGoldenRepository,
  replaceOnce,
  resolveConflict,
  runBisect,
  unexpectedRefs,
  type GoldenFixture
} from '../tools/provisioning/fixture.js'
import { git, readBlob, tryGit } from '../tools/provisioning/git.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let workspace: string
let fixture: GoldenFixture

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'course-fixture-'))
  fixture = buildGoldenRepository({
    sourceRepo: root,
    target: join(workspace, 'golden')
  })
}, 900_000)

afterAll(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true })
})

/**
 * Clones the built fixture so a destructive check cannot disturb its siblings.
 *
 * @param name Directory name for the clone.
 * @returns Path of the working clone, checked out on the default branch.
 */
function scratch(name: string): string {
  const target = join(workspace, name)

  git(workspace, ['clone', '--quiet', '--no-hardlinks', fixture.path, target])
  git(target, ['config', 'core.autocrlf', 'false'])
  git(target, ['checkout', '--quiet', DEFAULT_BRANCH])

  return target
}

describe('golden fixture: provenance and history', () => {
  it.each(['LICENSE', 'NOTICE'])('exports %s in the tree', (file) => {
    expect(readBlob(fixture.path, fixture.headCommit, file)).toBeTruthy()
  })

  it('keeps the imported course history reachable', () => {
    const ancestry = tryGit(fixture.path, [
      'merge-base',
      '--is-ancestor',
      fixture.baseCommit,
      fixture.headCommit
    ])

    expect(ancestry.status).toBe(0)
    expect(
      Number(git(fixture.path, ['rev-list', '--count', fixture.headCommit]))
    ).toBeGreaterThan(85)
  })

  it('leaves several distinct commits for Lab 2 to choose between', () => {
    const subjects = git(fixture.path, [
      'log',
      '--format=%s',
      '-n',
      '5',
      DEFAULT_BRANCH
    ]).split('\n')

    expect(subjects).toHaveLength(5)
    expect(new Set(subjects).size).toBe(5)
  })
})

describe('golden fixture: Lab 3 bisect', () => {
  it('leaves the broken assertion at the learner starting point', () => {
    const text = readBlob(fixture.path, fixture.headCommit, BISECT_TARGET)

    expect(text).toContain(BISECT_MARKER)
    expect(text).toContain('// Lab 3: Git Bisect')
  })

  it('never places the broken assertion on the maintenance branch', () => {
    expect(readFileSync(join(root, BISECT_TARGET), 'utf8')).not.toContain(
      BISECT_MARKER
    )
  })

  it('blames the recorded bad commit from the seeded anchor', () => {
    const repo = scratch('bisect-anchored')

    expect(
      runBisect(repo, fixture.bisect.anchorCommit, fixture.headCommit)
    ).toBe(fixture.bisect.badCommit)
  }, 900_000)

  it('names that commit after the lab worked example', () => {
    expect(
      git(fixture.path, ['log', '-1', '--format=%s', fixture.bisect.badCommit])
    ).toBe(fixture.bisect.badSubject)
  })

  it('records why the repository root is not a safe starting point', () => {
    expect(fixture.bisect.priorOccurrences.length).toBeGreaterThan(0)
    expect(fixture.bisect.rootAnchorSafe).toBe(false)
  })

  it('demonstrates that anchoring at the root blames the wrong commit', () => {
    const repo = scratch('bisect-root')
    const rootCommit = git(repo, [
      'rev-list',
      '--max-parents=0',
      fixture.headCommit
    ])

    expect(runBisect(repo, rootCommit, fixture.headCommit)).not.toBe(
      fixture.bisect.badCommit
    )
  }, 900_000)

  it('publishes the anchor as a tag learners can name', () => {
    expect(
      git(fixture.path, ['rev-list', '-n', '1', fixture.bisect.anchorTag])
    ).toBe(fixture.bisect.anchorCommit)
  })
})

describe('golden fixture: Lab 4 interactive rebase', () => {
  it('carries exactly the four commits the todo list prints', () => {
    const subjects = git(fixture.path, [
      'log',
      '--format=%s',
      `${DEFAULT_BRANCH}..${REBASE_BRANCH.name}`
    ]).split('\n')

    expect(subjects.reverse()).toEqual([...REBASE_COMMITS])
  })

  it('sits behind main, as the lab scenario states', () => {
    expect(
      Number(
        git(fixture.path, [
          'rev-list',
          '--count',
          `${REBASE_BRANCH.name}..${DEFAULT_BRANCH}`
        ])
      )
    ).toBeGreaterThan(0)
  })

  it('squashes and merges to exactly the published solution', () => {
    const repo = scratch('rebase')
    const solution = readFileSync(
      join(root, 'solutions', '4-interactive-rebase', 'html_actuator.ts'),
      'utf8'
    )

    git(repo, [
      'checkout',
      '--quiet',
      '-b',
      'rebased',
      `origin/${REBASE_BRANCH.name}`
    ])
    git(repo, ['rebase', '--quiet', DEFAULT_BRANCH], {
      env: { GIT_SEQUENCE_EDITOR: 'true', GIT_EDITOR: 'true' }
    })
    git(repo, ['reset', '--quiet', '--soft', DEFAULT_BRANCH])
    git(repo, ['commit', '--quiet', '-m', REBASE_COMMITS[0]])
    git(repo, ['checkout', '--quiet', DEFAULT_BRANCH])
    git(repo, ['merge', '--quiet', '--no-edit', 'rebased'])

    expect(readBlob(repo, 'HEAD', HTML_ACTUATOR)).toBe(solution)
  }, 300_000)
})

describe('golden fixture: Lab 8 merge conflicts', () => {
  const pairs = ['start-tiles', 'tile-value'] as const

  /**
   * Selects one member of a conflict pair.
   *
   * @param pair Pair identifier.
   * @param order Whether to take the branch merged first or second.
   * @returns The matching branch.
   */
  function member(pair: string, order: string) {
    const branch = CONFLICT_BRANCHES.find(
      (candidate) => candidate.pair === pair && candidate.order === order
    )

    if (!branch) throw new Error(`No ${order} branch in the ${pair} pair`)

    return branch
  }

  it.each(pairs)(
    'produces a real conflict in the %s pair',
    (pair) => {
      const first = member(pair, 'merge-first')
      const second = member(pair, 'conflicts-second')
      const repo = scratch(`conflict-${pair}`)

      git(repo, ['merge', '--quiet', '--no-edit', `origin/${first.name}`])
      expect(readBlob(repo, 'HEAD', GAME_MANAGER)).toContain(first.to)

      const merge = tryGit(repo, [
        'merge',
        '--no-edit',
        `origin/${second.name}`
      ])

      expect(merge.status).not.toBe(0)
      expect(`${merge.stdout}\n${merge.stderr}`).toContain(
        `CONFLICT (content): Merge conflict in ${GAME_MANAGER}`
      )

      const conflicted = readFileSync(join(repo, GAME_MANAGER), 'utf8')
      expect(conflicted).toContain('<<<<<<<')
      expect(conflicted).toContain(second.to)
      expect(conflicted).toContain(first.to)
    },
    300_000
  )

  it('reaches the documented end state when the lab is replayed', () => {
    const repo = scratch('conflict-end-state')

    // Merging a pull request branch into main puts the branch's change on the
    // `theirs` side, which is the side both lab tasks keep.
    for (const pair of pairs)
      for (const order of ['merge-first', 'conflicts-second']) {
        const branch = member(pair, order)
        const merge = tryGit(repo, [
          'merge',
          '--no-edit',
          `origin/${branch.name}`
        ])

        if (merge.status !== 0) {
          writeFileSync(
            join(repo, GAME_MANAGER),
            resolveConflict(
              readFileSync(join(repo, GAME_MANAGER), 'utf8'),
              'theirs'
            )
          )
          git(repo, ['add', '--', GAME_MANAGER])
          git(repo, ['commit', '--quiet', '--no-edit'])
        }
      }

    const final = readBlob(repo, 'HEAD', GAME_MANAGER)
    expect(final).toContain(LAB_8_END_STATE.startTiles)
    expect(final).toContain(LAB_8_END_STATE.tileValue)
  }, 300_000)

  it('conflicts the same way when main is merged into the branch', () => {
    const first = member('tile-value', 'merge-first')
    const second = member('tile-value', 'conflicts-second')
    const repo = scratch('conflict-command-line')

    git(repo, ['merge', '--quiet', '--no-edit', `origin/${first.name}`])

    const mainTip = git(repo, ['rev-parse', 'HEAD'])
    git(repo, [
      'checkout',
      '--quiet',
      '-b',
      second.name,
      `origin/${second.name}`
    ])

    // Task 4 merges main into the pull request branch, so the branch's change
    // is on the `ours` side instead.
    const merge = tryGit(repo, ['merge', '--no-edit', mainTip])
    expect(merge.status).not.toBe(0)

    writeFileSync(
      join(repo, GAME_MANAGER),
      resolveConflict(readFileSync(join(repo, GAME_MANAGER), 'utf8'), 'ours')
    )
    git(repo, ['add', '--', GAME_MANAGER])
    git(repo, ['commit', '--quiet', '--no-edit'])

    expect(readBlob(repo, 'HEAD', GAME_MANAGER)).toContain(second.to)
  }, 300_000)

  it('does not align the branch suffix with the value it sets', () => {
    expect(member('start-tiles', 'merge-first').name).toBe(
      'feature/start-tiles-4'
    )
    expect(member('start-tiles', 'merge-first').to).toBe(
      'static startTiles: number = 2'
    )
  })
})

describe('golden fixture: reference contract', () => {
  it('holds exactly the references the contract exports', () => {
    expect(fixture.refs).toEqual([...intendedExportedRefs()].sort())
    expect(unexpectedRefs(fixture)).toEqual([])
  })

  it.each([...FORBIDDEN_REF_PREFIXES])(
    'excludes the %s namespace',
    (prefix) => {
      expect(fixture.refs.filter((ref) => ref.startsWith(prefix))).toEqual([])
    }
  )

  it.each(LEARNER_CREATED_REFS.map((ref) => ref.name))(
    'leaves %s for the learner to create',
    (name) => {
      expect(fixture.refs).not.toContain(`refs/heads/${name}`)
    }
  )

  it('detects a collision with a reference a learner must create', () => {
    expect(detectLearnerRefCollisions(['refs/heads/fix/unit-test'])).toEqual([
      'refs/heads/fix/unit-test'
    ])
    expect(detectLearnerRefCollisions(['refs/heads/main'])).toEqual([])
  })

  it('refuses to build when the source already holds a learner reference', () => {
    const tainted = scratch('tainted')
    git(tainted, ['branch', 'fix/unit-test', DEFAULT_BRANCH])

    expect(() =>
      buildGoldenRepository({
        sourceRepo: tainted,
        target: join(workspace, 'refused')
      })
    ).toThrow(/collides with references learners create/)
  }, 300_000)
})

describe('curriculum artifacts match the contract', () => {
  /**
   * Reads a repository file as text.
   *
   * @param parts Path segments below the repository root.
   * @returns The file contents.
   */
  function read(...parts: string[]): string {
    return readFileSync(join(root, ...parts), 'utf8')
  }

  it('reconciles the Lab 8 solution with the documented end state', () => {
    const solution = read('solutions', '8-merge-conflicts', 'game_manager.ts')

    expect(solution).toContain(LAB_8_END_STATE.startTiles)
    expect(solution).toContain(LAB_8_END_STATE.tileValue)
  })

  it.each(
    CONFLICT_BRANCHES.filter((branch) => branch.order === 'conflicts-second')
  )('prints $name\u2019s value in the lab conflict block', (branch) => {
    const lab = read('labs', '8-merge-conflicts.md')
    const merged = CONFLICT_BRANCHES.find(
      (other) => other.pair === branch.pair && other.order === 'merge-first'
    )

    expect(lab).toContain(branch.name)
    expect(lab).toContain(branch.to.trim())
    expect(lab).toContain(merged?.to.trim())
  })

  it('points Lab 3 at the seeded bisect anchor', () => {
    const lab = read('labs', '3-git-bisect.md')

    expect(lab).toContain(`git bisect good ${BISECT_ANCHOR_TAG}`)
    expect(lab).toContain(BISECT_MARKER)
    expect(lab).not.toContain('the one labeled `Initial commit`')
  })

  it.each([...REBASE_COMMITS])(
    'lists %s in the Lab 4 rebase todo list',
    (subject) => {
      const lab = read('labs', '4-interactive-rebase.md')
      const todo = lab.split('## Task 2')[1].split('## Task 3')[0]

      expect(todo).toContain(`pick `)
      expect(todo).toContain(subject)
    }
  )

  it('draws all four branch commits off main in the Task 1 graph', () => {
    const task1 = read('labs', '4-interactive-rebase.md').split('## Task 2')[0]
    const branchLines = task1
      .split('\n')
      .filter((line) => line.trim().startsWith('| *'))

    expect(branchLines).toHaveLength(REBASE_COMMITS.length)
    for (const subject of REBASE_COMMITS)
      expect(branchLines.some((line) => line.endsWith(subject))).toBe(true)
  })

  it('quotes no impossible commit identifier', () => {
    const lab = read('labs', '4-interactive-rebase.md')

    // A hash containing a non-hexadecimal character cannot have come from a
    // real `git log`, and the learner is told to copy these into commands.
    expect(lab).not.toContain('a4f1x35')
    for (const match of lab.matchAll(/^\s*(?:\| )?\* ([0-9a-z]{7}) /gm))
      expect(match[1]).toMatch(/^[0-9a-f]{7}$/)
  })
})

describe('resolveConflict', () => {
  const conflicted = [
    'a',
    '<<<<<<< HEAD',
    'mine',
    '=======',
    'theirs',
    '>>>>>>> other',
    'b'
  ].join('\n')

  it.each([
    ['ours', 'mine'],
    ['theirs', 'theirs']
  ])('keeps the %s side', (keep, expected) => {
    expect(resolveConflict(conflicted, keep as 'ours' | 'theirs')).toBe(
      ['a', expected, 'b'].join('\n')
    )
  })

  it('refuses text with no conflict', () => {
    expect(() => resolveConflict('clean', 'ours')).toThrow(/No conflict/)
  })
})

describe('replaceOnce', () => {
  it('replaces a unique occurrence', () => {
    expect(replaceOnce('a b c', 'b', 'B')).toBe('a B c')
  })

  it.each([
    ['a b b', 'b'],
    ['a b c', 'z']
  ])('refuses %p when %p is not unique', (text, needle) => {
    expect(() => replaceOnce(text, needle, 'X')).toThrow(
      /Expected exactly one occurrence/
    )
  })
})
