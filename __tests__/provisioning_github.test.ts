/** @jest-environment node */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CLASS_CONFIG_FILES,
  PLACEHOLDERS,
  SEEDED_PULL_REQUESTS,
  intendedExportedRefs
} from '../tools/provisioning/contract.js'
import { exportBundle, bundleRefs } from '../tools/provisioning/bundle.js'
import {
  buildGoldenRepository,
  renderPlaceholders,
  unrenderedClassConfig,
  type GoldenFixture,
  type RenderReport
} from '../tools/provisioning/fixture.js'
import { git, lsRemote, readBlob } from '../tools/provisioning/git.js'
import {
  GitHubApi,
  nextPageLink,
  type HttpRequest
} from '../tools/provisioning/github/client.js'
import {
  FakeGitHub,
  fakeRepository,
  type FakeRepository
} from '../tools/provisioning/github/fake.js'
import {
  Provisioner,
  type PlannedAction,
  type ProvisioningConfig
} from '../tools/provisioning/github/provisioner.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ORG = 'example-org'
const TEAM = 'class-team'
const OPERATOR = 'course-provisioner'

let workspace: string
let fixture: GoldenFixture
let classRepo: string
let renderReport: RenderReport

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'course-provisioning-'))
  fixture = buildGoldenRepository({
    sourceRepo: root,
    target: join(workspace, 'golden')
  })

  classRepo = join(workspace, 'class')
  git(workspace, [
    'clone',
    '--quiet',
    '--no-hardlinks',
    fixture.path,
    classRepo
  ])
  git(classRepo, ['config', 'core.autocrlf', 'false'])

  // `git clone` checks out main and leaves the rest as remote-tracking refs.
  // The seeded branches must exist locally for the enumerated push to find
  // them; main is already present and cannot be force-updated while checked out.
  for (const ref of intendedExportedRefs()) {
    const branch = ref.slice('refs/heads/'.length)
    if (!ref.startsWith('refs/heads/') || branch === 'main') continue
    git(classRepo, ['branch', '--force', branch, `origin/${branch}`])
  }

  renderReport = renderPlaceholders(classRepo, {
    organization: ORG,
    classTeam: TEAM
  })
}, 900_000)

afterAll(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true })
})

/**
 * Creates an empty bare repository to stand in for a freshly created remote.
 *
 * @param name Directory name, without the `.git` suffix.
 * @returns Path of the bare repository.
 */
function bareRemote(name: string): string {
  const path = join(workspace, 'remotes', `${name}.git`)

  mkdirSync(dirname(path), { recursive: true })
  git(workspace, ['init', '--quiet', '--bare', '--initial-branch=main', path])

  return path
}

interface Harness {
  service: FakeGitHub
  provisioner: Provisioner
  config: ProvisioningConfig
  requests: HttpRequest[]
}

/**
 * Wires a fake service, a real local remote and a provisioner together.
 *
 * @param options Service overrides and configuration overrides.
 * @returns The assembled harness.
 */
function harness(
  options: {
    participants?: string[]
    repositories?: Record<string, FakeRepository>
    denied?: string[]
    pageSize?: number
    operator?: string
    organizations?: Record<string, string[]>
    config?: Partial<ProvisioningConfig>
  } = {}
): Harness {
  const participants = options.participants ?? ['alpha']
  const service = new FakeGitHub({
    operator: options.operator ?? OPERATOR,
    organizations: options.organizations ?? { [ORG]: [TEAM] },
    repositories: options.repositories,
    denied: options.denied,
    pageSize: options.pageSize,
    remoteRoot: join(workspace, 'remotes'),
    onCreate: (repository) => {
      bareRemote(repository.name)
    }
  })
  const api = new GitHubApi({ client: service, token: 'fake-token' })

  return {
    service,
    requests: service.requests,
    provisioner: new Provisioner({ api }),
    config: {
      organization: ORG,
      classTeam: TEAM,
      repositoryPrefix: 'gh-intermediate',
      participants,
      sourceRepository: classRepo,
      expectedOperator: OPERATOR,
      ...options.config
    }
  }
}

