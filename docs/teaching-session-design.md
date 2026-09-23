# Teaching sessions: design discussion

Status: v0 scope captured through the design discussion; implementation has not started.

Idea record: https://github.com/bendicsekb/ideas/issues/11

## Established intent

- Solve a real problem through ordinary prompt-by-prompt interaction with Pi, explaining the workflow while doing the work.
- Identify the starting code state by its Git commit hash.
- Return to earlier prompts while preserving failed attempts, their produced code, and the user's explanation of what went wrong.
- Use Pi's existing output to understand its work. A custom activity view, separate observer, and activity-level steering are excluded from v0.
- Later extract a workflow from the demonstrated process, iterate on it, and potentially replay the original problem.

## Settled decisions

- A rollback explanation is mandatory: the user writes what went wrong before rollback proceeds. Preserve the exact explanation with the abandoned attempt for later extraction.
- Rollback removes all abandoned-attempt context from the resumed conversation, including criticism and branch summaries. Return to the context before the selected prompt, then let the user rewrite that prompt. Preserve the abandoned conversation and criticism separately for later extraction; the changed prompt is useful signal.
- Pi runs in the terminal. The human is the navigator and Pi is the driver.
- Every code-producing prompt creates a new unsigned, throwaway commit and pushes it for GitHub review.
- Use one draft PR per session, backed by the session branch.
- On rollback, preserve the abandoned code on a backup branch and record that branch with the session branch. Then reset the session branch HEAD to the selected checkpoint and force-push it, keeping the same draft PR.
- Backup branches and the abandoned conversation remain available for later inspection and extraction.
- Rollback waits until Pi finishes the prompt so the user can inspect the output. Mid-execution rollback is outside v0.
- Do not add activity descriptions or an observer in v0; Pi already provides sufficient visibility. This supersedes the earlier observer design.
- Workflow extraction is outside v0, including an end-of-session extraction operation. Workflow iteration, executable replay, and backtesting are later work.

## Concrete v0 scenario

1. Start a terminal Pi teaching session from a known Git commit, with a session branch and one draft PR when code is available for review.
2. Give Pi a prompt and let it finish. If it produces code, create a new unsigned commit and push it to the session branch.
3. Review the output and draft PR.
4. If retrying, select an earlier prompt and write a required explanation of what went wrong. Blank feedback cannot proceed to rollback.
5. Preserve the abandoned conversation, explanation, and code on a backup branch associated with the session branch before resetting anything.
6. Reset the session branch to the code state before the selected prompt, force-push it, and restore the conversation to that same boundary without abandoned-attempt context or branch summaries.
7. Rewrite the selected prompt and continue. Later extraction can inspect both paths, the changed prompt, and the rollback explanation.

## Existing foundations

- The native runner in `extensions/train-runner.js` executes declared cars, records steering, and advances after a handoff. It does not currently provide the proposed teaching and rollback integration.
- Pi's installed session documentation describes append-only conversation trees, navigation to earlier prompts, and preservation of abandoned branches.
- The installed Pi extension documentation exposes session navigation hooks and tool execution events; a Git checkpoint example exists. These are foundations, not a completed integration.
- `scripts/run-semantic-workflow-backtest.mjs` explicitly performs observational trace evaluation, not executable replay.

## V0 scope boundary

V0 ends at captured terminal Pi sessions, GitHub review, and explained rollback with preserved attempts. It does not extract or execute a learned workflow.

The scope questions raised in this discussion are settled. Implementation mechanics remain to be designed within these boundaries.
