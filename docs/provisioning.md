# Provisioning

How to build the golden course repository, hand it over, and seed per-student
repositories from it.

Read [`lab-contract.md`](./lab-contract.md) first: it states _what_ is
provisioned. This document covers _how_.

## 1. What this tool does and does not do

**It does:** build a golden repository containing the state the labs assume,
export it as a Git bundle, substitute per-class placeholders, and create and
seed organization-owned private repositories through the GitHub REST API.

**It does not:** create organizations or teams, invite members, delete or tear
down anything, or install dependencies on anybody's machine.

**The classroom tree is trimmed.** The first seeded commit removes this tool's
own test files, because they read the repository they run in and would fail a
learner's continuous integration permanently once Lab 1 creates a branch. The
tooling itself ships, so a customer can provision from the bundle they receive.

**A Git bundle carries Git history. That is all it carries.** It does not carry
`node_modules`, and it does not carry pull requests, issues, releases, rulesets
or Pages configuration — those are GitHub-side resources that exist only in a
GitHub repository and are created by the provisioning run, after the push.

## 2. Requirements

### Operating system and shell

Developed and verified on **Windows 11 with PowerShell**. The tooling shells out
to `git` and to `node` with forward-slash-agnostic paths, so it is expected to
work on macOS and Linux, but that has not been verified. Nothing here has been
tested on a shell other than PowerShell.

### Git

Any Git that supports `bundle`, `bisect run` and `ls-remote`. Verified with Git
2.55 on Windows.

Keep `core.autocrlf` set to `false` in this repository. Line-ending rewriting
changes fixture bytes and will make a build non-reproducible.

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

The implementation was written and verified on **Node 24.15.0 with npm 10.2.3**.

The provisioning CLI runs TypeScript directly through Node's built-in type
stripping, so there is no build step. **That requires a newer Node than
`.node-version` pins:** unflagged type stripping is not available on 22.9.0, so
`npm run provision` needs Node 22.18 or newer, and was verified on 24.15.0. The
project's own `npm test`, `npm run lint` and `npm run build` are unaffected and
still work on the pinned version.

A small resolution hook (`tools/provisioning/loader.mjs`) maps the repository's
`./module.js` import specifiers onto their TypeScript sources; it adds no
dependency.

### Dependencies

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
fixture and exporting a bundle need no network once dependencies are installed.
Installing dependencies does. Provisioning against GitHub obviously does.

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

Creates `C:\work\golden` from the current repository's history and seeds the lab
state into it. **The target must not already exist.** The source repository is
never modified: history is imported through a single explicit refspec.

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

It proves nothing about a real organization, its permissions, or its Pages
eligibility. Treat a passing dry run as evidence the tool is internally
consistent, not as evidence a classroom is ready.

### Plan against GitHub

```powershell
$env:GITHUB_TOKEN = '<token>'
npm run provision -- plan --config C:\work\class.json
```

`plan` is the default verb. It issues only `GET` requests and writes nothing.
Run it and read the output before considering `apply`.

### Apply against GitHub

```powershell
npm run provision -- apply --config C:\work\class.json --confirm
```

`--confirm` is mandatory. Without it the run refuses, because **holding a
credential is not authorization to use it**.

## 4. Configuration file

```json
{
  "organization": "<organization>",
  "classTeam": "<class-team>",
  "repositoryPrefix": "gh-intermediate",
  "participants": ["participant-01", "participant-02"],
  "sourceRepository": "C:\\work\\class",
  "expectedOperator": "<provisioning-account-login>",
  "enablePages": true,
  "privatePagesConfirmed": false,
  "rulesets": [],
  "issues": []
}
```

Keep this file, and the credential, outside this repository. Neither is generic
material.

`expectedOperator` is checked against `GET /user` before anything is written. If
the credential resolves to a different account the run stops.

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
  would delete anything on the remote the source lacks.
- **Nothing is ever deleted.** There is no teardown path, and failure is never
  recovered by removing a resource.
- **Failures stop the run.** A permission error, an ambiguous owner or an
  unsupported capability is reported as blocked. Nothing is converted into a
  success-shaped default.

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
  depends on the tenant's plan and type. The API cannot establish it, so this
  tool requires `privatePagesConfirmed` and reports the result as
  `operator-asserted` — never as something it verified. Without that assertion
  Pages is refused. It is **never** downgraded to a public site.
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

## 8. Handover route

1. **IP owner** builds the golden repository, confirms `LICENSE` and `NOTICE`
   are in the tagged tree, and tags a release.
2. **Delivery lead** exports the bundle and hands it over through the
   engagement's normal file channel. Nothing is pushed on the customer's behalf.
3. **Customer's organization admin** creates an organization in their own
   tenant, clones from the bundle, and pushes into a repository they own.
4. **Instructor** renders the class placeholders, then runs `plan`, reads it,
   and runs `apply --confirm`.

## 9. Verification status

Everything in sections 3 and 5 is exercised by the test suite using real
temporary Git repositories and a local fake GitHub service. No test contacts a
network. The suite also builds a fixture, runs the classroom project's own Jest
suite inside it, and requires it to fail before Lab 3 and pass afterwards.

**No part of this tool has been run against GitHub.** The request shapes were
checked against the GitHub REST reference on 2026-09-09, and the decision logic
is tested against a fake, but a fake agrees with whatever it was written to
agree with. Section 6's constraints, and everything in section 7, remain
unverified against a live tenant.

Run the tests with:

```powershell
$env:NODIST_NODE_VERSION='24.15.0'; npm test
```
