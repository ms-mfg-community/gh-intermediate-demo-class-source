# GitHub Intermediate - Project Repository

![Continuous Integration](https://github.com/githubschool/gh-github-intermediate-template/actions/workflows/continuous-integration.yml/badge.svg)
![Continuous Delivery](https://github.com/githubschool/gh-github-intermediate-template/actions/workflows/continuous-delivery.yml/badge.svg)
![CodeQL](https://github.com/githubschool/gh-github-intermediate-template/actions/workflows/codeql.yml/badge.svg)
![Coverage](./badges/coverage.svg)
![Linter](https://github.com/githubschool/gh-github-intermediate-template/actions/workflows/linter.yml/badge.svg)

This is your project repository for the GitHub Intermediate training offering.
Within this repository, you will find a game that you will extend, repair and
release across a series of labs. The final completed project will be a web-based
game deployed to GitHub Pages.

Once deployed, you will be able to access your game at the link in the **About**
column of the repository's home page.

> **The tests fail when you start, and that is expected.** One of the commits in
> this repository's history disabled a working test. Lab 3 has you find it and
> repair it.

## Prerequisites

- [GitHub.com Account](https://github.com)
- [Git](https://git-scm.com/downloads)
- (Optional) [Node.js v22+](https://nodejs.org/en)

## Activities and Labs

- [Lab 0: Clone the Repository](./labs/0-clone-the-repository.md)
- [Lab 1: Add a Feature](./labs/1-add-a-feature.md)
- [Lab 2: Add Tags](./labs/2-add-tags.md)
- [Lab 3: Git Bisect](./labs/3-git-bisect.md)
- [Lab 4: Interactive Rebase](./labs/4-interactive-rebase.md)
- [Lab 5: Cherry-Picking Commits](./labs/5-cherry-pick.md)
- [Lab 6: Protect the `main` Branch](./labs/6-protect-main.md)
- [Lab 7: GitHub Flow](./labs/7-github-flow.md)
- [Lab 8: Merge Conflicts](./labs/8-merge-conflicts.md)
- [Lab 9: Run a GitHub Actions Workflow](./labs/9-run-a-workflow.md)
- [Lab 10: Create a Release](./labs/10-create-a-release.md)
- [Lab 11: Deploy to an Environment](./labs/11-deploy-to-an-environment.md)

## For Instructors

Classroom repositories are provisioned, not generated from a template. See:

- [Provisioning](./docs/provisioning.md) — how to build the golden repository,
  export the delivery bundle, and seed per-student repositories. Read the
  Node.js section before your first run.
- [Lab Contract](./docs/lab-contract.md) — the exact repository state each lab
  assumes, what the learner creates, and the expected instructional failures.

## Reference

This repository is a fork of the [2048](https://github.com/gabrielecirulli/2048)
repository.
