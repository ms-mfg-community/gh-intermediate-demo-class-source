/**
 * Provisioning command line.
 *
 * `plan` is the default verb and never writes. `apply` writes only when it is
 * given `--confirm`, a configuration file naming a target, and a credential
 * that resolves to the operator the configuration expects. It stops at the
 * first blocked operation, with no rollback. Pages is read-only in both modes.
 *
 * Run with:
 * `node --import ./tools/provisioning/register.mjs tools/provisioning/cli.ts`
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { exportBundle } from './bundle.js'
import { intendedExportedRefs } from './contract.js'
import { buildGoldenRepository, renderPlaceholders } from './fixture.js'
import { git } from './git.js'
import { FetchHttpClient, GitHubApi } from './github/client.js'
import { FakeGitHub } from './github/fake.js'
import {
  Provisioner,
  type ProvisioningConfig,
  type ProvisioningReport
} from './github/provisioner.js'

const USAGE = `Usage: provision <command> [options]

Local commands, which never contact GitHub:
  build-fixture  --source <repo> --target <dir>   Build the golden repository
  render         --repo <dir> --organization <o> --class-team <t>
                                                  Substitute class placeholders
  export-bundle  --repo <dir> --output <file>     Write the delivery bundle
  dry-run        --config <file>                  Rehearse against a local fake

Commands that contact GitHub, using GITHUB_TOKEN:
  plan           --config <file>                  Report what would change
  apply          --config <file> --confirm        Create only what is missing

plan is the default verb when only options are supplied; no arguments shows help.
apply refuses to run without the bare --confirm flag: holding a credential is
not authorization to use it against a classroom.
Use enablePages=false for initial provisioning. After an administrator configures
private Pages manually, enablePages=true requires an existing workflow site with
public=false and privatePagesConfirmed=true. Pages is never created or changed.`

/**
 * Parses `--key value` and `--flag` arguments.
 *
 * @param argv Arguments after the command name.
 * @returns Option names mapped to their values.
 * @throws If a boolean flag is given a value instead of standing alone.
 */
export function parseOptions(argv: string[]): Record<string, string | true> {
  const options: Record<string, string | true> = {}

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) continue

    const name = argument.slice(2)
    const next = argv[index + 1]
    const flag = name.split('=')[0]

    if (flag === 'confirm' || flag === 'help') {
      if (name !== flag || (next !== undefined && !next.startsWith('--')))
        throw new Error(
          `Flag --${flag} does not accept a value; use --${flag} on its own`
        )
      options[flag] = true
      continue
    }

    if (next === undefined || next.startsWith('--')) options[name] = true
    else {
      options[name] = next
      index += 1
    }
  }

  return options
}

/**
 * Reads a required string option.
 *
 * @param options Parsed options.
 * @param name Option name.
 * @returns The option's value.
 * @throws If the option is absent or has no value.
 */
function required(
  options: Record<string, string | true>,
  name: string
): string {
  const value = options[name]

  if (typeof value !== 'string')
    throw new Error(`Missing required option --${name}`)

  return value
}

/**
 * Loads a provisioning configuration file.
 *
 * @param path Path of the JSON configuration.
 * @returns The parsed configuration, with paths resolved.
 * @throws If required inputs are missing or a supplied safety flag is not boolean.
 */
function loadConfig(path: string): ProvisioningConfig {
  const config = JSON.parse(readFileSync(path, 'utf8')) as ProvisioningConfig

  for (const key of [
    'organization',
    'classTeam',
    'repositoryPrefix',
    'sourceRepository',
    'expectedOperator'
  ] as const)
    if (typeof config[key] !== 'string' || config[key].trim() === '')
      throw new Error(`Configuration is missing ${key}`)

  if (!Array.isArray(config.participants) || config.participants.length === 0)
    throw new Error('Configuration lists no participants')

  for (const key of ['enablePages', 'privatePagesConfirmed'] as const)
    if (config[key] !== undefined && typeof config[key] !== 'boolean')
      throw new Error(
        `Configuration ${key} must be a boolean (true or false), not a string or other value`
      )

  return { ...config, sourceRepository: resolve(config.sourceRepository) }
}

/**
 * Renders a report as text.
 *
 * @param report The report to print.
 * @returns The formatted report.
 */
export function formatReport(report: ProvisioningReport): string {
  const lines = [`mode: ${report.mode}`]

  if (report.pagesEligibility)
    lines.push(`pages eligibility: ${report.pagesEligibility}`)

  for (const action of report.actions)
    lines.push(
      `  [${action.status.padEnd(9)}] ${action.kind} ${action.target} — ${action.detail}`
    )

  const blocked = report.actions.filter(
    (action) => action.status === 'blocked'
  ).length

  lines.push(
    report.ok
      ? `\n${report.actions.length} actions, none blocked.`
      : `\n${report.actions.length} actions, ${blocked} blocked.`
  )
  if (report.mode === 'plan')
    lines.push('Read-only plan; no writes were attempted.')
  else if (!report.ok)
    lines.push(
      'Stopped at the first blocked operation. Earlier completed actions remain; no rollback is provided.'
    )

  return lines.join('\n')
}

