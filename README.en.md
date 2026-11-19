# verification-hub

[日本語](./README.md)

This repository holds the checks that the operator's repositories share, and runs them on every change.
The mechanism is a reusable GitHub Actions workflow, [shared-check.yml](./.github/workflows/shared-check.yml).
On every push and pull request, each repository whose entry in the list has caller hub calls this workflow, pinned to a commit.
The repositories it reads, and the check steps it runs in each of them, are listed in [repos.json](./repos.json).
The list now holds 15 of the operator's repositories, and this repository itself.
There is no site.
The archive is on Zenodo. The DOI of the first version is [`10.5281/zenodo.24382351`](https://doi.org/10.5281/zenodo.24382351), and the DOI common to all versions is [`10.5281/zenodo.24382350`](https://doi.org/10.5281/zenodo.24382350).
The hub's own tools use no outside package.
The tools run on Node.js 22.

## Ways of checking, and what the hub runs

The operator's rules ask for 10 independent ways of checking before a report or a merge.
The hub runs the ways that a machine can run.
The ways that need a person or another reviewer stay outside the hub.

| No. | Way | Hub |
| --- | --- | --- |
| 1 | Run the repository's own checks | Runs it (the own job, with the same steps as the repository's CI) |
| 2 | Run the cross-repository check | Runs it (the common job, only for entries with cross true: check_all.js and check_ecosystem.js of the repository that keeps the canonical copies) |
| 3 | Look at the CI results | Produces the result (a person or another reviewer looks at it) |
| 4 | Re-read the sources and the diff | Does not run it |
| 5 | Compare with the primary sources | Does not run it |
| 6 | Recompute the numbers with a separate script | Does not run it |
| 7 | Break a check and see it fail | Runs it (the --break steps in each repository's CI, and --break of this repository's check) |
| 8 | Search every repository for the same patterns | Runs it (the common job: email addresses and broken conjugations) |
| 9 | Compare with the other language, the copies and the sources of generated files | Runs it (the common job: identity of the canonical copies, and links between files) |
| 10 | Have another reviewer check without the conclusion | Does not run it |

Of the 10 ways, the hub runs 5.
The hub produces the CI result; a person or another reviewer looks at it.
The remaining 4 stay outside the hub.

## Jobs

The workflow has three jobs.

- plan reads the list and lays out the check jobs of the calling repository.
- own runs the calling repository's CI checks, one job at a time, with the steps in the list.
- common lays out the repositories in the list as read-only clones, and runs the checks that apply the same rule to every repository.
- common runs the cross-repository check, and scans every repository, only for an entry with cross true.
- common scans only the calling repository for an entry with cross false.

The steps of own are copied from the jobs of each repository's CI workflows that run on push or pull request.
Jobs that are not copied are listed under not_carried, each with its reason.
These are jobs that deploy or record, jobs that run on issues, and jobs that query external APIs.
The copied jobs, like each repository's CI, still install packages and browsers from PyPI, npm, apt and the Playwright download host.
This repository's check compares the steps in the list with the workflows on each repository's main branch, one by one.

## Calling the hub

A calling repository copies [templates/hub.yml](./templates/hub.yml) into its `.github/workflows/`.
The template calls the workflow pinned to a commit of this repository.
The workflow reads its tools and the list from the same commit as itself (`job.workflow_sha` in GitHub Actions).
A change on this repository's main branch therefore leaves the workflow, the tools and the list as they are, until the pin is raised there.
The repositories laid out and the cross-repository check, however, are read from each repository's default branch at the time of the run.
When those change, the result can change under the same pin.
No inputs and no secrets are passed.
The version in the comment (v1) is the version of the calling interface.

## Safeguards

| Safeguard | How it is checked |
| --- | --- |
| The only permission is contents: read | The workflow-level permissions are read, and no job-level permission and no write permission is found |
| No secrets are read | The words secrets, github.token and GITHUB_TOKEN are absent |
| Outside actions are pinned to commits | Every uses value carries a commit and a version comment |
| Every job has a time limit | Each job's timeout-minutes is read, and none exceeds the limit |
| No expression in run lines | No run line holds an expression, and event values appear only in the ref of a checkout |
| The concurrency group sits on the calling job | The calling job has the group, and the workflow has none |
| Never triggered by pull_request_target or workflow_run | The triggers are read, and the two words are absent |
| Checkouts keep no credentials | Every checkout has persist-credentials: false |
| The tools come from the same commit | The checkout of the tools reads job.workflow_repository and job.workflow_sha, after a step that checks both values |
| No repository names in the tools or the workflow | No name in the list appears in the tools or the workflow |

[verification/check.js](./verification/check.js) checks every safeguard.
With `--break`, it breaks the safeguards one at a time, and confirms that the check fails on each.

## The self-contained arrangement

A repository whose entry in the list has caller self-contained does not call this repository.
It holds an identical copy of the same workflow, copies of the tools, a list with its own entry only, and a copy of the tools' licence (MIT).
In that arrangement, the workflow runs that repository's checks, the scan for email addresses and the links between files, and nothing else.
The cross-repository check reads that repository from the hub's side, when the other repositories call the hub.
The reasons are in [docs/decisions.md](./docs/decisions.md) (in Japanese).

## Checks

```
node verification/check.js                          # safeguards, list, template, prose
node verification/check.js --break                  # break the checks one at a time
node verification/check.js --repos <clones>          # also the list against each repository's CI, and the canonical copies
GITHUB_REPOSITORY=<owner>/<name> node tools/common.js <clones>   # copies, scan, links
```

## Security and errors

Security issues are received by the route in [SECURITY.md](./SECURITY.md).
Errors are received by the [error report](https://github.com/cpsbvbng26-dotcom/verification-hub/issues/new?template=error-report.yml) form.

## Use of a language model

The pages and the code of this repository were written by Claude Code (Anthropic), at the operator's request.
Claude is not an author.

## Licences

Text is under [CC BY 4.0](./LICENSE), and code under [MIT](./LICENSE-CODE).
