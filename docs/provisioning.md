# Provisioning

How to build the golden course repository, hand it over, and seed per-student
repositories from it.

Read [`lab-contract.md`](./lab-contract.md) first: it states _what_ is
provisioned. This document covers _how_.

## 1. What this tool does and does not do

**It does:** build a golden repository containing the state the labs assume,
export it as a Git bundle, substitute per-class placeholders, and create and
seed organization-owned private repositories using the GitHub REST API and Git.
It can also verify an existing private, workflow-based Pages configuration.

**It does not:** create organizations or teams, invite members, **grant anyone
access to a provisioned repository**, delete or tear down anything, or install
dependencies on anybody's machine. It never creates a Pages site or changes its
visibility or publishing configuration.

**Granting attendees access is a manual step, and nothing works without it.** A
provisioned repository is private and org-owned, and the run adds no
collaborator and no team permission. Until an administrator grants each learner
access to their own repository, every learner sees a `404` — which is what
[Lab 0](../labs/0-clone-the-repository.md) Task 2 tells them to report. Do it
before asking learners to use the repositories. **Write is the normal attendee
permission. Lab 6 is the Admin exception:** a learner creating a ruleset needs
Admin on their own repository for that exercise. An administrator-led
demonstration is the alternative; learners do not need organization-wide Admin.

**The classroom tree is trimmed.** The first seeded commit removes this tool's
own test files, because they read the repository they run in and would fail a
learner's continuous integration permanently once Lab 1 creates a branch. The
tooling itself ships, so a customer can provision from the bundle they receive.

**A Git bundle carries Git history. That is all it carries.** It does not carry
`node_modules`, and it does not carry pull requests, issues, releases, rulesets
or Pages configuration — those are GitHub-side resources that exist only in a
GitHub repository. The run creates the seeded pull requests and any explicitly
configured issues and rulesets. Pages setup and releases are separate
operations.

## 2. Requirements

### Operating system and shell

Local verification uses **Windows with PowerShell**. The tooling shells out to
`git` and to `node` with forward-slash-agnostic paths, so it is expected to work
on macOS and Linux, but that has not been verified. Nothing here has been tested
on a shell other than PowerShell.

### Git

Any Git that supports `bundle`, `bisect run` and `ls-remote`. Verified with Git
2.55 on Windows.

Keep `core.autocrlf` set to `false` in this repository. Line-ending rewriting
changes fixture bytes and will make a build non-reproducible.

### Git authentication is separate from API authentication

`GITHUB_TOKEN` authenticates the Node REST client. It is **not** passed to Git
and does not authenticate `git ls-remote` or `git push`. A successful
`GET /user` check proves neither Git authentication nor Git push permission.

Configure your organization's approved Git credential helper or other approved
Git authentication before running `plan` or `apply`. Remote Git operations
retain the operator's system/global Git configuration, including helpers, URL
rewrites, proxy settings and trust settings. Local fixture-building commands
still ignore that configuration for reproducibility. Git terminal prompts are
disabled during provisioning, so do not depend on being prompted for a token
partway through a run.

For an existing repository you are authorized to access, this is a read-only Git
probe:

```powershell
git ls-remote https://github.com/<organization>/<repository>.git
```

It checks read access only, not permission to push commits or workflow files.
The API returns HTTPS clone URLs; using SSH requires an approved Git URL rewrite
or equivalent configuration. Do not put tokens in repository URLs or tracked
files. The API credential and the Git identity both need the customer-approved
permissions for their respective operations.

### Node.js — read this before your first run

`.node-version` pins **22.9.0**. On a workstation using Nodist, that version may
not be resolvable, in which case a bare `node -v` fails with:

```text
Couldn't resolve version spec 22.9.0
```

This is a version-manager problem, not a project problem. Override it **for the
process only** — do not edit `.node-version`, and do not change a global
version-manager setting:

```powershell
$env:NODIST_NODE_VERSION='24.15.0'; node -v    # v24.15.0
```

Local checks use **Node 24.15.0 with npm 10.2.3**. Set the override again in
every new PowerShell process; it does not change `.node-version` or the lab
runtime.

The provisioning CLI runs TypeScript directly through Node's built-in type
stripping, so there is no build step. **That requires a newer Node than
`.node-version` pins.** Type stripping is not enabled by default on 22.9.0, so
`npm run provision` will not run there; it was written and verified on 24.15.0.
If you need to run it on a specific older release, check that release's notes
for whether type stripping is on by default. The project's own `npm test`,
`npm run lint` and `npm run package` do not use it and are unaffected.

A small resolution hook (`tools/provisioning/loader.mjs`) maps the repository's
`./module.js` import specifiers onto their TypeScript sources; it adds no
dependency.

### Dependencies

