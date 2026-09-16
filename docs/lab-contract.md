# Lab Contract

This document states the repository state each lab assumes, the state the
learner creates, and the wiring changes made to keep the two consistent. It is
the interface between the lab material and anything built on top of it,
including slides.

The machine-readable source of truth is
[`tools/provisioning/contract.ts`](../tools/provisioning/contract.ts). Every
value below is asserted by tests in
[`__tests__/provisioning_fixture.test.ts`](../__tests__/provisioning_fixture.test.ts).
If this document and that file ever disagree, the file is correct and this
document is stale.

## 1. Starting state

A per-student repository is **organization-owned and private**. It is created
empty and then seeded by pushing an enumerated set of references, not by forking
and not from a template.

| Reference                          | Kind   | Consumed by |
| ---------------------------------- | ------ | ----------- |
| `refs/heads/main`                  | branch | all labs    |
| `refs/heads/feature/animate-score` | branch | Lab 4       |
| `refs/heads/feature/start-tiles-4` | branch | Lab 8       |
| `refs/heads/feature/start-tiles-3` | branch | Lab 8       |
| `refs/heads/feature/tile-value-2`  | branch | Lab 8       |
| `refs/heads/feature/tile-value-1`  | branch | Lab 8       |
| `refs/tags/lab-baseline`           | tag    | Lab 3       |

Nothing else is exported. Remote-tracking references, GitHub-managed pull
request references, notes and stashes are excluded by an allow-list rather than
by filtering, so an incidental branch in a maintenance clone cannot reach a
classroom.

### Commits appended to `main`

The full imported course history is preserved and remains reachable. Six commits
are appended on top of it, in this order:

1. `Remove maintenance tooling tests` — trims the classroom tree
1. `Add watch script`
1. `Document the game controls`
1. `Disable broken test` — introduces the Lab 3 defect
1. `Tidy the game rules markup`
1. `Note the class baseline in the README`

`feature/animate-score` branches from `Add watch script`, so it is four commits
behind `main` when the class starts.

### What the classroom tree does not carry

`__tests__/provisioning_fixture.test.ts` and
`__tests__/provisioning_github.test.ts` are removed by the first seeded commit.
They exercise the fixture builder, which reads the repository they run in, so in
a learner's clone they would run under continuous integration and fail
permanently the moment Lab 1 creates `feature/rules` — the builder correctly
refuses to seed over a reference a learner creates.

`tools/provisioning` itself is kept, so a customer can provision from the
delivered bundle. It is never collected by Jest, whose roots are `src/` and
`__tests__/`.

## 2. Expected instructional failures

**Continuous integration is red when the class begins, and that is correct.**
`Disable broken test` replaces the assertion in
`__tests__/keyboard_input_manager.test.ts` with `expect(true).toBe(false)`, and
that assertion is still present at the learner's starting `HEAD`. Lab 3 has the
learner find it and repair it, and Lab 3 Task 7 states that the tests will pass
on the next run once the fix is merged.

This failure exists **only in the learner fixture**. It is generated into an
isolated temporary repository at build time and is never committed to the
maintenance branch, whose continuous integration must stay green. A test asserts
that the marker is absent from the working tree of this repository.

Both halves of this promise are executed, not asserted from the lab text: a test
clones the built fixture and runs the checks
`.github/workflows/continuous-integration.yml` defines, **in workflow order**,
reading that order from the workflow rather than restating it. At the learner's
starting `HEAD`, `Check Format` and `Lint` pass and `Test` fails. The test then
applies `solutions/3-git-bisect/keyboard_input_manager.test.ts` and requires all
three checks to pass. Every assertion is on an exit status, never on log text.

### Red for the right reason

The pipeline runs `Check Format`, then `Lint`, then `Test`, and stops at the
first failure. A formatting or lint failure at the starting point would
therefore stop the run before `Test`, and the class would see a formatting error
where the curriculum promises a failing test — the Lab 3 exercise would never
run.