/**
 * Finds one action in a report.
 *
 * @param actions Reported actions.
 * @param kind Action kind.
 * @param target Optional target filter.
 * @returns The matching actions.
 */
function pick(
  actions: PlannedAction[],
  kind: PlannedAction['kind'],
  target?: string
): PlannedAction[] {
  return actions.filter(
    (action) =>
      action.kind === kind && (target === undefined || action.target === target)
  )
}

describe('class placeholders', () => {
  it('keeps the generic repository free of customer values', () => {
    expect(unrenderedClassConfig(fixture.path, 'HEAD')).toEqual([
      ...CLASS_CONFIG_FILES
    ])
  })

  it('substitutes the class configuration on the class copy', () => {
    expect(unrenderedClassConfig(classRepo, 'HEAD')).toEqual([])
    expect(renderReport.rendered).toEqual([...CLASS_CONFIG_FILES])

    const lab6 = readBlob(classRepo, 'HEAD', 'labs/6-protect-main.md')

    // Lab 6 Task 1: the CODEOWNERS line the learner types.
    expect(lab6).toContain(`* @${ORG}/${TEAM}`)
    // Lab 6 Task 3: the rejected-push output the learner is shown.
    expect(lab6).toContain(`To github.com:${ORG}/<repository>.git`)
    expect(lab6).not.toContain(PLACEHOLDERS.organization)
    expect(lab6).not.toContain(PLACEHOLDERS.classTeam)
  })

  it.each([
    ['tools/provisioning/contract.ts'],
    ['docs/lab-contract.md'],
    ['docs/provisioning.md']
  ])('leaves the tokens in %s verbatim', (path) => {
    // Rendering these would rewrite the mechanism with one class's values.
    // They are reported, never written.
    expect(renderReport.rendered).not.toContain(path)
    expect(renderReport.retained).toContain(path)

    expect(readBlob(classRepo, 'HEAD', path)).toEqual(
      readBlob(fixture.path, 'HEAD', path)
    )
  })

  it('renders nothing outside the allow-list', () => {
    // Exhaustive on purpose. A new file carrying a token has to be classified
    // — class configuration, or mechanism — and this is where that decision
    // is forced rather than made silently by a content scan.
    expect(renderReport.rendered).toEqual([...CLASS_CONFIG_FILES])
    expect(renderReport.retained).toEqual([
      'docs/lab-contract.md',
      'docs/provisioning.md',
      'tools/provisioning/contract.ts'
    ])
  })

  it('leaves the class copy able to render the next class', () => {
    // The check that proves the tool did not destroy itself: a second class
    // is rendered by the first class's own delivered tooling.
    const nextOrg = 'fabrikam-global-engineering'
    const nextTeam = 'gh-intermediate-may-cohort'
    const nextClass = join(workspace, 'next-class')

    git(workspace, [
      'clone',
      '--quiet',
      '--no-hardlinks',
      fixture.path,
      nextClass
    ])
    git(nextClass, ['config', 'core.autocrlf', 'false'])

    const result = spawnSync(
      process.execPath,
      [
        '--import',
        './tools/provisioning/register.mjs',
        'tools/provisioning/cli.ts',
        'render',
        '--repo',
        nextClass,
        '--organization',
        nextOrg,
        '--class-team',
        nextTeam
      ],
      { cwd: classRepo, encoding: 'utf8' }
    )

    expect(result.status).toBe(0)
    expect(readBlob(nextClass, 'HEAD', 'labs/6-protect-main.md')).toContain(
      `* @${nextOrg}/${nextTeam}`
    )
    // The chain continues: the second class can render a third.
    expect(
      readBlob(nextClass, 'HEAD', 'tools/provisioning/contract.ts')
    ).toContain(PLACEHOLDERS.organization)
  }, 120_000)

  it.each([['organization'], ['classTeam']])(
    'refuses a %s that is still a placeholder',
    (key) => {
      expect(() =>
        renderPlaceholders(classRepo, {
          organization:
            key === 'organization' ? PLACEHOLDERS.organization : ORG,
          classTeam: key === 'classTeam' ? PLACEHOLDERS.classTeam : TEAM
        })
      ).toThrow(/not a concrete value/)
    }
  )

  it.each([['organization'], ['classTeam']])('refuses a blank %s', (key) => {
    expect(() =>
      renderPlaceholders(classRepo, {
        organization: key === 'organization' ? '   ' : ORG,
        classTeam: key === 'classTeam' ? '   ' : TEAM
      })
    ).toThrow(/not a concrete value/)
  })
})

