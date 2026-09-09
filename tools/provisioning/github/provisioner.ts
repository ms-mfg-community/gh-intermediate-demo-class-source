/**
 * Per-student repository provisioning.
 *
 * `plan` is the default verb and mutates nothing. `apply` requires an explicit
 * opt-in and an operator identity that matches the configuration: holding a
 * credential is not authorization to use it against a classroom.
 *
 * Every write is preceded by a read. Resources are matched by stable identity
 * — a pull request by its head and base branches plus the seeding identity,
 * never by its title, because Lab 8 seeds two pairs that deliberately share a
 * title. Nothing is ever deleted, replaced wholesale, or downgraded to a
 * success-shaped default when a check cannot be completed.
 */
import {
  DEFAULT_BRANCH,
  SEEDED_ISSUES,
  SEEDED_PULL_REQUESTS,
  intendedExportedRefs
} from '../contract.js'
import { findPlaceholders } from '../fixture.js'
import { lsRemote, pushRefs } from '../git.js'
import { GitHubApi, GitHubError } from './client.js'

/** What a planned action would do, or why it cannot be done. */
export type ActionStatus = 'create' | 'satisfied' | 'blocked'

export interface PlannedAction {
  /** Resource class the action concerns. */
  kind:
    | 'prerequisite'
    | 'repository'
    | 'seed-push'
    | 'pull-request'
    | 'issue'
    | 'ruleset'
    | 'pages'
  /** Stable identity of the resource. */
  target: string
  status: ActionStatus
  /** Human-readable explanation, quoting the failure when blocked. */
  detail: string
}

export interface RulesetSpec {
  name: string
  target?: 'branch' | 'tag' | 'push'
  enforcement: 'active' | 'evaluate' | 'disabled'
  conditions?: unknown
  rules?: unknown[]
}

export interface ProvisioningConfig {
  /** Organization that owns every classroom repository. */
  organization: string
  /** Team named by the `CODEOWNERS` file the learner writes in Lab 6. */
  classTeam: string
  /** Prefix for per-student repository names. */
  repositoryPrefix: string
  /** Per-student repository name suffixes. */
  participants: string[]
  /** Local repository the seeded state is pushed from. */
  sourceRepository: string
  /** Login the credential must resolve to before anything is written. */
  expectedOperator: string
  /** Whether to enable Pages through the REST API. */
  enablePages?: boolean
  /**
   * Operator's assertion that this organization may publish a Pages site that
   * is not publicly readable. The API cannot establish it, so it is reported
   * as asserted rather than verified, and Pages is skipped without it.
   */
  privatePagesConfirmed?: boolean
  /** Rulesets to apply. Empty by default: Lab 6 is the learner's exercise. */
  rulesets?: RulesetSpec[]
  /** Issues to seed. Empty by default; no lab depends on one. */
  issues?: readonly { title: string; body: string }[]
}

export interface ProvisioningReport {
  /** Verb that produced the report. */
  mode: 'plan' | 'apply'
  actions: PlannedAction[]
  /** How Pages eligibility was established, when Pages was requested. */
  pagesEligibility?: 'operator-asserted' | 'not-asserted'
  /** True when nothing is blocked. */
  ok: boolean
}

interface ApiPullRequest {
  number: number
  title: string
  state: string
  user: { login: string }
  head: { ref: string }
  base: { ref: string }
}

interface ApiIssue {
  number: number
  title: string
  user: { login: string }
}

interface ApiRepository {
  name: string
  full_name: string
  private: boolean
  visibility?: string
  clone_url: string
  owner: { login: string; type?: string }
}

export interface ProvisionerDeps {
  api: GitHubApi
  /** Pushes an enumerated reference set. Injected so tests use a local remote. */
  push?: (repo: string, remote: string, refs: string[]) => void
  /** Reads a remote's references. Injected so tests use a local remote. */
  remoteRefs?: (repo: string, remote: string) => Record<string, string>
}

/**
 * Plans and applies classroom provisioning.
 */
export class Provisioner {
  private readonly api: GitHubApi
  private readonly push: (repo: string, remote: string, refs: string[]) => void
  private readonly remoteRefs: (
    repo: string,
    remote: string
  ) => Record<string, string>