The builder's own generated content is consequently held to the repository's
Prettier configuration. `.prettierrc.yml` sets `proseWrap: always`, so Prettier
owns line breaks in Markdown prose; generated prose is written unwrapped, and
the builder refuses to build if a generated line would exceed the configured
`printWidth`. Every file the builder writes is normalised to exactly one
trailing newline.

This holds for **every commit the builder seeds** — the six on `main` and the
commits on all five seeded branches — so a learner who stops mid-bisect on a
seeded commit and runs the checks sees the same result. It does **not** hold for
the imported upstream history below `lab-baseline`, which contains commits that
predate this configuration and do not satisfy it. Those commits are preserved
verbatim for provenance and are not rewritten. Lab 3 asks the learner to grep at
each bisect step, not to run the pipeline, so this does not affect the exercise.

It also holds **after `render` substitutes the class placeholders**. A test
renders a freshly built classroom tree with a class name long enough to push a
rewritten Markdown line past `printWidth`, then runs the pipeline:
`Check Format` and `Lint` pass and the run reaches `Test`, which fails on the
seeded defect described above.

## 3. Lab-by-lab contract

| Lab | Needs before it starts                               | Learner creates             |
| --- | ---------------------------------------------------- | --------------------------- |
| 1   | `main`, Pages enabled                                | `feature/rules`             |
| 2   | several distinct commits on `main`                   | tags `v1.0.0`, `v1.0`, `v1` |
| 3   | broken assertion at `HEAD`; `lab-baseline` tag       | `fix/unit-test`             |
| 4   | `feature/animate-score`, four commits, behind `main` | squashed commit, merge      |
| 5   | history to cherry-pick from                          | `feature/new-game`          |
| 6   | organization-owned repo; class team exists           | `CODEOWNERS`, ruleset       |
| 7   | `main`, review partner                               | `fix/stuck-tiles`           |
| 8   | four branches, four open pull requests               | conflict resolutions        |
| 9   | workflows present                                    | workflow run                |
| 10  | merged work on `main`                                | release                     |
| 11  | Pages environment, branch-deploy workflow            | `.deploy` comments          |

### References the learner creates — never seed these

`feature/rules` (Lab 1), `fix/unit-test` (Lab 3), `feature/new-game` (Lab 5),
`fix/stuck-tiles` (Lab 7).

Seeding any of them removes the exercise that creates it. The builder and the
provisioner both detect a collision between inherited references and this list
and fail loudly rather than proceeding.

**Lab 6 is not pre-applied.** `main` carries no ruleset and no `CODEOWNERS` file
when the class starts, because writing them _is_ Lab 6. The provisioning adapter
supports rulesets, but applies none unless an operator explicitly configures
one.

## 4. Seeded pull requests

Identified by head and base branch plus the seeding identity — **never by
title**. Two pairs share a title deliberately, and a title match would conflate
them.

| Title                                 | Head                    | Base   | Role                   |
| ------------------------------------- | ----------------------- | ------ | ---------------------- |
| Increase the number of starting tiles | `feature/start-tiles-4` | `main` | merged first (UI)      |
| Increase the number of starting tiles | `feature/start-tiles-3` | `main` | conflicts second (UI)  |
| Increase rate of tiles with value 4   | `feature/tile-value-2`  | `main` | merged first (CLI)     |
| Increase rate of tiles with value 4   | `feature/tile-value-1`  | `main` | conflicts second (CLI) |

### Lab 8 values

Baseline in `src/game_manager.ts`:

```typescript
static startTiles: number = 1
const value = Math.random() < 0.9 ? 2 : 4
```

