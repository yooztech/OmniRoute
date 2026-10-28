# OmniRoute PR and Coverage Instructions

- Treat `npm run test:coverage` as a required gate for PR work.
- The repository minimum is `60%` for statements, lines, functions, and branches.
- If a PR changes production code in `src/`, `open-sse/`, `electron/`, or `bin/`, it must include automated tests in the same PR.
- When reviewing or updating a PR, if the report shows missing tests or coverage below `60%`, do not stop after reporting the problem. Add or update tests in the PR first, rerun the coverage gate, and only then ask for confirmation.
- Prefer the smallest test layer that proves the behavior:
  - unit tests first
  - integration tests when multiple modules or DB state are involved
  - e2e only when the behavior is truly UI or workflow-dependent
- For bug issues, try to encode the reproduction as an automated test before or alongside the fix.
- In the final PR report, include:
  - the commands you ran
  - the changed test files
  - the final coverage result

## Standalone downstream patch scope

- Authoring a numbered downstream patch is not, by itself, PR work. Do not automatically apply the PR-wide coverage gate to a standalone patch task. The PR requirements above remain unchanged for explicitly requested PR work.
- Before changing code, state the patch's single objective and planned verification scope. Default to the patch's regression tests, directly affected module tests, patch application, and a focused behavioral smoke run.
- Patch-scoped verification is mandatory, not optional. A behavior-changing patch must include automated regression tests in the same patch and register both regression and directly related module tests in `downstream/patches/tests.json`.
- Tests must prove the intended behavior and plausible failure/security boundaries, not source text or mock forwarding alone. For a bug fix, demonstrate the regression fails before and passes after where practical; also exercise the changed behavior in a focused runtime smoke run.
- Run all registered commands for the resulting patch queue and verify clean, ordered application to the pinned baseline. A failure caused by the patch must be fixed within scope before delivery. Do not label a failure unrelated without evidence; if attribution is unresolved, report the verification blocker rather than silently skipping it.
- Do not start `test:coverage`, `test:all`, or another full-project suite for standalone patch work without explicit user authorization. Do not restart an expanded suite after cancellation without authorization.
- A patch may contain only changes necessary for its stated objective: implementation, affected callers, regression tests, and directly related documentation. Never bundle unrelated upstream fixes, refactors, dependency changes, or cleanup.
- Unrelated upstream test failures or coverage deficiencies are report-only findings for standalone patch work. Do not fix them, weaken assertions, skip tests, or change thresholds to make the patch appear green. Ask before expanding the objective.
- Before exporting, review every changed file and hunk against the objective; remove unrelated changes. Keep downstream tooling and instruction changes outside the application patch.
- Report exactly what ran, passed, failed, or was cancelled. An unfinished or cancelled coverage run is not a passing coverage result.