  constructor(deps: ProvisionerDeps) {
    this.api = deps.api
    this.push = deps.push ?? pushRefs
    this.remoteRefs = deps.remoteRefs ?? lsRemote
  }

  /**
   * Reports what provisioning would do, without writing anything.
   *
   * @param config Runtime inputs.
   * @returns The planned actions.
   */
  async plan(config: ProvisioningConfig): Promise<ProvisioningReport> {
    return this.run(config, false)
  }

  /**
   * Performs the actions a plan reports as missing.
   *
   * @param config Runtime inputs.
   * @param options Must set `confirm` to true.
   * @returns What was done.
   * @throws If the run was not explicitly confirmed.
   */
  async apply(
    config: ProvisioningConfig,
    options: { confirm: boolean }
  ): Promise<ProvisioningReport> {
    if (options.confirm !== true)
      throw new Error(
        'Refusing to apply: pass confirm to authorize writes. Holding a ' +
          'credential is not authorization to use it.'
      )

    return this.run(config, true)
  }

  /**
   * Runs the provisioning sequence in either mode.
   *
   * @param config Runtime inputs.
   * @param write Whether to perform writes.
   * @returns The report.
   */
  private async run(
    config: ProvisioningConfig,
    write: boolean
  ): Promise<ProvisioningReport> {
    const actions: PlannedAction[] = []
    const mode = write ? 'apply' : 'plan'
    const prerequisites = await this.checkPrerequisites(config)
    actions.push(...prerequisites)

    const pagesEligibility = config.enablePages
      ? config.privatePagesConfirmed
        ? ('operator-asserted' as const)
        : ('not-asserted' as const)
      : undefined

    if (prerequisites.some((action) => action.status === 'blocked'))
      return { mode, actions, pagesEligibility, ok: false }

    for (const participant of config.participants) {
      const name = `${config.repositoryPrefix}-${participant}`
      const repository = await this.reconcileRepository(config, name, write)
      actions.push(repository.action)

      if (!repository.repo) {
        // In plan mode the repository does not exist yet, so its contents
        // cannot be read. Report the work the run would still do rather than
        // presenting a plan that stops at repository creation.
        if (!write && repository.action.status === 'create')
          actions.push(...this.plannedForNewRepository(config, name))
        continue
      }

      actions.push(
        await this.reconcileSeedPush(config, name, repository.repo, write)
      )
      actions.push(...(await this.reconcilePullRequests(config, name, write)))
      actions.push(...(await this.reconcileIssues(config, name, write)))
      actions.push(...(await this.reconcileRulesets(config, name, write)))

      if (config.enablePages)
        actions.push(
          await this.reconcilePages(config, name, repository.repo, write)
        )
    }

    return {
      mode,
      actions,
      pagesEligibility,
      ok: actions.every((action) => action.status !== 'blocked')
    }
  }

  /**
   * Lists the work a repository would need immediately after creation.
   *
   * @param config Runtime inputs.
   * @param name Repository name.
   * @returns Actions describing the seeding that would follow.
   */
  private plannedForNewRepository(
    config: ProvisioningConfig,
    name: string
  ): PlannedAction[] {
    const actions: PlannedAction[] = [
      {
        kind: 'seed-push',
        target: name,
        status: 'create',
        detail: `Push ${intendedExportedRefs().length} references into the new ${name}`
      },
      ...SEEDED_PULL_REQUESTS.map((seed) => ({
        kind: 'pull-request' as const,
        target: `${name}#${seed.head}->${seed.base}`,
        status: 'create' as const,
        detail: `Open ${seed.head} into ${seed.base} for Lab ${seed.lab}`
      })),
      ...(config.issues ?? SEEDED_ISSUES).map((seed) => ({
        kind: 'issue' as const,
        target: `${name}!${seed.title}`,
        status: 'create' as const,
        detail: `Open issue ${seed.title}`
      })),
      ...(config.rulesets ?? []).map((spec) => ({
        kind: 'ruleset' as const,
        target: `${name}/${spec.name}`,
        status: 'create' as const,
        detail: `Create ruleset ${spec.name} with enforcement ${spec.enforcement}`
      }))
    ]

    if (config.enablePages)
      actions.push({
        kind: 'pages',
        target: name,
        status: config.privatePagesConfirmed ? 'create' : 'blocked',
        detail: config.privatePagesConfirmed
          ? 'Enable Pages with build_type workflow (eligibility: operator-asserted)'
          : 'Private Pages eligibility has not been asserted for this organization'
      })

    return actions
  }

