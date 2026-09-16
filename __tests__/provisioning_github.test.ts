/** @jest-environment node */
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from 'node:fs'
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
import {
  git,
  lsRemote,
  pushRefs,
  readBlob,
  tryGit
} from '../tools/provisioning/git.js'
import { formatReport, parseOptions } from '../tools/provisioning/cli.js'
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
  type ProvisioningConfig,
  type ProvisionerDeps
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
    deps?: Pick<ProvisionerDeps, 'push' | 'remoteRefs'>
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
    provisioner: new Provisioner({ api, ...options.deps }),
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
    ['docs/provisioning.md'],
    ['labs/0-clone-the-repository.md']
  ])('leaves the tokens in %s verbatim', (path) => {
    // The mechanism stays generic. Lab 0 also keeps its URL templates: the
    // learner substitutes both owner and repository from their own assigned URL.
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
      'labs/0-clone-the-repository.md',
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
  it('preserves learner commits, extra refs and edited resources on a rerun', async () => {
    const first = harness({ participants: ['learner-work'] })
    await first.provisioner.apply(first.config, { confirm: true })
    const repository =
      first.service.repositories[`${ORG}/gh-intermediate-learner-work`]
    const head = git(classRepo, ['rev-parse', 'HEAD'])
    const learnerCommit = git(classRepo, [
      'commit-tree',
      `${head}^{tree}`,
      '-p',
      head,
      '-m',
      'Learner work after provisioning'
    ])
    git(classRepo, [
      'push',
      '--quiet',
      repository.cloneUrl,
      `${learnerCommit}:refs/heads/main`,
      `${learnerCommit}:refs/heads/feature/learner-work`
    ])
    repository.pulls[0].state = 'closed'
    repository.pulls[0].title = 'Edited by the learner'
    repository.issues.push({
      number: 801,
      title: 'Learner issue',
      state: 'open',
      user: 'learner'
    })
    repository.rulesets.push({
      id: 802,
      name: 'Learner ruleset',
      target: 'branch',
      enforcement: 'active'
    })
    repository.pages = { build_type: 'workflow', public: false }
    const beforeRefs = lsRemote(classRepo, repository.cloneUrl)
    const beforeRepository = structuredClone(repository)

    const second = harness({
      participants: ['learner-work'],
      repositories: first.service.repositories,
      config: { enablePages: true, privatePagesConfirmed: true }
    })
    const report = await second.provisioner.apply(second.config, {
      confirm: true
    })

    expect(report.ok).toBe(true)
    expect(second.requests.every((request) => request.method === 'GET')).toBe(
      true
    )
    expect(lsRemote(classRepo, repository.cloneUrl)).toEqual(beforeRefs)
    expect(repository).toEqual(beforeRepository)
    expect(repository.pulls).toHaveLength(SEEDED_PULL_REQUESTS.length)
  }, 600_000)

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
  it.each(['plan', 'apply'] as const)(
    '%s blocks unasserted eligibility before any write or push',
    async (mode) => {
      const participant = `pages-unasserted-${mode}`
      const { provisioner, config, service, requests } = harness({
        participants: [participant, `${participant}-later`],
        config: { enablePages: true, privatePagesConfirmed: false }
      })
      const report =
        mode === 'plan'
          ? await provisioner.plan(config)
          : await provisioner.apply(config, { confirm: true })

      expect(requests.every((request) => request.method === 'GET')).toBe(true)
      expect(service.repositories).toEqual({})
      expect(
        existsSync(
          join(workspace, 'remotes', `gh-intermediate-${participant}.git`)
        )
      ).toBe(false)
      expect(report.pagesEligibility).toBe('not-asserted')
      expect(pick(report.actions, 'pages')[0].status).toBe('blocked')
    }
  )

  it.each(['plan', 'apply'] as const)(
    '%s accepts only an existing private workflow site without changing it',
    async (mode) => {
      const participant = `private-pages-${mode}`
      const name = `gh-intermediate-${participant}`
      const repository = fakeRepository(ORG, name, bareRemote(name))
      pushRefs(classRepo, repository.cloneUrl, intendedExportedRefs())
      repository.pages = { build_type: 'workflow', public: false }
      const beforeRefs = lsRemote(classRepo, repository.cloneUrl)
      const { provisioner, config, requests } = harness({
        participants: [participant],
        repositories: { [`${ORG}/${name}`]: repository },
        config: { enablePages: true, privatePagesConfirmed: true }
      })
      const report =
        mode === 'plan'
          ? await provisioner.plan(config)
          : await provisioner.apply(config, { confirm: true })

      expect(report.ok).toBe(true)
      expect(report.pagesEligibility).toBe('operator-asserted')
      expect(pick(report.actions, 'pages')[0].status).toBe('satisfied')
      expect(
        requests.filter((request) => request.url.endsWith('/pages'))
      ).toEqual([expect.objectContaining({ method: 'GET' })])
      expect(repository.pages).toEqual({
        build_type: 'workflow',
        public: false
      })
      expect(lsRemote(classRepo, repository.cloneUrl)).toEqual(beforeRefs)
    },
    600_000
  )

  const unsafeSites = [
    ['public', { build_type: 'workflow', public: true }],
    ['unknown', { build_type: 'workflow' }],
    ['null', { build_type: 'workflow', public: null }],
    ['string-false', { build_type: 'workflow', public: 'false' }],
    ['legacy', { build_type: 'legacy', public: false }],
    ['missing', undefined]
  ] as const

  it.each(
    (['plan', 'apply'] as const).flatMap((mode) =>
      unsafeSites.map(([label, site]) => ({ mode, label, site }))
    )
  )(
    '$mode refuses $label Pages without creating or updating a site',
    async ({ mode, label, site }) => {
      const participant = `unsafe-pages-${label}-${mode}`
      const name = `gh-intermediate-${participant}`
      const repository = fakeRepository(ORG, name, bareRemote(name))
      // Raw JSON deliberately represents incomplete or malformed API responses.
      repository.pages =
        site === undefined ? undefined : JSON.parse(JSON.stringify(site))
      const beforeSite = structuredClone(repository.pages)
      const { provisioner, config, service, requests } = harness({
        participants: [participant, `${participant}-later`],
        repositories: { [`${ORG}/${name}`]: repository },
        config: { enablePages: true, privatePagesConfirmed: true }
      })
      const report =
        mode === 'plan'
          ? await provisioner.plan(config)
          : await provisioner.apply(config, { confirm: true })

      expect(
        requests.filter(
          (request) =>
            request.url.endsWith('/pages') && request.method !== 'GET'
        )
      ).toEqual([])
      expect(repository.pages).toEqual(beforeSite)
      expect(pick(report.actions, 'pages', name)[0].status).toBe('blocked')
      expect(pick(report.actions, 'pages', name)[0].detail).toMatch(
        /admin|administrator/i
      )
      expect(report.ok).toBe(false)
      expect(lsRemote(classRepo, repository.cloneUrl)).toEqual({})
      expect(requests.every((request) => request.method === 'GET')).toBe(true)
      expect(Object.keys(service.repositories)).toEqual([`${ORG}/${name}`])
    },
    600_000
  )

  it('plans missing Pages as a manual prerequisite, not an API create', async () => {
    const { provisioner, config, requests } = harness({
      participants: ['new-pages-plan'],
      config: { enablePages: true, privatePagesConfirmed: true }
    })
    const report = await provisioner.plan(config)

    expect(pick(report.actions, 'pages')[0].status).toBe('blocked')
    expect(pick(report.actions, 'pages')[0].detail).toMatch(/enablePages=false/)
    expect(requests.every((request) => request.method === 'GET')).toBe(true)
  })

  it('keeps initial provisioning independent of Pages when enablePages is false', async () => {
    const { provisioner, config, service, requests } = harness({
      participants: ['pages-disabled'],
      config: { enablePages: false, privatePagesConfirmed: false }
    })
    const report = await provisioner.apply(config, { confirm: true })
    const repository =
      service.repositories[`${ORG}/gh-intermediate-pages-disabled`]

    expect(report.ok).toBe(true)
    expect(repository.pages).toBeUndefined()
    expect(repository.pulls).toHaveLength(SEEDED_PULL_REQUESTS.length)
    expect(
      requests.filter((request) => request.url.endsWith('/pages'))
    ).toEqual([])
    expect(Object.keys(lsRemote(classRepo, repository.cloneUrl))).toEqual(
      expect.arrayContaining(intendedExportedRefs())
    )
  }, 600_000)

  it('does not make the fake site private just because its repository is private', async () => {
    const name = 'gh-intermediate-fake-pages-control'
    const repository = fakeRepository(ORG, name, bareRemote(name))
    const service = new FakeGitHub({
      repositories: { [`${ORG}/${name}`]: repository }
    })
    const api = new GitHubApi({ client: service, token: 'fake-token' })

    await api.json(
      'POST',
      `/repos/${ORG}/${name}/pages`,
      { build_type: 'workflow' },
      [201]
    )

    expect(repository.private).toBe(true)
    expect(repository.pages?.public).toBe(true)
  })

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

describe('provisioning: write mode stops at the first block', () => {
  const deniedOperations = [
    ['repository-read', 'GET', 'repository'],
    ['repository-create', 'POST', 'repository'],
    ['pulls-read', 'GET', 'pulls'],
    ['pulls-create', 'POST', 'pulls'],
    ['issues-read', 'GET', 'issues'],
    ['issues-create', 'POST', 'issues'],
    ['rulesets-read', 'GET', 'rulesets'],
    ['rulesets-create', 'POST', 'rulesets'],
    ['pages-read', 'GET', 'pages']
  ] as const

  it.each(deniedOperations)(
    'stops after denied %s without trying another item, group or participant',
    async (label, method, resource) => {
      const participant = `blocked-${label}`
      const name = `gh-intermediate-${participant}`
      const path =
        resource === 'repository'
          ? method === 'POST'
            ? `/orgs/${ORG}/repos`
            : `/repos/${ORG}/${name}`
          : `/repos/${ORG}/${name}/${resource}`
      const { provisioner, config, service, requests } = harness({
        participants: [participant, `${participant}-later`],
        denied: [`${method} ${path}`],
        config: {
          issues: [
            { title: 'First issue', body: 'First' },
            { title: 'Second issue', body: 'Second' }
          ],
          rulesets: [
            { name: 'first-ruleset', enforcement: 'active' },
            { name: 'second-ruleset', enforcement: 'active' }
          ],
          enablePages: resource === 'pages',
          privatePagesConfirmed: true
        }
      })
      const report = await provisioner.apply(config, { confirm: true })
      const deniedIndex = requests.findIndex(
        (request) =>
          request.method === method && new URL(request.url).pathname === path
      )

      expect(deniedIndex).toBeGreaterThanOrEqual(0)
      expect(requests.slice(deniedIndex + 1)).toEqual([])
      expect(service.repositories[`${ORG}/${name}-later`]).toBeUndefined()
      expect(existsSync(join(workspace, 'remotes', `${name}-later.git`))).toBe(
        false
      )
      expect(report.ok).toBe(false)
      expect(report.actions.at(-1)?.status).toBe('blocked')
    },
    600_000
  )

  it('stops after a real local seed push denial and leaves the remote empty', async () => {
    const participant = 'seed-denied'
    const name = `gh-intermediate-${participant}`
    const remote = bareRemote(name)
    writeFileSync(join(remote, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n', {
      mode: 0o755
    })
    const repository = fakeRepository(ORG, name, remote)
    const { provisioner, config, service, requests } = harness({
      participants: [participant, `${participant}-later`],
      repositories: { [`${ORG}/${name}`]: repository },
      config: {
        issues: [{ title: 'Must not be created', body: '' }],
        rulesets: [{ name: 'must-not-be-created', enforcement: 'active' }]
      }
    })
    const report = await provisioner.apply(config, { confirm: true })

    expect(lsRemote(classRepo, remote)).toEqual({})
    expect(repository.pulls).toEqual([])
    expect(repository.issues).toEqual([])
    expect(repository.rulesets).toEqual([])
    expect(service.repositories[`${ORG}/${name}-later`]).toBeUndefined()
    expect(requests.every((request) => request.method === 'GET')).toBe(true)
    expect(report.actions.at(-1)?.kind).toBe('seed-push')
    expect(report.actions.at(-1)?.status).toBe('blocked')
  }, 600_000)

  it.each(['partial-push', 'verification-read-fails'] as const)(
    'stops after %s without rolling back the refs already written',
    async (failure) => {
      let reads = 0
      const { provisioner, config, service, requests } = harness({
        participants: [failure, `${failure}-later`],
        deps:
          failure === 'partial-push'
            ? {
                push: (repo, remote) =>
                  pushRefs(repo, remote, ['refs/heads/main'])
              }
            : {
                remoteRefs: (repo, remote) => {
                  reads += 1
                  if (reads === 2)
                    throw new Error('Local post-push verification denied')
                  return lsRemote(repo, remote)
                }
              }
      })
      const report = await provisioner.apply(config, { confirm: true })
      const repository =
        service.repositories[`${ORG}/gh-intermediate-${failure}`]
      const refs = Object.keys(lsRemote(classRepo, repository.cloneUrl))
        .filter((ref) => ref !== 'HEAD')
        .sort()

      expect(refs).toEqual(
        failure === 'partial-push'
          ? ['refs/heads/main']
          : [
              ...intendedExportedRefs(),
              `refs/tags/${fixture.bisect.anchorTag}^{}`
            ].sort()
      )
      expect(repository.pulls).toEqual([])
      expect(
        service.repositories[`${ORG}/gh-intermediate-${failure}-later`]
      ).toBeUndefined()
      expect(
        requests.filter((request) => request.method !== 'GET')
      ).toHaveLength(1)
      expect(report.actions.at(-1)?.kind).toBe('seed-push')
      expect(report.actions.at(-1)?.status).toBe('blocked')
      expect(formatReport(report)).toMatch(/earlier completed actions remain/i)
      expect(formatReport(report)).toMatch(/no rollback/i)
    },
    600_000
  )

  it.each(['pulls', 'issues'] as const)(
    'stops at ambiguous %s without writing the next item',
    async (resource) => {
      const participant = `ambiguous-write-${resource}`
      const name = `gh-intermediate-${participant}`
      const repository = fakeRepository(ORG, name, bareRemote(name))
      const seed = SEEDED_PULL_REQUESTS[0]
      for (const number of [901, 902]) {
        if (resource === 'pulls')
          repository.pulls.push({
            number,
            title: seed.title,
            head: seed.head,
            base: seed.base,
            state: 'open',
            user: OPERATOR
          })
        else
          repository.issues.push({
            number,
            title: 'Ambiguous issue',
            state: 'open',
            user: OPERATOR
          })
      }
      const { provisioner, config, service, requests } = harness({
        participants: [participant, `${participant}-later`],
        repositories: { [`${ORG}/${name}`]: repository },
        config: {
          issues: [
            { title: 'Ambiguous issue', body: '' },
            { title: 'Must not be created', body: '' }
          ],
          rulesets: [{ name: 'must-not-be-created', enforcement: 'active' }]
        }
      })
      const report = await provisioner.apply(config, { confirm: true })
      const blockedRead = requests.findIndex(
        (request) =>
          new URL(request.url).pathname === `/repos/${ORG}/${name}/${resource}`
      )

      expect(requests.slice(blockedRead + 1)).toEqual([])
      expect(repository[resource]).toHaveLength(2)
      expect(repository.rulesets).toEqual([])
      expect(service.repositories[`${ORG}/${name}-later`]).toBeUndefined()
      expect(report.ok).toBe(false)
    },
    600_000
  )

  it('keeps completed participants while leaving later participants untouched', async () => {
    const { provisioner, config, service } = harness({
      participants: ['completed-first', 'blocked-second', 'untouched-third'],
      denied: [`POST /repos/${ORG}/gh-intermediate-blocked-second/pulls`]
    })
    const report = await provisioner.apply(config, { confirm: true })
    const first = service.repositories[`${ORG}/gh-intermediate-completed-first`]
    const second = service.repositories[`${ORG}/gh-intermediate-blocked-second`]

    expect(first.pulls).toHaveLength(SEEDED_PULL_REQUESTS.length)
    expect(Object.keys(lsRemote(classRepo, first.cloneUrl))).toEqual(
      expect.arrayContaining(intendedExportedRefs())
    )
    expect(Object.keys(lsRemote(classRepo, second.cloneUrl))).toEqual(
      expect.arrayContaining(intendedExportedRefs())
    )
    expect(
      service.repositories[`${ORG}/gh-intermediate-untouched-third`]
    ).toBeUndefined()
    expect(formatReport(report)).toMatch(/earlier completed actions remain/i)
    expect(formatReport(report)).toMatch(/no rollback/i)
  }, 600_000)

  it('allows a read-only plan to report later participants without claiming it stopped', async () => {
    const name = 'gh-intermediate-plan-blocked'
    const repository = fakeRepository(ORG, name, bareRemote(name), false)
    const { provisioner, config, requests } = harness({
      participants: ['plan-blocked', 'plan-later'],
      repositories: { [`${ORG}/${name}`]: repository }
    })
    const report = await provisioner.plan(config)

    expect(requests.every((request) => request.method === 'GET')).toBe(true)
    expect(pick(report.actions, 'repository')).toHaveLength(2)
    expect(formatReport(report)).not.toContain('Nothing further was attempted')
    expect(formatReport(report)).toMatch(/read.only|no writes/i)
  })
})

describe('provisioning CLI: safety values', () => {
  /**
   * Runs the real CLI locally, with live API authentication explicitly absent.
   *
   * @param args CLI arguments.
   * @returns The child process result.
   */
  function cli(args: string[]) {
    return spawnSync(
      process.execPath,
      [
        '--import',
        './tools/provisioning/register.mjs',
        'tools/provisioning/cli.ts',
        ...args
      ],
      { cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_TOKEN: '' } }
    )
  }

  it.each(
    ['enablePages', 'privatePagesConfirmed'].flatMap((key) =>
      ['false', 'true', 0, 1, null, {}, []].map((value, index) => ({
        key,
        value,
        index
      }))
    )
  )(
    'rejects $key=$value at the boundary before live authentication',
    ({ key, value, index }) => {
      const path = join(workspace, `invalid-${key}-${index}.json`)
      writeFileSync(path, JSON.stringify({ ...harness().config, [key]: value }))

      const result = cli(['plan', '--config', path])

      expect(result.status).toBe(1)
      expect(result.stderr).toContain(`Configuration ${key} must be a boolean`)
      expect(result.stderr).not.toContain('GITHUB_TOKEN is not set')
    }
  )

  it.each([
    ['--confirm', 'false'],
    ['--confirm', 'true'],
    ['--confirm=false'],
    ['--confirm=true'],
    ['--confirm', 'false', '--confirm'],
    ['--help', 'false'],
    ['--help=false']
  ])(
    'rejects valued flags %j instead of coercing or ignoring them',
    (...args) => {
      expect(() => parseOptions(args)).toThrow(/flag.*value|value.*flag/i)
    }
  )

  it('retains the explicit bare confirmation flag', () => {
    expect(parseOptions(['--config', 'class.json', '--confirm'])).toEqual({
      config: 'class.json',
      confirm: true
    })
  })

  it('uses read-only plan when only configuration options are supplied', () => {
    const path = join(workspace, 'default-plan.json')
    writeFileSync(
      path,
      JSON.stringify({ ...harness().config, enablePages: 'false' })
    )

    const result = cli(['--config', path])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(
      'Configuration enablePages must be a boolean'
    )
  })

  it.each([false, true])(
    'rehearses the two-phase contract with enablePages=%s',
    (enablePages) => {
      const path = join(workspace, `dry-run-pages-${enablePages}.json`)
      writeFileSync(
        path,
        JSON.stringify({
          ...harness().config,
          participants: [`cli-pages-${enablePages}`],
          enablePages,
          privatePagesConfirmed: enablePages
        })
      )

      const result = cli(['dry-run', '--config', path])

      expect(result.status).toBe(enablePages ? 1 : 0)
      expect(result.stdout).toContain('local fake service')
      const expected = enablePages
        ? [/admin|administrator/i, /enablePages=false/]
        : [/none blocked/]
      for (const message of expected) expect(result.stdout).toMatch(message)
    },
    600_000
  )
})

describe('remote Git authentication configuration', () => {
  it.each(['read', 'push'] as const)(
    'honors customer Git configuration for %s, but still isolates fixture commands',
    (operation) => {
      const remote = bareRemote(`auth-config-${operation}`)
      const globalConfig = join(workspace, `git-auth-${operation}.config`)
      // A local URL rewrite stands in for customer Git configuration. The
      // unsupported scheme fails locally if that config is ignored.
      const alias = 'fixture-auth://class'
      writeFileSync(
        globalConfig,
        `[url "${remote.replace(/\\/g, '/')}"]\n\tinsteadOf = ${alias}\n`
      )
      const previous = process.env.GIT_CONFIG_GLOBAL
      process.env.GIT_CONFIG_GLOBAL = globalConfig
      try {
        pushRefs(classRepo, operation === 'push' ? alias : remote, [
          'refs/heads/main'
        ])
        const advertised = lsRemote(
          classRepo,
          operation === 'read' ? alias : remote
        )
        expect(advertised).toEqual(lsRemote(classRepo, remote))
        expect(advertised['refs/heads/main']).toBe(
          git(classRepo, ['rev-parse', 'refs/heads/main'])
        )
        expect(tryGit(classRepo, ['ls-remote', alias]).status).not.toBe(0)
      } finally {
        if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL
        else process.env.GIT_CONFIG_GLOBAL = previous
      }
    },
    600_000
  )

  it('does not let customer push.followTags widen the enumerated push', () => {
    const source = join(workspace, 'follow-tags-source')
    git(workspace, ['clone', '--quiet', '--no-hardlinks', classRepo, source])
    git(source, [
      'tag',
      '--annotate',
      '--message',
      'Not for export',
      'maintenance-only'
    ])
    const remote = bareRemote('follow-tags-target')
    const globalConfig = join(workspace, 'follow-tags.config')
    writeFileSync(globalConfig, '[push]\n\tfollowTags = true\n')
    const previous = process.env.GIT_CONFIG_GLOBAL
    process.env.GIT_CONFIG_GLOBAL = globalConfig
    try {
      pushRefs(source, remote, ['refs/heads/main'])
      expect(Object.keys(lsRemote(source, remote)).sort()).toEqual([
        'HEAD',
        'refs/heads/main'
      ])
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = previous
    }
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