| Branch                  | Sets                                        |
| ----------------------- | ------------------------------------------- |
| `feature/start-tiles-4` | `static startTiles: number = 2`             |
| `feature/start-tiles-3` | `static startTiles: number = 4`             |
| `feature/tile-value-2`  | `const value = Math.random() < 0.5 ? 2 : 4` |
| `feature/tile-value-1`  | `const value = Math.random() < 0.1 ? 2 : 4` |

**The numeric suffix in a branch name is an identifier, not the value the branch
sets.** `feature/start-tiles-4` sets `2`. This looks like a mistake and is not
one: `labs/8-merge-conflicts.md` prints the conflict blocks the learner will
see, and those blocks are normative. Task 2 shows `feature/start-tiles-3`
offering `4` against `2` already on `main`; Task 4 shows `feature/tile-value-1`
offering `0.1` against `0.5`. Aligning suffix to value would contradict the
printed lab output. Both directions also read correctly as increases: `1` to `2`
and `1` to `4` both increase the starting tile count, and `0.9` to `0.5` to
`0.1` both increase the rate of tiles worth 4.

End state, when the learner keeps the pull request's side of both conflicts:

```typescript
static startTiles: number = 4
const value = Math.random() < 0.1 ? 2 : 4
```

A test replays the whole lab against real Git — merging each pair in order,
resolving the conflict, and asserting the resulting file — rather than asserting
a message.

**Conflict marker labels are not part of the contract.** The command line writes
`HEAD` where the GitHub UI writes the branch name, and the two lab tasks merge
in opposite directions. Only the values and the non-zero exit are asserted.

## 5. Seeded issues: none

**The issue set is empty by evidence, not by omission.** All eleven labs were
read for a dependency on a pre-existing issue and none has one. Lab 6 has the
learner author `CODEOWNERS` and the ruleset. Lab 11 drives IssueOps through pull
request comments, not issues. The provisioning adapter supports issue seeding so
an instructor can add orientation issues through configuration, and seeds none
by default.

Note that `README.md` previously claimed the repository contains "a number of
issues that you will be working on". No lab depended on that sentence being
true, and it is now corrected to describe the game rather than issues. That
change is recorded here rather than made silently.

## 6. Wiring changes made

Four curriculum artifacts were changed to keep the material consistent with the
state the builder produces, plus one README correction. Each is declared here
rather than applied silently, and all four are guarded by a test.

### 6.1 `solutions/8-merge-conflicts/game_manager.ts` reconciled

**Was:** `startTiles = 2` and `Math.random() < 0.9`. **Now:** `startTiles = 4`
and `Math.random() < 0.1`.

The previous contents matched neither the conflict blocks printed in the lab nor
the end state the lab's own instructions produce. `0.9` is the _baseline_ value
that both tile-value branches move away from, so a learner comparing their
result against the solution would have concluded they had made a mistake. The
lab prose is normative and the solution file was wrong.

### 6.2 Lab 4 Task 1 graph redrawn

**Was:** a graph showing `Update scoreboard size`, `Remove comment` and
`Revert change` on `main`, with a single commit on `feature/animate-score`.

**Now:** a graph showing all four of those commits on the branch, and `main`'s
own commits above the branch point.

`git rebase --interactive main` lists only commits absent from `main`, and Task
2 prints a four-entry todo list. The branch therefore carries four commits and
the previous graph contradicted the next task in the same lab. Task 3's
post-rebase graph was updated to the new `main` tip for the same reason. The
commit identifiers remain illustrative, as the lab already states.

### 6.3 Lab 3 anchors the bisect on a tag

**Was:** "select the earliest commit in the logs (the one labeled
`Initial commit`)".

**Now:** `git bisect good lab-baseline`, with a short explanation of why.

Two independent problems made the old instruction unusable:

1. **There is no commit labelled `Initial commit`.** The imported history's root
   commit is `Add CodeQL workflow`.