  /**
   * Verifies the organization, team, operator identity and source repository.
   *
   * @param config Runtime inputs.
   * @returns One action per prerequisite.
   */
  private async checkPrerequisites(
    config: ProvisioningConfig
  ): Promise<PlannedAction[]> {
    const actions: PlannedAction[] = []

    const operator = await this.attempt<{ login: string }>(
      () => this.api.find('/user'),
      (login) =>
        login === undefined
          ? {
              status: 'blocked',
              detail: 'The credential does not resolve to an account'
            }
          : login.login === config.expectedOperator
            ? { status: 'satisfied', detail: `Operating as ${login.login}` }
            : {
                status: 'blocked',
                detail: `Credential resolves to ${login.login}, but the configuration expects ${config.expectedOperator}`
              }
    )
    actions.push({ kind: 'prerequisite', target: 'operator', ...operator })

    const org = await this.attempt<{ login: string }>(
      () => this.api.find(`/orgs/${config.organization}`),
      (found) =>
        found
          ? {
              status: 'satisfied',
              detail: `Organization ${found.login} exists`
            }
          : {
              status: 'blocked',
              detail: `Organization ${config.organization} is not visible to this credential. Classroom repositories must be organization-owned; a user-owned repository cannot carry rulesets or publish Pages.`
            }
    )
    actions.push({
      kind: 'prerequisite',
      target: `org/${config.organization}`,
      ...org
    })

    const team = await this.attempt<{ slug: string }>(
      () =>
        this.api.find(`/orgs/${config.organization}/teams/${config.classTeam}`),
      (found) =>
        found
          ? { status: 'satisfied', detail: `Team ${found.slug} exists` }
          : {
              status: 'blocked',
              detail: `Team ${config.classTeam} does not exist in ${config.organization}; Lab 6 CODEOWNERS would name a team nobody can review as`
            }
    )
    actions.push({
      kind: 'prerequisite',
      target: `team/${config.classTeam}`,
      ...team
    })

    const unrendered = findPlaceholders(config.sourceRepository, 'HEAD')
    actions.push({
      kind: 'prerequisite',
      target: 'class-placeholders',
      status: unrendered.length === 0 ? 'satisfied' : 'blocked',
      detail:
        unrendered.length === 0
          ? 'Source repository carries no unsubstituted placeholders'
          : `Source repository still contains class placeholders in ${unrendered.join(', ')}; render them before provisioning`
    })

    return actions
  }

  /**
   * Creates the per-student repository when it is absent.
   *
   * @param config Runtime inputs.
   * @param name Repository name.
   * @param write Whether to perform writes.
   * @returns The action and, when available, the repository.
   */
  private async reconcileRepository(
    config: ProvisioningConfig,
    name: string,
    write: boolean
  ): Promise<{ action: PlannedAction; repo?: ApiRepository }> {
    const path = `/repos/${config.organization}/${name}`
    let existing: ApiRepository | undefined

    try {
      existing = await this.api.find<ApiRepository>(path)
    } catch (error) {
      return {
        action: {
          kind: 'repository',
          target: name,
          status: 'blocked',
          detail: describe(error)
        }
      }
    }

    if (existing) {
      if (!existing.private)
        return {
          action: {
            kind: 'repository',
            target: name,
            status: 'blocked',
            detail: `${existing.full_name} is not private; classroom repositories must be private and organization-owned`
          }
        }

      return {
        action: {
          kind: 'repository',
          target: name,
          status: 'satisfied',
          detail: `${existing.full_name} already exists and is private`
        },
        repo: existing
      }
    }

    if (!write)
      return {
        action: {
          kind: 'repository',
          target: name,
          status: 'create',
          detail: `POST /orgs/${config.organization}/repos with private visibility`
        }
      }

    try {
      const created = await this.api.json<ApiRepository>(
        'POST',
        `/orgs/${config.organization}/repos`,
        {
          name,
          private: true,
          visibility: 'private',
          description: 'GitHub Intermediate training project',
          auto_init: false,
          has_issues: true
        },
        [201]
      )

      return {
        action: {
          kind: 'repository',
          target: name,
          status: 'create',
          detail: `Created ${created.full_name}`
        },
        repo: created
      }
    } catch (error) {
      return {
        action: {
          kind: 'repository',
          target: name,
          status: 'blocked',
          detail: describe(error)
        }
      }
    }
  }