describe('delivery bundle', () => {
  it('carries exactly the contract references and nothing else', () => {
    const path = join(workspace, 'course.bundle')
    const result = exportBundle({ repo: fixture.path, output: path })

    expect(result.refs).toEqual(['HEAD', ...intendedExportedRefs()].sort())
    expect(result.bytes).toBeGreaterThan(0)
    expect(bundleRefs(fixture.path, path)).toEqual(result.refs)
    expect(
      result.refs.filter((ref) => ref.startsWith('refs/remotes/'))
    ).toEqual([])
  }, 300_000)

  it('restores the seeded state when cloned', () => {
    const path = join(workspace, 'restore.bundle')
    exportBundle({ repo: fixture.path, output: path })

    const restored = join(workspace, 'restored')
    git(workspace, ['clone', '--quiet', path, restored])

    expect(readBlob(restored, 'HEAD', 'NOTICE')).toBeTruthy()
    expect(git(restored, ['rev-parse', 'HEAD'])).toBe(fixture.headCommit)
    expect(git(restored, ['rev-parse', `refs/remotes/origin/${'main'}`])).toBe(
      fixture.headCommit
    )
  }, 300_000)

  it('refuses to export an excluded namespace', () => {
    expect(() =>
      exportBundle({
        repo: fixture.path,
        output: join(workspace, 'bad.bundle'),
        refs: ['refs/remotes/origin/main']
      })
    ).toThrow(/excluded refs\/remotes\/ namespace/)
  })

  it('refuses to export a reference the repository lacks', () => {
    expect(() =>
      exportBundle({
        repo: fixture.path,
        output: join(workspace, 'missing.bundle'),
        refs: ['refs/heads/does-not-exist']
      })
    ).toThrow(/has no refs\/heads\/does-not-exist/)
  })
})

describe('provisioning: plan is the default and mutates nothing', () => {
  it('reports the whole run without writing', async () => {
    const { provisioner, config, requests } = harness()
    const report = await provisioner.plan(config)

    expect(report.mode).toBe('plan')
    expect(report.ok).toBe(true)
    expect(requests.every((request) => request.method === 'GET')).toBe(true)
    expect(pick(report.actions, 'repository')[0].status).toBe('create')
    expect(pick(report.actions, 'pull-request')).toHaveLength(
      SEEDED_PULL_REQUESTS.length
    )
    expect(pick(report.actions, 'seed-push')[0].status).toBe('create')
  })

  it('refuses to apply without an explicit confirmation', async () => {
    const { provisioner, config, requests } = harness()

    await expect(provisioner.apply(config, { confirm: false })).rejects.toThrow(
      /Holding a credential is not authorization/
    )
    expect(requests).toHaveLength(0)
  })
})