2. **`git bisect` assumes a single transition, and this history has two.** The
   imported history introduced the same `expect(true).toBe(false)` assertion at
   one commit and removed it thirty commits later. Marking the root commit good
   spans both transitions, so `git bisect` is not required to converge on the
   commit the builder seeded — which of the two it reports depends on the path
   its binary search takes through the history, and it exits 0 either way. Both
   candidates carry the subject `Disable broken test`, so the log gives the
   learner nothing to notice. A test asserts the structural cause rather than a
   particular outcome: the marker is present at a commit below `lab-baseline`
   and absent at the tag itself, so anchoring on the tag leaves exactly one
   transition.

The builder does not hardcode the anchor. It searches the imported history for
changes to the marker, takes the most recent one at which the marker is absent,
tags it `lab-baseline`, and then verifies the choice by running a real
`git bisect run` and requiring it to blame the seeded commit.

Anchoring on a known-good release is also better practice than picking the
oldest commit, so the change improves the lab rather than merely repairing it.

### 6.4 README repository description

**Was:** "you will find a number of issues that you will be working on".
**Now:** a description of the game, plus a short note that the failing test at
the start is expected.

No lab creates or consumes an issue, so the original sentence set an expectation
the provisioned repository does not meet.

### 6.5 Lab 3 Task 2 worked example diffstat corrected

**Was:** a diffstat showing two files changed, including
`solutions/3-bisect/keyboard_input_manager.test.ts` with 124 insertions, for a
total of "126 insertions(+), 8 deletions(-)".

**Now:** the diffstat the seeded commit actually produces —
`__tests__/keyboard_input_manager.test.ts | 3 ++-`, "1 file changed, 2
insertions(+), 1 deletion(-)" — with the commit hash marked as illustrative.

The quoted commit was an ancestor of `lab-baseline`, so `git bisect` could never
report it, and the path `solutions/3-bisect/` does not exist in this repository:
the solutions directory is `solutions/3-git-bisect/`. A learner comparing the
printed output against their own would have concluded they had bisected to the
wrong commit. The hashes and dates in the example still vary between builds, so
the example now says so; a test compares its file list and magnitudes against
`git show --stat` of the commit the builder seeds.

### 6.5 Bisect exit codes

`grep` exits **0 on a match**, and `git bisect` reads exit 0 as **good** — so a
naive `git bisect run grep …` inverts the lab's meaning. A missing file exits 2,
which `git bisect` also treats as bad, and the target test file does not exist
in the earliest commits of this history.

The predicate the builder generates maps _marker present_ to a non-zero exit and
both _marker absent_ and _file missing_ to zero. Any slide or note showing this
flow must use the same mapping.

## 7. Configuration inputs and outputs

### Inputs, all explicit

| Input                   | Used for                                              |
| ----------------------- | ----------------------------------------------------- |
| `organization`          | owner of every classroom repository                   |
| `classTeam`             | `CODEOWNERS` target substituted into Lab 6            |
| `repositoryPrefix`      | per-student repository names                          |
| `participants`          | one repository per entry                              |
| `sourceRepository`      | local repository the references are pushed from       |
| `expectedOperator`      | login the credential must resolve to                  |
| `enablePages`           | verify an existing private, workflow-based Pages site |
| `privatePagesConfirmed` | eligibility assertion only, not site-privacy evidence |
| `rulesets`              | optional; empty by default                            |
| `issues`                | optional; empty by default                            |

