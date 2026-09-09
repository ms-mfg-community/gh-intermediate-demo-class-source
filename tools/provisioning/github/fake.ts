/**
 * A local, stateful stand-in for the GitHub REST endpoints this tool uses.
 *
 * It exists so provisioning behaviour — including the rerun path, the refusal
 * paths and pagination — can be exercised end to end without contacting
 * GitHub. It is deliberately strict: an unknown route fails loudly rather than
 * returning a success-shaped default, because a fake that quietly answers
 * everything proves nothing.
 */
import type { HttpClient, HttpRequest, HttpResponse } from './client.js'

export interface FakeRepository {
  name: string
  owner: string
  private: boolean
  cloneUrl: string
  pulls: FakePullRequest[]
  issues: FakeIssue[]
  rulesets: FakeRuleset[]
  pages?: { build_type: string; public: boolean }
}

export interface FakePullRequest {
  number: number
  title: string
  head: string
  base: string
  state: 'open' | 'closed'
  user: string
  body?: string
}

export interface FakeIssue {
  number: number
  title: string
  state: 'open' | 'closed'
  user: string
}

export interface FakeRuleset {
  id: number
  name: string
  target: string
  enforcement: string
}

export interface FakeGitHubOptions {
  /** Login reported by `GET /user`. */
  operator?: string
  /** Organizations that exist, mapped to their team slugs. */
  organizations?: Record<string, string[]>
  /** Repositories that already exist, keyed by `owner/name`. */
  repositories?: Record<string, FakeRepository>
  /** Items returned per page, so pagination is genuinely exercised. */
  pageSize?: number
  /** Routes answered with `403`, matched as `METHOD /path` prefixes. */
  denied?: string[]
  /** Directory holding bare repositories that back `clone_url` values. */
  remoteRoot?: string
  /** Called after a repository is created, so a test can back it with a remote. */
  onCreate?: (repository: FakeRepository) => void
}

/**
 * Builds a repository record with empty collections.
 *
 * @param owner Owning organization.
 * @param name Repository name.
 * @param cloneUrl Address a push would target.
 * @param isPrivate Whether the repository is private.
 * @returns A repository record.
 */
export function fakeRepository(
  owner: string,
  name: string,
  cloneUrl: string,
  isPrivate = true
): FakeRepository {
  return {
    name,
    owner,
    private: isPrivate,
    cloneUrl,
    pulls: [],
    issues: [],
    rulesets: []
  }
}

/**
 * A stateful fake GitHub service.
 */
export class FakeGitHub implements HttpClient {
  readonly operator: string
  readonly organizations: Record<string, string[]>
  readonly repositories: Record<string, FakeRepository>
  readonly requests: HttpRequest[] = []
  private readonly pageSize: number
  private readonly denied: string[]
  private readonly remoteRoot: string
  private readonly onCreate?: (repository: FakeRepository) => void
  private counter = 100

  constructor(options: FakeGitHubOptions = {}) {
    this.operator = options.operator ?? 'course-provisioner'
    this.organizations = options.organizations ?? { 'example-org': ['class'] }
    this.repositories = options.repositories ?? {}
    this.pageSize = options.pageSize ?? 100
    this.denied = options.denied ?? []
    this.remoteRoot = options.remoteRoot ?? ''
    this.onCreate = options.onCreate
  }

  /**
   * Answers one request against the fake's current state.
   *
   * @param request Method, address, headers and body.
   * @returns The simulated response.
   */
  async send(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request)

    const url = new URL(request.url)
    const route = `${request.method} ${url.pathname}`

    if (this.denied.some((prefix) => route.startsWith(prefix)))
      return this.reply(403, {
        message: 'Resource not accessible by integration'
      })

    const body = request.body ? JSON.parse(request.body) : undefined
    const segments = url.pathname.split('/').filter((part) => part !== '')

    if (route === 'GET /user') return this.reply(200, { login: this.operator })

    if (segments[0] === 'orgs' && segments.length === 2)
      return segments[1] in this.organizations
        ? this.reply(200, { login: segments[1] })
        : this.reply(404, { message: 'Not Found' })

    if (segments[0] === 'orgs' && segments[2] === 'teams')
      return (this.organizations[segments[1]] ?? []).includes(segments[3])
        ? this.reply(200, { slug: segments[3], organization: segments[1] })
        : this.reply(404, { message: 'Not Found' })

    if (route.startsWith('POST /orgs') && segments[2] === 'repos')
      return this.createRepository(segments[1], body)

    if (segments[0] === 'repos') return this.repositoryRoute(request, url, body)

