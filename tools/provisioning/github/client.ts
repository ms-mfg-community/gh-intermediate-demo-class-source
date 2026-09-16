/**
 * GitHub REST access.
 *
 * The transport is injected. Nothing in this module opens a socket by itself,
 * so the provisioning logic can be exercised end to end against a local fake
 * without a network, and the same code path runs unchanged against
 * `api.github.com`.
 *
 * Request shapes were checked against the GitHub REST reference on
 * 2026-09-09: `POST /orgs/{org}/repos`, `POST /repos/{owner}/{repo}/pulls`,
 * `POST /repos/{owner}/{repo}/issues`, `POST /repos/{owner}/{repo}/rulesets`
 * and their read endpoints. Pages GET fields were rechecked on 2026-09-16:
 * `public` is in GET responses and PUT inputs, not POST creation inputs.
 * Provisioning therefore only reads Pages; it never creates or updates a site.
 */

/** Default REST API version, as documented on 2026-09-09. */
export const API_VERSION = '2026-03-10'

/** Default REST base address. */
export const API_BASE = 'https://api.github.com'

export interface HttpRequest {
  method: string
  url: string
  headers: Record<string, string>
  body?: string
}

export interface HttpResponse {
  status: number
  headers: Record<string, string>
  body: string
}

/** Transport contract. Substitute a fake to run without a network. */
export interface HttpClient {
  send(request: HttpRequest): Promise<HttpResponse>
}

/** A REST call that returned a status the caller did not expect. */
export class GitHubError extends Error {
  readonly status: number
  readonly method: string
  readonly path: string
  readonly detail: string

  constructor(status: number, method: string, path: string, detail: string) {
    super(`${method} ${path} failed with ${status}: ${detail}`)
    this.name = 'GitHubError'
    this.status = status
    this.method = method
    this.path = path
    this.detail = detail
  }
}

/**
 * A transport backed by the runtime's `fetch`.
 *
 * Never used by the test suite, which substitutes a local fake. Both live
 * `plan` and `apply` use it; plan sends only GET requests.
 */
export class FetchHttpClient implements HttpClient {
  /**
   * Sends a request over the network.
   *
   * @param request Method, absolute address, headers and body.
   * @returns The response status, headers and body text.
   */
  async send(request: HttpRequest): Promise<HttpResponse> {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body
    })

    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: await response.text()
    }
  }
}

export interface GitHubApiOptions {
  /** Transport to send requests through. */
  client: HttpClient
  /** Credential presented as a bearer token. */
  token: string
  /** REST base address. */
  base?: string
  /** REST API version header value. */
  version?: string
  /** Value sent as the user agent. */
  userAgent?: string
}

/**
 * Reads the next page address from a `Link` header.
 *
 * @param link Raw `Link` header value.
 * @returns The `rel="next"` address, or `undefined` when there is no next page.
 */
export function nextPageLink(link: string | undefined): string | undefined {
  if (!link) return undefined

  for (const part of link.split(',')) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="next"\s*$/.exec(part)
    if (match) return match[1]
  }

  return undefined
}

/**
 * A thin, typed wrapper over the GitHub REST endpoints this tool uses.
 */
export class GitHubApi {
  private readonly client: HttpClient
  private readonly token: string
  private readonly base: string
  private readonly version: string
  private readonly userAgent: string

  /** Every request sent through this instance, for plan reporting and tests. */
  readonly calls: HttpRequest[] = []

  constructor(options: GitHubApiOptions) {
    this.client = options.client
    this.token = options.token
    this.base = options.base ?? API_BASE
    this.version = options.version ?? API_VERSION
    this.userAgent = options.userAgent ?? 'gh-intermediate-provisioning'
  }

  /**
   * Sends one request with the standard headers applied.
   *
   * @param method HTTP method.
   * @param path Path relative to the base address, or an absolute address.
   * @param body Optional value serialised as a JSON request body.
   * @returns The raw response.
   */
  async request(
    method: string,
    path: string,
    body?: unknown
  ): Promise<HttpResponse> {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${this.token}`,
      'x-github-api-version': this.version,
      'user-agent': this.userAgent
    }

    if (body !== undefined) headers['content-type'] = 'application/json'

    const request: HttpRequest = {
      method,
      url: path.startsWith('http') ? path : `${this.base}${path}`,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    }

    this.calls.push(request)

    return this.client.send(request)
  }

  /**
   * Sends a request and parses a successful JSON response.
   *
   * @param method HTTP method.
   * @param path Path relative to the base address.
   * @param body Optional request body.
   * @param expected Status codes treated as success.
   * @returns The parsed response body.
   * @throws {GitHubError} If the status is not one of `expected`.
   */
  async json<T>(
    method: string,
    path: string,
    body?: unknown,
    expected: number[] = [200, 201]
  ): Promise<T> {
    const response = await this.request(method, path, body)

    if (!expected.includes(response.status))
      throw new GitHubError(response.status, method, path, response.body)

    return (response.body === '' ? undefined : JSON.parse(response.body)) as T
  }

  /**
   * Fetches a resource, treating `404` as absence rather than failure.
   *
   * @param path Path relative to the base address.
   * @returns The parsed body, or `undefined` when the resource is absent.
   */
  async find<T>(path: string): Promise<T | undefined> {
    const response = await this.request('GET', path)

    if (response.status === 404) return undefined
    if (response.status !== 200)
      throw new GitHubError(response.status, 'GET', path, response.body)

    return JSON.parse(response.body) as T
  }

  /**
   * Walks every page of a collection, following the `Link` header.
   *
   * A classroom repository accumulates enough pull requests to spill onto a
   * second page, and a matcher that reads only the first page would open a
   * duplicate of anything sitting beyond it.
   *
   * @param path Path relative to the base address.
   * @returns Every item across every page, in order.
   */
  async paginate<T>(path: string): Promise<T[]> {
    const separator = path.includes('?') ? '&' : '?'
    let next: string | undefined = `${path}${separator}per_page=100`
    const items: T[] = []

    while (next !== undefined) {
      const response: HttpResponse = await this.request('GET', next)

      if (response.status !== 200)
        throw new GitHubError(response.status, 'GET', next, response.body)

      items.push(...(JSON.parse(response.body) as T[]))
      next = nextPageLink(response.headers.link ?? response.headers.Link)
    }

    return items
  }
}
