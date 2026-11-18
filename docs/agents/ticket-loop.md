# Ticket loop config

## Tickets

- GitHub issues in `jhnhnsn/xbmg`.
- A parent is an issue with sub-issues, or a milestone.
- A blocker is a line `Blocked by #n` in the issue body.
- Labels: `ready-for-agent`, `ready-for-human`.
- Record a user's decision as a comment on the ticket: `gh issue comment <n> --repo jhnhnsn/xbmg --body-file <file>`.

Read a ticket: `gh issue view <n> --repo jhnhnsn/xbmg --json title,body,labels,comments`.

## Order

Named tickets in the order given. Under a parent, ticket number order.

## Checks

`npm test` (node:test, no dependencies). The exit code is the verdict.

## Test queue

- **TUI:** run `node bin/xbmg.js --demo` in a pseudo-terminal (`python3` pty or `expect`), send keys, read the screen text. Size the terminal explicitly (for example 120×40).
- **CLI:** run `node bin/xbmg.js <command>` and check the output and exit code.
- **Install script:** run `install.sh` with a temporary `HOME` in the scratchpad, then run `xbmg --help` through the new symlink. `shellcheck install.sh` must pass.
- **Homebrew formula:** `brew install --build-from-source jhnhnsn/tap/xbmg`, `brew test xbmg`, `brew audit --strict --online xbmg`. Undo afterwards: `brew uninstall xbmg`, `brew untap jhnhnsn/tap`.

Test hooks:
- `--demo`: made-up captures, no sign-in, no network.
- `XBMG_IMAGES=kitty|iterm|none`: force the image protocol.
- `XBMG_VIDEO_WIDTH`: inline video width.
- `XBMG_CLIENT_ID` / `--client-id`: override the app registration.

A test plan records each command, its exit code, and the output that shows the result.

## Reference

No upstream or spec. The ticket body is the reference. When a ticket and the README disagree, ask the user.

## Ship

- Each ticket ships on its own: `git push origin main`.
- No publish command (npm publishing is #1, done by hand).
- The loop may create the `v0.1.0` tag and GitHub release (`git tag v0.1.0`, `git push origin v0.1.0`, `gh release create v0.1.0 --repo jhnhnsn/xbmg --generate-notes`), and may create the public repo `jhnhnsn/homebrew-tap` and push to it.

## Changelog

- `CHANGELOG.md`, section `## Unreleased`, newest entry first.
- Readers: users of xbmg.
- An entry says what a user can now do (or what changed), in one or two lines, and links the issue (`([#2](https://github.com/jhnhnsn/xbmg/issues/2))`).
- No milestones yet: no milestone summary, no list of milestones to come.

## Stops

Besides the built-in stops, stop before:
- any `npm publish`;
- deleting a repo, tag or release;
- anything that needs a secret or a sign-in that is not on this computer.

## Models

Coordinator: Opus, medium effort.
Researcher: Haiku, usual effort.
Implementer: Opus, low effort.
Standards reviewer: Sonnet, usual effort.
Spec reviewer: Opus, high effort.

## Commits

- Subject: short, imperative. Body: what changed, wrapped at about 72 columns.
- Last line: `Closes #<n>`.
- No `Co-Authored-By` or other attribution lines.
- Author email: the noreply address in the repo-local git config. Never another address.
- One commit per ticket, plus one fix commit after review if needed.

## Concurrency

One at a time.

## Daily cap

Rolling: 14.3% of the plan's weekly usage per day.

## Ticket budget

4

## Status line

Added.