**The provisioning CLI itself needs no npm packages.** `tools/provisioning`
imports only Node built-ins, so every command in section 3 runs from a bare
clone with no `node_modules` present. A customer provisioning from a delivered
bundle does not have to install anything.

`npm ci` is required only for the repository's own development checks —
`npm test`, `npm run lint` and `npm run package`:

```powershell
$env:NODIST_NODE_VERSION='24.15.0'; npm ci
```

`npm ci` reaches your configured registry. On a corporate network that means
your proxy and certificate configuration must already work.

**Approved network expectations.** Use your organization's registry and proxy
settings, and its certificate bundle via `NODE_EXTRA_CA_CERTS` or the equivalent
npm setting. Do **not** disable TLS verification, and do not put a password in a
proxy URL — a URL in `~/.gitconfig` or `.npmrc` persists a credential in
cleartext on the workstation. Use a credential helper.

**This tool is not offline-capable and is not claimed to be.** Building a
fixture, exporting a bundle and running a local rehearsal need only Node and
Git, not npm packages or a network. Installing development dependencies and
provisioning against GitHub do require network access.

## 3. Commands

All commands run through one entry point:

```powershell
$env:NODIST_NODE_VERSION='24.15.0'
npm run provision -- <command> [options]
```

### Build the golden repository (local, no network)

```powershell
npm run provision -- build-fixture --source . --target C:\work\golden
```

Creates `C:\work\golden` from the current repository's **committed HEAD** and
seeds the lab state into it. **The target must not already exist.** The source
repository is never modified: history is imported through a single explicit
refspec. Uncommitted maintenance edits are not included; commit the intended
source repairs locally before building a delivery fixture.

Prints a JSON manifest containing the seeded branch tips, the bisect anchor and
the commit the bisect is expected to blame.

The build **refuses to finish** if `LICENSE` or `NOTICE` is missing from the
imported tree, if a seeded reference would collide with one a learner must
create, or if a real `git bisect run` does not blame the commit it seeded.

### Substitute class placeholders (local, no network)

```powershell
npm run provision -- render --repo C:\work\class `
  --organization <organization> --class-team <class-team>
```

Run this on a **per-class copy**, never on the generic repository. It rewrites
`<organization>` and `<class-team>` and records the result as one commit. It
refuses a value that is blank or still looks like a placeholder.

It rewrites only the files listed in `CLASS_CONFIG_FILES`
(`tools/provisioning/contract.ts`) — today just `labs/6-protect-main.md`. The
files that describe or implement the placeholder mechanism, this document, the
[lab contract](./lab-contract.md) and `tools/provisioning/contract.ts` itself,
keep their tokens verbatim, so the tooling in the delivered bundle can still
render the next class. Lab 0 also retains its generic URL templates: the learner
substitutes both owner and repository from their assigned URL. The command
reports all retained tokens.

### Export the delivery bundle (local, no network)

```powershell
npm run provision -- export-bundle --repo C:\work\golden `
  --output C:\work\course.bundle
```

Writes a bundle carrying `HEAD` and exactly the references named in the lab
contract. It verifies the bundle after writing it and refuses to hand over one
carrying anything outside that list.

`HEAD` is included so a customer cloning the bundle lands on a checked-out
default branch rather than an empty working tree.

### Rehearse a provisioning run (local, no network)

```powershell
npm run provision -- dry-run --config C:\work\class.json
```

Runs the full sequence against a local fake GitHub service and **real local bare
repositories**, so the reference push is genuinely executed. It exercises the
request shapes and the decision logic.

Use `enablePages=false` for this initial-provisioning rehearsal. The fake starts
with no Pages sites: `enablePages=true` must block on manual setup rather than
pretend that a newly created private repository has a private Pages site.

It proves nothing about a real organization, its permissions, or its Pages
eligibility. Treat a passing dry run as evidence the tool is internally
consistent, not as evidence a classroom is ready.

### Plan against GitHub

```powershell
$env:GITHUB_TOKEN = '<token>'
npm run provision -- plan --config C:\work\class.json
```

`plan` is the default when only options are supplied; no arguments prints help.
It issues only `GET` requests and read-only Git `ls-remote` calls, and writes
nothing. Run it and read the output before considering `apply`.

### Apply against GitHub

```powershell
npm run provision -- apply --config C:\work\class.json --confirm
```

`--confirm` is mandatory. Without it the run refuses, because **holding a
credential is not authorization to use it**. Use the bare flag, not
`--confirm true` or `--confirm=false`; valued flags are rejected rather than
coerced.

## 4. Configuration file

