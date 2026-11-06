# Claude Code workflow

Repository development instructions live in [AGENTS.md](AGENTS.md); follow them too.

## Model routing

- Every repo search goes to Haiku: use the `search` subagent to map the repo and the
  `grep` subagent to find call sites. Do not search the repo directly in the main thread.
- Every test run goes to Haiku: use the `tests` subagent. Do not run the suite directly.
- Call the `reviewer` subagent (Opus) at these points, passing it the plan or diff:
  1. Before a plan locks, to review the plan.
  2. After the same error occurs twice.
  3. Before declaring work done, to review the final diff.
- The reviewer's reply is `APPROVE` or `REJECT`. On `REJECT`, address the listed problems
  and call it again before proceeding.