describe('provisioning: apply seeds real repository state', () => {
  it('creates, pushes and opens every seeded pull request', async () => {
    const { provisioner, config, service } = harness({
      participants: ['beta']
    })
    const report = await provisioner.apply(config, { confirm: true })

    expect(report.ok).toBe(true)

    const repository = service.repositories[`${ORG}/gh-intermediate-beta`]
    expect(repository.private).toBe(true)
    expect(repository.pulls).toHaveLength(SEEDED_PULL_REQUESTS.length)

    for (const seed of SEEDED_PULL_REQUESTS)
      expect(
        repository.pulls.some(
          (pull) => pull.head === seed.head && pull.base === seed.base
        )
      ).toBe(true)

    // The push is real Git against a real local remote, not a mock.
    const delivered = lsRemote(classRepo, repository.cloneUrl)
    expect(Object.keys(delivered).sort()).toEqual(
      expect.arrayContaining([...intendedExportedRefs()].sort())
    )
    expect(
      Object.keys(delivered).filter((ref) => ref.startsWith('refs/remotes/'))
    ).toEqual([])
  }, 600_000)

  it('sends a private visibility body when creating the repository', async () => {
    const { provisioner, config, requests } = harness({
      participants: ['gamma']
    })
    await provisioner.apply(config, { confirm: true })

    const create = requests.find(
      (request) =>
        request.method === 'POST' && request.url.endsWith(`/orgs/${ORG}/repos`)
    )

    expect(create).toBeDefined()
    expect(JSON.parse(create?.body ?? '{}')).toMatchObject({
      name: 'gh-intermediate-gamma',
      private: true,
      visibility: 'private'
    })
    expect(create?.headers.accept).toBe('application/vnd.github+json')
    expect(create?.headers['x-github-api-version']).toBeTruthy()
  }, 600_000)

  it('sends the documented pull request body', async () => {
    const { provisioner, config, requests } = harness({
      participants: ['delta']
    })
    await provisioner.apply(config, { confirm: true })

    const bodies = requests
      .filter(
        (request) => request.method === 'POST' && request.url.endsWith('/pulls')
      )
      .map((request) => JSON.parse(request.body ?? '{}'))

    expect(bodies).toHaveLength(SEEDED_PULL_REQUESTS.length)
    for (const body of bodies) {
      expect(Object.keys(body).sort()).toEqual([
        'base',
        'body',
        'draft',
        'head',
        'title'
      ])
      expect(body.base).toBe('main')
    }
  }, 600_000)
})

describe('provisioning: rerunning preserves existing state', () => {
  it('adds only what is missing and creates no duplicates', async () => {
    const first = harness({ participants: ['epsilon'] })
    await first.provisioner.apply(first.config, { confirm: true })

    const repository =
      first.service.repositories[`${ORG}/gh-intermediate-epsilon`]
    const before = repository.pulls.map((pull) => pull.number)

    // Drop one seeded pull request, as an interrupted run would leave things.
    const removed = repository.pulls.splice(1, 1)[0]

    const second = harness({
      participants: ['epsilon'],
      repositories: first.service.repositories
    })
    const report = await second.provisioner.apply(second.config, {
      confirm: true
    })

    expect(report.ok).toBe(true)
    expect(repository.pulls).toHaveLength(SEEDED_PULL_REQUESTS.length)
    expect(
      repository.pulls.filter((pull) => pull.head === removed.head)
    ).toHaveLength(1)

    // Everything that survived kept its identity; nothing was recreated.
    const survivors = before.filter((number) => number !== removed.number)
    expect(
      survivors.filter((number) =>
        repository.pulls.some((pull) => pull.number === number)
      )
    ).toEqual(survivors)

    expect(pick(report.actions, 'seed-push')[0].status).toBe('satisfied')
    expect(
      pick(report.actions, 'pull-request').filter(
        (action) => action.status === 'satisfied'
      )
    ).toHaveLength(SEEDED_PULL_REQUESTS.length - 1)
  }, 900_000)

  it('matches a pull request that has spilled onto a later page', async () => {
    const first = harness({ participants: ['zeta'] })
    await first.provisioner.apply(first.config, { confirm: true })

    // Two items per page puts the last seeded pull request on page two, so a
    // matcher that reads only the first page would open a duplicate.
    const second = harness({
      participants: ['zeta'],
      repositories: first.service.repositories,
      pageSize: 2
    })
    const report = await second.provisioner.apply(second.config, {
      confirm: true
    })

    const repository = first.service.repositories[`${ORG}/gh-intermediate-zeta`]

    expect(repository.pulls).toHaveLength(SEEDED_PULL_REQUESTS.length)
    expect(
      pick(report.actions, 'pull-request').every(
        (action) => action.status === 'satisfied'
      )
    ).toBe(true)
    expect(
      second.requests.some((request) => request.url.includes('page=2'))
    ).toBe(true)
  }, 900_000)
})