```json
{
  "organization": "<organization>",
  "classTeam": "<class-team>",
  "repositoryPrefix": "gh-intermediate",
  "participants": ["participant-01", "participant-02"],
  "sourceRepository": "C:\\work\\class",
  "expectedOperator": "<provisioning-account-login>",
  "enablePages": false,
  "privatePagesConfirmed": false,
  "rulesets": [],
  "issues": []
}
```

Keep this file, and the credential, outside this repository. Neither is generic
material.

`expectedOperator` is checked against `GET /user` before anything is written. If
the credential resolves to a different account the run stops.

`enablePages` and `privatePagesConfirmed` must be JSON booleans when supplied.
Quoted strings such as `"false"`, numbers, `null`, arrays and objects are
rejected before authentication or provisioning. Omitting these optional flags
leaves the Pages check off and eligibility unasserted.

### Two-phase Pages contract

1. **Provision the repositories with Pages checking off.** Use the configuration
   above: `enablePages=false`, `privatePagesConfirmed=false`. These settings do
   not disable an already configured site; they skip the Pages check. Read the
   plan, then explicitly authorize the initial provisioning:

   ```powershell
   npm run provision -- plan --config C:\work\class.json
   npm run provision -- apply --config C:\work\class.json --confirm
   ```

2. **Have the customer's administrator configure private Pages manually.**
   Establish that the organization is eligible, then configure each site's
   publishing source as **GitHub Actions** and its visibility as **Private**.
   Follow GitHub's
   [visibility guidance](https://docs.github.com/en/enterprise-cloud@latest/pages/getting-started-with-github-pages/changing-the-visibility-of-your-github-pages-site).
   Do not create a public site and then make it private. If the tenant does not
   offer a way to establish private publication without that interim exposure,
   stop and record this step as unverified; do not improvise a public fallback.

3. **Verify the existing configuration without writing.** Set both
   `enablePages=true` and `privatePagesConfirmed=true` in the same JSON file,
   then:

   ```powershell
   npm run provision -- plan --config C:\work\class.json
   ```

   The operator assertion covers **eligibility only**. The check separately
   requires an existing site's API response to contain `build_type: "workflow"`
   and `public: false`. A missing site, unknown visibility, public site or other
   build type is blocked. `plan` and `apply` never POST or PUT Pages settings.
   `apply` also checks Pages before pushing references or seeding other
   resources in an existing repository, and missing eligibility blocks the
   entire run before any writes.

A successful API check establishes the reported configuration at that moment,
not a working deployment or attendee access. Verify the published URL with an
authorized attendee account and check that anonymous access is denied. If your
environment prevents checking configuration, deployment, permissions or access,
name the unverified item in the setup notes and handover email rather than
calling the classroom ready.

## 5. Safety properties

- **`plan` is the default and mutates nothing.** `apply` needs `--confirm`, a
  configuration naming a target, and a matching operator identity.
- **Read before write, every time.** Existing state is enumerated across all
  pages before anything is created.
- **Stable identity, not titles.** A pull request is matched by head branch,
  base branch and who opened it. Two seeded pairs share a title on purpose.
- **Additive only.** A rerun creates what is missing and leaves everything else
  exactly as it is. Nothing is replaced wholesale.
- **A push goes only into a verified-empty repository.** A repository already
  carrying the full seeded set is reported as satisfied. One carrying anything
  else is refused: it may hold learner work.
- **Enumerated push, not a mirror.** `git push --mirror` would carry
  remote-tracking and pull request references from a maintenance clone, and
  would delete anything on the remote the source lacks. `--no-follow-tags`
  prevents customer Git configuration from adding unlisted tags.
- **Nothing is ever deleted.** There is no teardown path, and failure is never
  recovered by removing a resource.
- **Write mode stops at the first blocked operation or prerequisite group.** No
  dependent mutations, later items in that resource group, or later participants
  are attempted. Earlier completed actions remain; **there is no rollback**.
  Inspect the report and existing state before rerunning. A read-only plan can
  report later participants; its report does not claim execution stopped.
- **Pages is manual setup plus a read-only check.** It is never created or
  reconfigured by this tool, even after an eligibility assertion. A failed check
  is never converted into a success-shaped default.

## 6. Platform constraints

These are properties of GitHub and of a tenant, not of this tool.

- **Classroom repositories must be organization-owned and private.** Rulesets,
  environments and Pages behave differently or are unavailable on a user-owned
  repository. The run refuses a repository that is not private.
- **GitHub-hosted runners are unavailable to repositories owned by managed user
  accounts.** Organization-owned repositories may use them, subject to that
  enterprise's policy. Do not modify workflows to work around this.
- **A managed user account cannot fork or push outside its enterprise.**
  Per-student repositories are therefore created by pushing into fresh, non-fork
  repositories. This is not only a workaround: a repository created by fork has
  an upstream parent, and GitHub's own procedure for opening a pull request from
  a fork targets the _upstream_ repository by default. In a classroom that risks
  a learner aiming a lab pull request at a stranger's repository. A repository
  with no parent cannot do this.
- **A private repository does not guarantee a private Pages site.** Eligibility
  depends on the tenant's plan and type. `privatePagesConfirmed` is an operator
  assertion of eligibility, reported as `operator-asserted`, not proof of site
  privacy. When `enablePages=true`, this tool additionally requires an existing
  site with `public=false` and `build_type=workflow`. GitHub's
  [Enterprise Cloud REST reference](https://docs.github.com/en/enterprise-cloud@latest/rest/pages/pages)
  exposes `public` on GET responses and PUT inputs, but not POST creation
  inputs. The tool therefore never creates a site or attempts a
  public-then-private transition.
- **Tenant type, plan and permissions are never inferred from an account name or
  an email domain.** Where the API cannot establish a fact, it is reported as
  unestablished.

## 7. Per-engagement inputs to confirm

Confirm each with the customer. None may be assumed.

1. An organization exists in their tenant, and the provisioning account can
   create repositories in it.
2. A class team exists, and every participant is a member — Lab 6's `CODEOWNERS`
   review depends on it.
3. Whether their tenant may publish a Pages site that is not publicly readable,
   and whether attendees can view their own.
4. Whether their policy permits the workflows in `.github/workflows` to run, and
   on which runners.
5. Licence allocation for participants.
6. Who grants each participant **Write** access to their own repository. The run
   does not grant it. **Lab 6 requires an explicit Admin exception on that
   repository** for a learner creating a ruleset; an administrator-led
   demonstration can keep attendee access at Write.

## 8. Handover route

1. **IP owner** builds the golden repository, confirms `LICENSE` and `NOTICE`
   are in the tagged tree, and tags a release.
2. **Delivery lead** exports the bundle and hands it over through the
   engagement's normal file channel. Nothing is pushed on the customer's behalf.
3. **Customer's organization admin** creates an organization in their own tenant
   and clones from the bundle, **materialising the seeded branches as local
   references** — see below.
4. **Instructor** renders the class placeholders, then runs `plan`, reads it,
   and runs `apply --confirm` with `enablePages=false`.
5. **Customer's organization admin** grants each learner access to their own
   repository. Section 1: the run does not do this, and a learner without it
   sees a `404`.
6. **Customer's organization admin** establishes eligibility and configures
   private Pages manually. The instructor runs the second-phase read-only plan
   with both Pages flags true and records any live checks they cannot complete.

### Cloning the bundle

`git clone` creates a local branch for `HEAD` only. The seeded feature branches
arrive in the clone but land under `refs/remotes/origin/`, and `apply` pushes
`refs/heads/*`, so a plain clone fails the seed push with:

```text
error: src refspec refs/heads/feature/animate-score does not match any
```

Fetch them into local heads before provisioning. `main` is already local and is
excluded, because Git refuses to fetch into the checked-out branch:

```powershell
git clone course.bundle class-source
cd class-source
git fetch origin "refs/heads/feature/*:refs/heads/feature/*"
```

`git branch` must then list all five feature branches alongside `main`, and
`git tag` must list `lab-baseline`. Every seeded branch is under `feature/`, so
that one refspec covers the contract; `intendedExportedRefs()` in
[`contract.ts`](../tools/provisioning/contract.ts) is the authority if that ever
changes.

## 9. Verification status

The local command and safety paths are exercised by the test suite using real
temporary Git repositories and a local fake GitHub service. No test contacts a
network. Privacy regressions cover public, missing and unknown site visibility;
failure regressions check actual requests and remote refs, including a local
push denied by a bare repository hook and retention of learner work on reruns.
Git configuration is tested with local URL rewrites, not live credential
helpers. The suite also builds a fixture and runs the classroom project's own
continuous integration checks inside it, in the order
`.github/workflows/continuous-integration.yml` runs them: `Check Format` and
`Lint` must pass and `Test` must fail at the learner's starting point, and all
three must pass once the Lab 3 solution is applied. It repeats the
`Check Format` half against a tree rendered with a long class name, and checks
that a rendered tree's own tooling can still render the next class. The checks
are asserted by exit status, so the result does not depend on log wording.

**No part of this tool has been run against GitHub.** The general request shapes
were checked against the GitHub REST reference on 2026-09-09; the Pages GET,
POST and PUT contract and visibility guidance were rechecked on 2026-09-16. The
decision logic is tested against a fake, not a real tenant. The fake models site
visibility independently of repository privacy and does not certify private
publication. Live API and Git authentication, enterprise policy, attendee
permissions, workflow execution, Pages deployment and access remain unverified.

Run the tests with:

```powershell
$env:NODIST_NODE_VERSION='24.15.0'; npm test
```