    return this.reply(404, { message: `Unhandled route ${route}` })
  }

  /**
   * Routes a request addressed at a specific repository.
   *
   * @param request The original request.
   * @param url Parsed address.
   * @param body Parsed request body.
   * @returns The simulated response.
   */
  private repositoryRoute(
    request: HttpRequest,
    url: URL,
    body: Record<string, string>
  ): HttpResponse {
    const segments = url.pathname.split('/').filter((part) => part !== '')
    const key = `${segments[1]}/${segments[2]}`
    const repository = this.repositories[key]
    const resource = segments[3]

    if (!repository) return this.reply(404, { message: 'Not Found' })
    if (resource === undefined)
      return this.reply(200, this.describe(repository))

    if (request.method === 'GET' && resource === 'pulls')
      return this.page(
        url,
        repository.pulls
          .filter(
            (pull) =>
              (url.searchParams.get('state') ?? 'open') === 'all' ||
              pull.state === (url.searchParams.get('state') ?? 'open')
          )
          .map((pull) => this.describePull(pull))
      )

    if (request.method === 'POST' && resource === 'pulls') {
      const pull: FakePullRequest = {
        number: (this.counter += 1),
        title: body.title,
        head: body.head,
        base: body.base,
        body: body.body,
        state: 'open',
        user: this.operator
      }
      repository.pulls.push(pull)
      return this.reply(201, this.describePull(pull))
    }

    if (request.method === 'GET' && resource === 'issues')
      return this.page(
        url,
        repository.issues.map((issue) => this.describeIssue(issue))
      )

    if (request.method === 'POST' && resource === 'issues') {
      const issue: FakeIssue = {
        number: (this.counter += 1),
        title: body.title,
        state: 'open',
        user: this.operator
      }
      repository.issues.push(issue)
      return this.reply(201, this.describeIssue(issue))
    }

    if (request.method === 'GET' && resource === 'rulesets')
      return this.page(url, repository.rulesets)

    if (request.method === 'POST' && resource === 'rulesets') {
      const ruleset: FakeRuleset = {
        id: (this.counter += 1),
        name: body.name,
        target: body.target ?? 'branch',
        enforcement: body.enforcement
      }
      repository.rulesets.push(ruleset)
      return this.reply(201, ruleset)
    }

    if (request.method === 'GET' && resource === 'pages')
      return repository.pages
        ? this.reply(200, { ...repository.pages, status: 'built' })
        : this.reply(404, { message: 'Not Found' })

    if (request.method === 'POST' && resource === 'pages') {
      if (repository.pages) return this.reply(409, { message: 'Conflict' })

      repository.pages = {
        build_type: body.build_type ?? 'legacy',
        public: !repository.private
      }
      return this.reply(201, { ...repository.pages, status: null })
    }

    return this.reply(404, {
      message: `Unhandled repository route ${resource}`
    })
  }

  /**
   * Creates a repository in an organization.
   *
   * @param org Organization name.
   * @param body Parsed request body.
   * @returns The simulated response.
   */
  private createRepository(
    org: string,
    body: Record<string, unknown>
  ): HttpResponse {
    if (!(org in this.organizations))
      return this.reply(404, { message: 'Not Found' })

    const name = String(body.name)
    const key = `${org}/${name}`

    if (key in this.repositories)
      return this.reply(422, { message: 'name already exists on this account' })

    const repository = fakeRepository(
      org,
      name,
      `${this.remoteRoot}/${name}.git`,
      body.private === true || body.visibility === 'private'
    )
    this.repositories[key] = repository
    this.onCreate?.(repository)

    return this.reply(201, this.describe(repository))
  }

  /**
   * Renders a repository as the REST API would.
   *
   * @param repository Repository record.
   * @returns A response body.
   */
  private describe(repository: FakeRepository) {
    return {
      name: repository.name,
      full_name: `${repository.owner}/${repository.name}`,
      private: repository.private,
      visibility: repository.private ? 'private' : 'public',
      clone_url: repository.cloneUrl,
      default_branch: 'main',
      owner: { login: repository.owner, type: 'Organization' }
    }
  }

  /**
   * Renders a pull request as the REST API would.
   *
   * @param pull Pull request record.
   * @returns A response body.
   */
  private describePull(pull: FakePullRequest) {
    return {
      number: pull.number,
      title: pull.title,
      state: pull.state,
      body: pull.body ?? null,
      user: { login: pull.user },
      head: { ref: pull.head },
      base: { ref: pull.base }
    }
  }

  /**
   * Renders an issue as the REST API would.
   *
   * @param issue Issue record.
   * @returns A response body.
   */
  private describeIssue(issue: FakeIssue) {
    return {
      number: issue.number,
      title: issue.title,
      state: issue.state,
      user: { login: issue.user }
    }
  }

  /**
   * Returns one page of a collection, with a `Link` header when more remain.
   *
   * @param url Requested address, read for `page` and `per_page`.
   * @param items Full collection.
   * @returns The simulated response.
   */
  private page(url: URL, items: unknown[]): HttpResponse {
    const size = Math.min(
      Number(url.searchParams.get('per_page') ?? this.pageSize),
      this.pageSize
    )
    const page = Number(url.searchParams.get('page') ?? '1')
    const slice = items.slice((page - 1) * size, page * size)
    const headers: Record<string, string> = {}

    if (page * size < items.length) {
      const next = new URL(url.toString())
      next.searchParams.set('page', String(page + 1))
      headers.link = `<${next.toString()}>; rel="next"`
    }

    return { status: 200, headers, body: JSON.stringify(slice) }
  }

  /**
   * Builds a JSON response.
   *
   * @param status HTTP status code.
   * @param body Value to serialise.
   * @returns The simulated response.
   */
  private reply(status: number, body: unknown): HttpResponse {
    return {
      status,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }
  }
}
