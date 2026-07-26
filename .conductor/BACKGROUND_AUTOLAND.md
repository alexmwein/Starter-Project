# Background autoland

Conductor chats publish work without waiting for CI, deployments, or merge
serialization. GitHub stores the queue and finishes the landing independently
of the originating chat or Mac.

```text
chat/worktree
    |
    | conductor-land
    | commit -> exact push -> pull request -> conductor-autoland label
    v
GitHub queue (oldest eligible pull request per repository)
    |
    | merge current main into the feature branch
    | required checks rerun on the combined commit
    | squash auto-merge
    v
canonical main -> remote branch deletion -> Conductor workspace archive
```

## Normal use

Run `conductor-land` after local tests pass. A successful asynchronous handoff
looks like:

```text
conductor-land: QUEUED https://github.com/OWNER/REPO/pull/123
```

The command has already verified that GitHub holds the exact local commit.
Return control to the user at that point. Use `conductor-land --wait` only when
the user explicitly asks the chat to remain attached until the merge is
verified.

## Queue behavior

- Only open, non-draft, same-repository pull requests with the
  `conductor-autoland` label are eligible.
- The oldest eligible pull request is processed first.
- A distinct write-enabled deploy key updates each repository. No personal
  GitHub token is stored in Actions.
- The worker creates a two-parent merge commit with the feature head as its
  first parent and the current default branch as its second parent.
- An exact SHA lease prevents the worker from overwriting a concurrently changed
  feature branch.
- Strict branch protection and required checks validate the combined state
  before GitHub squash-merges.
- A main-branch push advances the next queue item. Pull-request, check, status,
  manual-dispatch, and scheduled events provide redundant wakeups.

## Fail-closed cases

The worker removes a failed item from the active queue, adds
`conductor-blocked`, and comments once when:

- the branch conflicts with the current default branch;
- a required check fails or is cancelled;
- the repo-scoped deploy key is missing or invalid; or
- the pull request changes `.github/workflows/**`, `.github/actions/**`, or
  `.github/CODEOWNERS`.

Trusted automation changes require manual review and manual merge. For other
blocked pull requests, resolve the problem and run `conductor-land` again.

## Adding another repository

Before chats can truthfully report `QUEUED` for a new repository:

1. Add `.github/workflows/conductor-autoland.yml` to its default branch through
   a manually reviewed bootstrap pull request.
2. Generate a unique Ed25519 deploy key for that repository.
3. Add the public key as a write-enabled deploy key named
   `Conductor Autoland`.
4. Store the private key as the Actions secret
   `CONDUCTOR_AUTOLAND_DEPLOY_KEY`.
5. Enable squash merging, auto-merge, automatic head-branch deletion, pull
   request protection, strict up-to-date required checks, and protection
   against force pushes to the default branch.
6. Create the `conductor-autoland` and `conductor-blocked` labels.

Never reuse one deploy key across repositories, and never replace it with a
broad personal access token.