  /**
   * Pushes the seeded references into a verified-empty repository.
   *
   * @param config Runtime inputs.
   * @param name Repository name.
   * @param repo The repository record.
   * @param write Whether to perform writes.
   * @returns The action.
   */
  private async reconcileSeedPush(
    config: ProvisioningConfig,
    name: string,
    repo: ApiRepository,
    write: boolean
  ): Promise<PlannedAction> {
    const intended = intendedExportedRefs()
    let present: Record<string, string>

    try {
      present = this.remoteRefs(config.sourceRepository, repo.clone_url)
    } catch (error) {
      return {
        kind: 'seed-push',
        target: name,
        status: 'blocked',
        detail: describe(error)
      }
    }

    const refs = Object.keys(present).filter((ref) => ref !== 'HEAD')

    if (refs.length > 0) {
      const missing = intended.filter((ref) => !refs.includes(ref))

      // A repository that already carries the seeded references has been
      // provisioned; one that carries anything else may hold learner work, and
      // overwriting it is never an acceptable recovery.
      return missing.length === 0
        ? {
            kind: 'seed-push',
            target: name,
            status: 'satisfied',
            detail: `${name} already carries all ${intended.length} seeded references`
          }
        : {
            kind: 'seed-push',
            target: name,
            status: 'blocked',
            detail: `${name} is not empty and is missing ${missing.join(', ')}; refusing to push over existing history`
          }
    }

    if (!write)
      return {
        kind: 'seed-push',
        target: name,
        status: 'create',
        detail: `Push ${intended.length} references into the empty ${name}`
      }

    try {
      this.push(config.sourceRepository, repo.clone_url, intended)
    } catch (error) {
      return {
        kind: 'seed-push',
        target: name,
        status: 'blocked',
        detail: describe(error)
      }
    }

    const after = this.remoteRefs(config.sourceRepository, repo.clone_url)
    const delivered = intended.filter((ref) => ref in after)

    return delivered.length === intended.length
      ? {
          kind: 'seed-push',
          target: name,
          status: 'create',
          detail: `Pushed ${delivered.length} references into ${name}`
        }
      : {
          kind: 'seed-push',
          target: name,
          status: 'blocked',
          detail: `Push completed but ${name} is missing ${intended
            .filter((ref) => !(ref in after))
            .join(', ')}`
        }
  }