describe('provisioning: refusals', () => {
  it('stops when the credential resolves to a different account', async () => {
    const { provisioner, config } = harness({ operator: 'someone-else' })
    const report = await provisioner.plan(config)

    expect(report.ok).toBe(false)
    expect(pick(report.actions, 'prerequisite', 'operator')[0].detail).toMatch(
      /resolves to someone-else/
    )
    expect(pick(report.actions, 'repository')).toEqual([])
  })

  it('stops when the organization is not visible', async () => {
    const { provisioner, config } = harness({ organizations: {} })
    const report = await provisioner.plan(config)

    expect(report.ok).toBe(false)
    expect(
      pick(report.actions, 'prerequisite', `org/${ORG}`)[0].detail
    ).toMatch(/must be organization-owned/)
  })

  it('stops when the class team does not exist', async () => {
    const { provisioner, config } = harness({ organizations: { [ORG]: [] } })
    const report = await provisioner.plan(config)

    expect(report.ok).toBe(false)
    expect(pick(report.actions, 'prerequisite', `team/${TEAM}`)[0].status).toBe(
      'blocked'
    )
  })

  it('stops when the source still carries class placeholders', async () => {
    const { provisioner, config } = harness({
      config: { sourceRepository: fixture.path }
    })
    const report = await provisioner.plan(config)

    expect(report.ok).toBe(false)
    expect(
      pick(report.actions, 'prerequisite', 'class-placeholders')[0].detail
    ).toMatch(/still contains class placeholders/)
  })

  it('refuses to push over a repository that already holds history', async () => {
    const name = 'gh-intermediate-occupied'
    const remote = bareRemote(name)

    git(classRepo, [
      'push',
      '--quiet',
      remote,
      'refs/heads/main:refs/heads/main'
    ])

    const { provisioner, config } = harness({
      participants: ['occupied'],
      repositories: {
        [`${ORG}/${name}`]: fakeRepository(ORG, name, remote)
      }
    })
    const report = await provisioner.apply(config, { confirm: true })

    expect(report.ok).toBe(false)
    expect(pick(report.actions, 'seed-push')[0].detail).toMatch(
      /refusing to push over existing history/
    )
    expect(
      Object.keys(lsRemote(classRepo, remote))
        .filter((ref) => ref !== 'HEAD')
        .sort()
    ).toEqual(['refs/heads/main'])
  }, 600_000)

  it('refuses a repository that is not private', async () => {
    const name = 'gh-intermediate-public'
    const { provisioner, config } = harness({
      participants: ['public'],
      repositories: {
        [`${ORG}/${name}`]: fakeRepository(ORG, name, bareRemote(name), false)
      }
    })
    const report = await provisioner.plan(config)

    expect(report.ok).toBe(false)
    expect(pick(report.actions, 'repository')[0].detail).toMatch(
      /must be private and organization-owned/
    )
  })

  it('stops when ownership of a seeded pull request is ambiguous', async () => {
    const name = 'gh-intermediate-ambiguous'
    const repository = fakeRepository(ORG, name, bareRemote(name))
    const seed = SEEDED_PULL_REQUESTS[0]

    for (const number of [1, 2])
      repository.pulls.push({
        number,
        title: seed.title,
        head: seed.head,
        base: seed.base,
        state: 'open',
        user: OPERATOR
      })

    const { provisioner, config } = harness({
      participants: ['ambiguous'],
      repositories: { [`${ORG}/${name}`]: repository }
    })
    const report = await provisioner.plan(config)

    expect(report.ok).toBe(false)
    expect(
      pick(report.actions, 'pull-request').find(
        (action) => action.status === 'blocked'
      )?.detail
    ).toMatch(/ownership is ambiguous/)
  })

  it('does not claim a pull request opened by someone else', async () => {
    const name = 'gh-intermediate-foreign'
    const repository = fakeRepository(ORG, name, bareRemote(name))
    const seed = SEEDED_PULL_REQUESTS[0]

    repository.pulls.push({
      number: 7,
      title: seed.title,
      head: seed.head,
      base: seed.base,
      state: 'open',
      user: 'a-learner'
    })

    const { provisioner, config } = harness({
      participants: ['foreign'],
      repositories: { [`${ORG}/${name}`]: repository }
    })
    const report = await provisioner.plan(config)

    expect(
      pick(
        report.actions,
        'pull-request',
        `${name}#${seed.head}->${seed.base}`
      )[0].status
    ).toBe('create')
  })

  it('reports a permission failure instead of continuing', async () => {
    const { provisioner, config } = harness({
      participants: ['denied'],
      denied: [`POST /orgs/${ORG}/repos`]
    })
    const report = await provisioner.apply(config, { confirm: true })

    expect(report.ok).toBe(false)
    expect(pick(report.actions, 'repository')[0].detail).toMatch(/403/)
  })
})

