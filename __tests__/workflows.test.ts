/** @jest-environment node */
import { jest } from '@jest/globals'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

interface Step {
  id: string
  if?: string
  run?: string
  uses?: string
  env?: Record<string, string>
  with?: Record<string, string | number>
  'continue-on-error'?: boolean
}

interface Workflow {
  jobs: Record<string, { steps: Step[] }>
}

const { load }: { load: (text: string) => Workflow } = createRequire(
  import.meta.url
)('js-yaml')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const workflow = (name: string) =>
  load(readFileSync(join(root, '.github', 'workflows', `${name}.yml`), 'utf8'))
const delivery = workflow('continuous-delivery').jobs.cd.steps

describe('Continuous Integration', () => {
  const steps = workflow('continuous-integration').jobs[
    'continuous-integration'
  ].steps

  it.each(['format-check', 'lint', 'test'])(
    'does not ignore a failure in %s',
    (id) => {
      const step = steps.find((candidate) => candidate.id === id)
      expect(step).toBeDefined()
      expect(step?.['continue-on-error']).not.toBe(true)
    }
  )
})

describe('Continuous Delivery', () => {
  let repo: string
  let env: NodeJS.ProcessEnv
  let before: string

  function git(args: string[], input?: string) {
    return execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      env,
      input
    }).trim()
  }

  function commit(
    manifest: Record<string, unknown> | string | undefined,
    parents: string[] = [],
    files: Record<string, string> = {}
  ) {
    const contents = { ...files }
    if (manifest !== undefined)
      contents['package.json'] =
        typeof manifest === 'string' ? manifest : JSON.stringify(manifest)

    const entries = Object.entries(contents).map(
      ([name, content]) =>
        `100644 blob ${git(['hash-object', '-w', '--stdin'], content)}\t${name}`
    )
    const tree = git(['mktree'], entries.join('\n'))
    return git([
      'commit-tree',
      tree,
      ...parents.flatMap((parent) => ['-p', parent]),
      '-m',
      'Update test fixture'
    ])
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'release-workflow-'))
    env = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(repo, 'no-global-config'),
      GIT_AUTHOR_NAME: 'Workflow Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Workflow Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid'
    }
    git(['init', '--quiet'])
    before = commit({ name: 'training-project', version: '0.1.0' })
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  function runDelivery(
    previous: string,
    sha: string,
    eventName = 'push',
    outputPath = join(repo, 'step-output')
  ) {
    const tag = jest.fn()
    const release = jest.fn()
    const steps: Record<string, { outputs: Record<string, string> }> =
      Object.fromEntries(delivery.map((step) => [step.id, { outputs: {} }]))
    const context = {
      github: { event_name: eventName, sha, event: { before: previous } },
      steps
    }
    let exitCode: number | null = 0
    let stderr = ''

    function evaluate(expression: string) {
      return runInNewContext(
        expression.replace(/^\$\{\{\s*|\s*\}\}$/g, ''),
        context
      )
    }

    function interpolate(value: string | number) {
      return String(value).replace(/\$\{\{(.*?)\}\}/g, (_, expression) =>
        String(evaluate(expression))
      )
    }

    // Execute the workflow's Node check, but never call the external actions.
    for (const step of delivery) {
      if (exitCode !== 0 || (step.if && !evaluate(step.if))) continue

      if (step.id === 'version') {
        const command = step.run?.match(
          /^node --input-type=module <<'NODE'\n([\s\S]+)\nNODE\s*$/
        )
        if (!command) throw new Error('Unsupported version-check command')
        const result = spawnSync(
          process.execPath,
          ['--input-type=module', '-'],
          {
            cwd: repo,
            encoding: 'utf8',
            input: command[1],
            env: {
              ...env,
              ...Object.fromEntries(
                Object.entries(step.env ?? {}).map(([key, value]) => [
                  key,
                  interpolate(value)
                ])
              ),
              GITHUB_OUTPUT: outputPath
            }
          }
        )
        if (result.error) throw result.error
        exitCode = result.status
        stderr = result.stderr
        if (exitCode === 0) {
          context.steps[step.id] = {
            outputs: Object.fromEntries(
              readFileSync(outputPath, 'utf8')
                .trim()
                .split('\n')
                .map((line) => line.split('='))
            )
          }
        }
      } else if (step.id === 'tag') {
        tag(interpolate(step.with?.ref ?? ''))
        context.steps[step.id] = { outputs: { version: '2.0.0' } }
      } else if (step.id === 'release') {
        release(interpolate(step.with?.tag ?? ''))
      }
    }
    return { tag, release, exitCode, stderr }
  }

  function expectNoRelease(result: ReturnType<typeof runDelivery>) {
    expect(result.tag).not.toHaveBeenCalled()
    expect(result.release).not.toHaveBeenCalled()
  }

  function expectRelease(result: ReturnType<typeof runDelivery>, sha: string) {
    expect(result.tag).toHaveBeenCalledTimes(1)
    expect(result.tag).toHaveBeenCalledWith(sha)
    expect(result.release).toHaveBeenCalledTimes(1)
    expect(result.release).toHaveBeenCalledWith('v2.0.0')
  }

  it('checks out full history at the triggering revision', () => {
    expect(delivery.find((step) => step.id === 'checkout')?.with).toMatchObject(
      {
        'fetch-depth': 0,
        ref: '${{ github.sha }}'
      }
    )
  })

  it.each(['README.md', 'game.js'])(
    'does not tag or release a %s-only change',
    (file) => {
      const after = commit(
        { name: 'training-project', version: '0.1.0' },
        [before],
        { [file]: 'Updated content' }
      )
      const result = runDelivery(before, after)
      expect(result.exitCode).toBe(0)
      expectNoRelease(result)
    }
  )

  it.each([
    { name: 'renamed-project', version: '0.1.0' },
    {
      version: '0.1.0',
      name: 'training-project',
      description: 'A training game'
    },
    '{\n  "version": "0.1.0",\n  "name": "training-project"\n}\n'
  ])('does not release non-version manifest edits: %p', (manifest) => {
    const result = runDelivery(before, commit(manifest, [before]))
    expect(result.exitCode).toBe(0)
    expectNoRelease(result)
  })

  it('tags and releases a version bump at the triggering commit', () => {
    const after = commit({ version: '2.0.0' }, [before])
    const result = runDelivery(before, after)
    expect(result.exitCode).toBe(0)
    expectRelease(result, after)
  })

  it('compares the entire push rather than only the last commit', () => {
    const bump = commit({ version: '2.0.0' }, [before])
    const after = commit({ version: '2.0.0' }, [bump], {
      'README.md': 'Updated'
    })
    const result = runDelivery(before, after)
    expect(result.exitCode).toBe(0)
    expectRelease(result, after)
  })

  it('releases a merged version bump', () => {
    const feature = commit({ version: '2.0.0' }, [before])
    const main = commit({ version: '0.1.0' }, [before], {
      'game.js': 'Updated'
    })
    const after = commit({ version: '2.0.0' }, [main, feature])
    const result = runDelivery(main, after)
    expect(result.exitCode).toBe(0)
    expectRelease(result, after)
  })

  it('does not release a version bump reverted within the same push', () => {
    const bump = commit({ version: '2.0.0' }, [before])
    const after = commit({ version: '0.1.0' }, [bump])
    const result = runDelivery(before, after)
    expect(result.exitCode).toBe(0)
    expectNoRelease(result)
  })

  it('does not release an initial import even when its history has version bumps', () => {
    const after = commit({ version: '2.0.0' }, [before])
    const result = runDelivery('0'.repeat(40), after)
    expect(result.exitCode).toBe(0)
    expectNoRelease(result)
  })

  it('keeps manual packaging runs from creating another release', () => {
    const after = commit({ version: '2.0.0' }, [before])
    const result = runDelivery('', after, 'workflow_dispatch')
    expect(result.exitCode).toBe(0)
    expectNoRelease(result)
  })

  it.each(['', 'main', 'not-a-commit', 'a'.repeat(39)])(
    'rejects an invalid before revision: %p',
    (previous) => {
      const result = runDelivery(previous, before)
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('BEFORE must be a full commit SHA')
      expectNoRelease(result)
    }
  )

  it('rejects an invalid after revision', () => {
    const result = runDelivery(before, 'main')
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('AFTER must be a full commit SHA')
    expectNoRelease(result)
  })

  it.each(['before', 'after'])(
    'fails if the %s Git object is unavailable',
    (side) => {
      const missing = 'f'.repeat(40)
      const result = runDelivery(
        side === 'before' ? missing : before,
        side === 'after' ? missing : before
      )
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('fatal:')
      expectNoRelease(result)
    }
  )

  it.each([
    '{',
    {},
    { version: null },
    { version: 2 },
    { version: '' },
    { version: '   ' }
  ])('rejects invalid manifests on either side: %p', (manifest) => {
    const invalid = commit(manifest, [before])
    for (const [previous, after] of [
      [before, invalid],
      [invalid, before]
    ]) {
      const result = runDelivery(previous, after)
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).not.toBe('')
      expectNoRelease(result)
    }
  })

  it('fails if package.json is missing', () => {
    const after = commit(undefined, [before], { 'README.md': 'No manifest' })
    const result = runDelivery(before, after)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('package.json')
    expectNoRelease(result)
  })

  it('does not hide an output-file write failure', () => {
    const after = commit({ version: '2.0.0' }, [before])
    const result = runDelivery(before, after, 'push', repo)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).not.toBe('')
    expectNoRelease(result)
  })
})