Pages is configured manually by the customer's administrator, never created or
changed by the provisioner. Initial provisioning uses `enablePages=false`. After
manual private setup, a read-only plan with both Pages flags true requires the
existing site to report `build_type=workflow` and `public=false`. A missing,
public or visibility-unknown site blocks the check. The boolean flags must be
actual JSON booleans. See the
[two-phase route](./provisioning.md#two-phase-pages-contract).

During manual Pages setup, pause **Deploy to GitHub Pages** and **Branch
Deploy** and stop any active or queued deployment runs. Do not publish until the
read-only plan with both flags true confirms private visibility. Then re-enable
both workflows and manually dispatch **Deploy to GitHub Pages** on **main** for
the initial deployment. Pausing, configuration, dispatch and viewer-access
checks are customer-admin operations, not actions performed by the provisioner.

Attendee access is also manual. The class team must be **Visible**, with **Write
granted directly on every class repository**, as required by
[GitHub's CODEOWNERS documentation](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners).
Individual members' access is not a substitute for the team's direct Write
access. For Lab 6, grant temporary **Admin only on each learner's own
repository**, then restore Write; an administrator-led demonstration is the
alternative. Do not grant the entire team Admin. No provisioning run grants
access or verifies team visibility and direct permissions.

The live CLI uses `https://api.github.com` and has no alternate-host option.

### Placeholders

The generic material carries `<organization>` and `<class-team>`. They are
substituted on a per-class copy immediately before seeding, so no customer name
is ever committed to this repository. The provisioner refuses to run against a
source whose class configuration is still unrendered.

`render` rewrites an **explicit allow-list**, `CLASS_CONFIG_FILES` in
`tools/provisioning/contract.ts`, and nothing else:

| File                     | Why it is class configuration                                                                                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `labs/6-protect-main.md` | Task 1 has the learner type `* @<organization>/<class-team>` into `CODEOWNERS`; Task 3 prints the rejected-push output naming `github.com/<organization>/<repository>` |

Its generated commit uses `Course Fixture Builder <fixture@example.invalid>` for
both author and committer. Customer `git user.name` and `git user.email` are not
required for `render` and are not changed.

The list is enumerated rather than discovered by scanning for the tokens,
because a content scan cannot tell a file that **carries** class configuration
from one that **describes or implements** the mechanism — both contain the
token. These files keep their tokens verbatim through a render:

| File                             | Why its tokens must survive                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------- |
| `tools/provisioning/contract.ts` | Defines `PLACEHOLDERS`; rewriting it leaves the delivered tooling unable to render the next class |
| `docs/lab-contract.md`           | This document                                                                                     |
| `docs/provisioning.md`           | The provisioning route                                                                            |
| `labs/0-clone-the-repository.md` | Generic URL templates; the learner supplies both owner and repository from their assigned URL     |

`render` reports both sets: what it substituted, and what it left carrying
tokens by design. `findPlaceholders` remains a content scan and is the
diagnostic behind that report; `unrenderedClassConfig` answers the narrower
question a provisioning run asks.

`CODEOWNERS` is deliberately not on the allow-list. Lab 6 Task 1 is the exercise
that creates it, so a classroom tree ships without one.

### Outputs

A build reports the seeded commit for each branch, the bisect anchor, the seeded
bad commit, and the exported reference list. A provisioning run reports one
action per resource, each marked `create`, `satisfied` or `blocked`. In write
mode, the first blocked operation stops subsequent items, groups and
participants. Earlier completed writes remain; there is no rollback. A plan is
read-only and can report more than one blocker.

## 8. Dependencies between labs

- Lab 3 must be completed before Lab 9 shows a green pipeline. Until then the
  pipeline is red at `Test`, having passed `Check Format` and `Lint`.
- Lab 4 assumes `main` has moved since `feature/animate-score` was created; that
  is true from the moment the class starts and stays true after Lab 3.
- Lab 8's second merge in each pair only conflicts once the first is merged.
  Merging in the wrong order produces two clean merges and no exercise.
- Lab 10 and Lab 11 depend on work merged in earlier labs being on `main`.
- The two Lab 8 pairs are independent: `startTiles` and the tile value are far
  enough apart in the file that resolving one does not affect the other.

## 9. What this document does not establish

The state described here is produced and verified locally. Nothing in it has
been exercised against GitHub. Whether a given organization can publish a
private Pages site, apply rulesets, or use hosted runners are properties of that
tenant, and they are per-engagement inputs to confirm — never facts to assume.