describe('provisioning: GitHub Pages', () => {
  it('refuses to publish without an asserted private eligibility', async () => {
    const { provisioner, config } = harness({
      participants: ['pages-unasserted'],
      config: { enablePages: true }
    })
    const report = await provisioner.plan(config)

    expect(report.pagesEligibility).toBe('not-asserted')
    expect(pick(report.actions, 'pages')[0].status).toBe('blocked')
  })

  it('enables a workflow build once eligibility is asserted', async () => {
    const { provisioner, config, service, requests } = harness({
      participants: ['pages'],
      config: { enablePages: true, privatePagesConfirmed: true }
    })
    const report = await provisioner.apply(config, { confirm: true })

    expect(report.ok).toBe(true)
    expect(report.pagesEligibility).toBe('operator-asserted')
    expect(service.repositories[`${ORG}/gh-intermediate-pages`].pages).toEqual({
      build_type: 'workflow',
      public: false
    })

    const call = requests.find(
      (request) => request.method === 'POST' && request.url.endsWith('/pages')
    )
    expect(JSON.parse(call?.body ?? '{}')).toEqual({ build_type: 'workflow' })
  }, 600_000)

  it('refuses to replace an existing Pages configuration', async () => {
    const name = 'gh-intermediate-legacy'
    const repository = fakeRepository(ORG, name, bareRemote(name))
    repository.pages = { build_type: 'legacy', public: false }

    const { provisioner, config } = harness({
      participants: ['legacy'],
      repositories: { [`${ORG}/${name}`]: repository },
      config: { enablePages: true, privatePagesConfirmed: true }
    })
    const report = await provisioner.plan(config)

    expect(pick(report.actions, 'pages')[0].detail).toMatch(
      /refusing to replace an existing configuration/
    )
  })

  it('refuses to publish from a public repository', async () => {
    const name = 'gh-intermediate-exposed'
    const { provisioner, config } = harness({
      participants: ['exposed'],
      repositories: {
        [`${ORG}/${name}`]: fakeRepository(ORG, name, bareRemote(name), false)
      },
      config: { enablePages: true, privatePagesConfirmed: true }
    })
    const report = await provisioner.plan(config)

    expect(report.ok).toBe(false)
    expect(pick(report.actions, 'repository')[0].status).toBe('blocked')
  })
})

describe('provisioning: rulesets are opt-in', () => {
  it('applies none by default, leaving Lab 6 to the learner', async () => {
    const { provisioner, config } = harness({ participants: ['no-rules'] })
    const report = await provisioner.plan(config)

    expect(pick(report.actions, 'ruleset')).toEqual([])
  })

  it('sends the documented ruleset body when one is configured', async () => {
    const { provisioner, config, requests } = harness({
      participants: ['rules'],
      config: {
        rulesets: [{ name: 'protect-main', enforcement: 'active' }]
      }
    })
    await provisioner.apply(config, { confirm: true })

    const call = requests.find(
      (request) =>
        request.method === 'POST' && request.url.endsWith('/rulesets')
    )

    expect(JSON.parse(call?.body ?? '{}')).toMatchObject({
      name: 'protect-main',
      target: 'branch',
      enforcement: 'active',
      conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } }
    })
  }, 600_000)
})

describe('nextPageLink', () => {
  it('reads the next page address', () => {
    expect(
      nextPageLink(
        '<https://api.github.com/x?page=2>; rel="next", <y>; rel="last"'
      )
    ).toBe('https://api.github.com/x?page=2')
  })

  it.each([undefined, '', '<y>; rel="last"'])(
    'returns nothing for %p',
    (link) => {
      expect(nextPageLink(link)).toBeUndefined()
    }
  )
})