  /**
   * Opens the seeded pull requests that are missing.
   *
   * @param config Runtime inputs.
   * @param name Repository name.
   * @param write Whether to perform writes.
   * @returns One action per seeded pull request.
   */
  private async reconcilePullRequests(
    config: ProvisioningConfig,
    name: string,
    write: boolean
  ): Promise<PlannedAction[]> {
    const path = `/repos/${config.organization}/${name}/pulls`
    let existing: ApiPullRequest[]

    try {
      existing = await this.api.paginate<ApiPullRequest>(`${path}?state=all`)
    } catch (error) {
      return [
        {
          kind: 'pull-request',
          target: name,
          status: 'blocked',
          detail: describe(error)
        }
      ]
    }

    const actions: PlannedAction[] = []

    for (const seed of SEEDED_PULL_REQUESTS) {
      const target = `${name}#${seed.head}->${seed.base}`

      // Identity is head plus base plus who opened it. Two seeded pairs share
      // a title on purpose, so a title match would conflate them.
      const matches = existing.filter(
        (pull) =>
          pull.head.ref === seed.head &&
          pull.base.ref === seed.base &&
          pull.user.login === config.expectedOperator
      )

      if (matches.length > 1) {
        actions.push({
          kind: 'pull-request',
          target,
          status: 'blocked',
          detail: `Found ${matches.length} pull requests from ${seed.head} into ${seed.base}; ownership is ambiguous`
        })
        continue
      }

      if (matches.length === 1) {
        actions.push({
          kind: 'pull-request',
          target,
          status: 'satisfied',
          detail: `Pull request #${matches[0].number} already seeds ${seed.head}`
        })
        continue
      }

      if (!write) {
        actions.push({
          kind: 'pull-request',
          target,
          status: 'create',
          detail: `POST ${path} with head ${seed.head}, base ${seed.base}`
        })
        continue
      }

      try {
        const created = await this.api.json<ApiPullRequest>(
          'POST',
          path,
          {
            title: seed.title,
            head: seed.head,
            base: seed.base,
            body: `Seeded for Lab ${seed.lab}.`,
            draft: false
          },
          [201]
        )
        actions.push({
          kind: 'pull-request',
          target,
          status: 'create',
          detail: `Opened pull request #${created.number}`
        })
      } catch (error) {
        actions.push({
          kind: 'pull-request',
          target,
          status: 'blocked',
          detail: describe(error)
        })
      }
    }

    return actions
  }

  /**
   * Opens the configured issues that are missing.
   *
   * @param config Runtime inputs.
   * @param name Repository name.
   * @param write Whether to perform writes.
   * @returns One action per configured issue.
   */
  private async reconcileIssues(
    config: ProvisioningConfig,
    name: string,
    write: boolean
  ): Promise<PlannedAction[]> {
    const issues = config.issues ?? SEEDED_ISSUES
    if (issues.length === 0) return []

    const path = `/repos/${config.organization}/${name}/issues`
    const existing = await this.api.paginate<ApiIssue>(`${path}?state=all`)
    const actions: PlannedAction[] = []

    for (const seed of issues) {
      const target = `${name}!${seed.title}`
      const matches = existing.filter(
        (issue) =>
          issue.title === seed.title &&
          issue.user.login === config.expectedOperator
      )

      if (matches.length > 1) {
        actions.push({
          kind: 'issue',
          target,
          status: 'blocked',
          detail: `Found ${matches.length} issues titled ${seed.title}; ownership is ambiguous`
        })
        continue
      }

      if (matches.length === 1) {
        actions.push({
          kind: 'issue',
          target,
          status: 'satisfied',
          detail: `Issue #${matches[0].number} already exists`
        })
        continue
      }

      if (!write) {
        actions.push({
          kind: 'issue',
          target,
          status: 'create',
          detail: `POST ${path}`
        })
        continue
      }

      const created = await this.api.json<ApiIssue>(
        'POST',
        path,
        { title: seed.title, body: seed.body },
        [201]
      )
      actions.push({
        kind: 'issue',
        target,
        status: 'create',
        detail: `Opened issue #${created.number}`
      })
    }

    return actions
  }

  /**
   * Applies configured rulesets that are missing.
   *
   * Empty by default. Protecting `main` before Lab 6 would remove the
   * exercise, so a ruleset is applied only when an operator asks for one.
   *
   * @param config Runtime inputs.
   * @param name Repository name.
   * @param write Whether to perform writes.
   * @returns One action per configured ruleset.
   */
  private async reconcileRulesets(
    config: ProvisioningConfig,
    name: string,
    write: boolean
  ): Promise<PlannedAction[]> {
    const specs = config.rulesets ?? []
    if (specs.length === 0) return []

    const path = `/repos/${config.organization}/${name}/rulesets`
    let existing: { id: number; name: string }[]

    try {
      existing = await this.api.paginate<{ id: number; name: string }>(path)
    } catch (error) {
      return [
        {
          kind: 'ruleset',
          target: name,
          status: 'blocked',
          detail: `${describe(error)} (rulesets require an organization-owned repository on a plan that supports them)`
        }
      ]
    }

    const actions: PlannedAction[] = []

    for (const spec of specs) {
      const target = `${name}/${spec.name}`
      const matches = existing.filter((ruleset) => ruleset.name === spec.name)

      if (matches.length > 0) {
        actions.push({
          kind: 'ruleset',
          target,
          status: 'satisfied',
          detail: `Ruleset ${spec.name} already exists; leaving its configuration untouched`
        })
        continue
      }

      if (!write) {
        actions.push({
          kind: 'ruleset',
          target,
          status: 'create',
          detail: `POST ${path} with enforcement ${spec.enforcement}`
        })
        continue
      }

      try {
        await this.api.json(
          'POST',
          path,
          {
            name: spec.name,
            target: spec.target ?? 'branch',
            enforcement: spec.enforcement,
            conditions: spec.conditions ?? {
              ref_name: {
                include: [`refs/heads/${DEFAULT_BRANCH}`],
                exclude: []
              }
            },
            rules: spec.rules ?? []
          },
          [201]
        )
        actions.push({
          kind: 'ruleset',
          target,
          status: 'create',
          detail: `Created ruleset ${spec.name}`
        })
      } catch (error) {
        actions.push({
          kind: 'ruleset',
          target,
          status: 'blocked',
          detail: describe(error)
        })
      }
    }

    return actions
  }

