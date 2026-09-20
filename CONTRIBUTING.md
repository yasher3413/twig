# Contributing to twig

twig is early and moving fast, so the guidance here is intentionally
light. That will grow as the project stabilizes.

## Scope

Before opening a PR for a new feature, check the feature list in the
[README](README.md). Anything listed under "not in v1" (extensions,
built-in ad blocking, cross-device sync, non-macOS builds) is
explicitly out of scope for now — open an issue to discuss first
rather than sending a PR.

## Getting set up

```sh
npm install
npm run tauri dev
```

You'll need Rust (stable) and Node 18+. See the README for the full
prerequisites.

## Making changes

- Keep PRs focused — one logical change per PR is easier to review
  than a large one that bundles unrelated work.
- Follow [Conventional Commits](https://www.conventionalcommits.org/)
  style for commit messages (`feat:`, `fix:`, `chore:`, `docs:`,
  `refactor:`).
- Match the existing code style; run `npm run build` before pushing to
  catch TypeScript errors.
- If you're changing behavior around tab hibernation or webview
  lifecycle, explain the reasoning in the PR description — that's the
  most delicate part of the codebase.

## Reporting issues

Open a GitHub issue with steps to reproduce, what you expected, and
what actually happened. For memory/performance issues, include your
tab count and roughly how long the app had been running.