/**
 * Builds a provisioner that talks to real GitHub.
 *
 * @returns The provisioner.
 * @throws If no credential is present in the environment.
 */
function liveProvisioner(): Provisioner {
  const token = process.env.GITHUB_TOKEN

  if (!token)
    throw new Error('GITHUB_TOKEN is not set; refusing to contact GitHub')

  return new Provisioner({
    api: new GitHubApi({ client: new FetchHttpClient(), token })
  })
}

/**
 * Runs the command line.
 *
 * @param argv Arguments after the script name.
 * @returns The process exit code.
 */
export async function main(argv: string[]): Promise<number> {
  const [first, ...remaining] = argv
  const command = first?.startsWith('--') ? 'plan' : (first ?? 'help')
  const rest = first?.startsWith('--') ? argv : remaining
  const options = parseOptions(rest)

  if (command === 'help' || options.help === true) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }

  if (command === 'build-fixture') {
    const fixture = buildGoldenRepository({
      sourceRepo: resolve(required(options, 'source')),
      target: resolve(required(options, 'target'))
    })
    process.stdout.write(`${JSON.stringify(fixture, null, 2)}\n`)
    return 0
  }

  if (command === 'render') {
    const report = renderPlaceholders(resolve(required(options, 'repo')), {
      organization: required(options, 'organization'),
      classTeam: required(options, 'class-team')
    })
    const substituted =
      report.rendered.length === 0
        ? 'No class configuration needed substituting.\n'
        : `Rendered ${report.rendered.length} file(s): ${report.rendered.join(', ')}\n`
    const kept =
      report.retained.length === 0
        ? ''
        : 'Left carrying placeholders on purpose, because they define the ' +
          `mechanism rather than configure a class: ${report.retained.join(', ')}\n`

    process.stdout.write(substituted + kept)
    return 0
  }

  if (command === 'export-bundle') {
    const result = exportBundle({
      repo: resolve(required(options, 'repo')),
      output: resolve(required(options, 'output'))
    })
    process.stdout.write(
      `Wrote ${result.path} (${result.bytes} bytes)\n` +
        `References: ${result.refs.join(', ')}\n` +
        'A bundle carries Git history. It does not carry installed ' +
        'dependencies, and it does not carry pull requests, issues or any ' +
        'other GitHub-side resource.\n'
    )
    return 0
  }

  if (command === 'dry-run') {
    const config = loadConfig(required(options, 'config'))
    const remotes = mkdtempSync(join(tmpdir(), 'provision-dry-run-'))

    try {
      // Back the fake's repositories with real local bare repositories, so the
      // reference push is genuinely executed rather than assumed.
      const service = new FakeGitHub({
        operator: config.expectedOperator,
        organizations: { [config.organization]: [config.classTeam] },
        remoteRoot: remotes,
        onCreate: (repository) => {
          git(remotes, [
            'init',
            '--quiet',
            '--bare',
            '--initial-branch=main',
            join(remotes, `${repository.name}.git`)
          ])
        }
      })
      const provisioner = new Provisioner({
        api: new GitHubApi({ client: service, token: 'dry-run' })
      })
      const report = await provisioner.apply(config, { confirm: true })

      process.stdout.write(
        `${formatReport(report)}\n\n` +
          'This was a rehearsal against a local fake service and local ' +
          'repositories. It exercises the request shapes, the reference push ' +
          'and the decision logic. It proves nothing about the target ' +
          'organization, its permissions or its Pages eligibility or visibility.\n' +
          'The fake starts with no Pages sites: enablePages=true blocks on manual ' +
          'setup rather than simulating private publication. Use enablePages=false ' +
          'to rehearse initial provisioning.\n'
      )
      return report.ok ? 0 : 1
    } finally {
      rmSync(remotes, { recursive: true, force: true })
    }
  }

  if (command === 'plan' || command === 'apply') {
    const config = loadConfig(required(options, 'config'))
    const provisioner = liveProvisioner()
    const report =
      command === 'plan'
        ? await provisioner.plan(config)
        : await provisioner.apply(config, { confirm: options.confirm === true })

    process.stdout.write(`${formatReport(report)}\n`)
    return report.ok ? 0 : 1
  }

  process.stderr.write(`Unknown command ${command}\n\n${USAGE}\n`)
  return 2
}

/** Reference set the export commands write, exposed for documentation. */
export const EXPORTED_REFS = intendedExportedRefs()

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`
      )
      process.exitCode = 1
    })