  /**
   * Enables Pages, refusing anything that could publish the site publicly.
   *
   * @param config Runtime inputs.
   * @param name Repository name.
   * @param repo The repository record.
   * @param write Whether to perform writes.
   * @returns The action.
   */
  private async reconcilePages(
    config: ProvisioningConfig,
    name: string,
    repo: ApiRepository,
    write: boolean
  ): Promise<PlannedAction> {
    const path = `/repos/${config.organization}/${name}/pages`

    if (!repo.private)
      return {
        kind: 'pages',
        target: name,
        status: 'blocked',
        detail: `${repo.full_name} is public; refusing to publish rather than fall back to public exposure`
      }

    if (!config.privatePagesConfirmed)
      return {
        kind: 'pages',
        target: name,
        status: 'blocked',
        detail:
          'Private Pages eligibility has not been asserted for this organization. The API cannot establish it, and it must not be inferred from an account name or an email domain.'
      }

    let existing: { build_type?: string | null } | undefined

    try {
      existing = await this.api.find<{ build_type?: string | null }>(path)
    } catch (error) {
      return {
        kind: 'pages',
        target: name,
        status: 'blocked',
        detail: describe(error)
      }
    }

    if (existing)
      return existing.build_type === 'workflow'
        ? {
            kind: 'pages',
            target: name,
            status: 'satisfied',
            detail: `Pages already builds ${name} from a workflow`
          }
        : {
            kind: 'pages',
            target: name,
            status: 'blocked',
            detail: `Pages is already configured for ${name} with build_type ${existing.build_type}; refusing to replace an existing configuration`
          }

    if (!write)
      return {
        kind: 'pages',
        target: name,
        status: 'create',
        detail: `POST ${path} with build_type workflow`
      }

    try {
      await this.api.json('POST', path, { build_type: 'workflow' }, [201])
      return {
        kind: 'pages',
        target: name,
        status: 'create',
        detail: `Enabled Pages on ${name} with build_type workflow (eligibility: operator-asserted)`
      }
    } catch (error) {
      return {
        kind: 'pages',
        target: name,
        status: 'blocked',
        detail: describe(error)
      }
    }
  }

  /**
   * Runs a lookup and maps both its result and its failure onto an action.
   *
   * @param lookup Read to perform.
   * @param decide Maps a successful result onto a status and detail.
   * @returns The status and detail.
   */
  private async attempt<T>(
    lookup: () => Promise<T | undefined>,
    decide: (value: T | undefined) => { status: ActionStatus; detail: string }
  ): Promise<{ status: ActionStatus; detail: string }> {
    try {
      return decide(await lookup())
    } catch (error) {
      return { status: 'blocked', detail: describe(error) }
    }
  }
}

/**
 * Renders a failure as text, keeping the REST status when there is one.
 *
 * @param error Thrown value.
 * @returns A description safe to place in a report.
 */
function describe(error: unknown): string {
  if (error instanceof GitHubError)
    return `${error.method} ${error.path} returned ${error.status}`

  return error instanceof Error ? error.message : String(error)
}
