# Teaching session v0 implementation record

Status: implemented on branch `teach-session-v0` and verified by deterministic
tests plus a private real-Pi terminal trial.

## Delivered

- `src/teaching-session.mjs` provides the testable controller, Git adapter,
  GitHub draft-PR adapter, durable session store, publication journal, and
  explained rollback.
- `extensions/teaching-session.js` provides `/teach-start`, `/teach-status`,
  `/teach-rollback`, `/teach-resume-publication`, and `/teach-end`.
- Each settled code-producing prompt creates one unsigned commit and pushes it
  to `teach/<session-id>`. Read-only prompts create boundaries without empty
  commits or pull requests.
- One draft pull request is reused across publication, rollback, and rewrite.
- Rollback preserves the failed tip and exact explanation on a pushed backup
  branch, restores code with force-with-lease, rebuilds Pi's active context
  without summaries, and pre-fills the original prompt.
- Incomplete publication and rollback stages remain resumable. Native tree,
  fork, and clone navigation are blocked while teaching is active, and
  executable train runs are mutually exclusive with teaching sessions.
- Session metadata lives under Git's common directory, outside the checkout
  and model prompt inputs.

## Verification

Local checks:

```text
node --check src/teaching-session.mjs
node --check extensions/teaching-session.js
npm test                  # 19/19 passing
```

The automated suite covers clean-start validation, prompt-boundary timing,
read-only prompts, unsigned publication, duplicate prompt text, PR reuse,
blank and busy rollback protection, backup preservation, conversation restore,
rewrite linkage, unexpected worker commits, remote conflicts, restart
recovery, failed-push recovery, and extension registration.

The private terminal trial used the installed Pi CLI in a clean fixture
worktree. It independently verified read-only inspection, repeated unsigned
publication, same-PR reuse, blank and cancelled rollback input, explained
rollback, pushed backup branches, clean prompt rewrite, CLI behavior, and
fresh-process session recovery. The draft trial PR and backup branches remain
open and unmerged. Raw terminal logs and the exact session report are kept
outside this public repository at:

`/home/bendi/.pi/teaching-trials/20260923-teaching-v0/report.md`

## Trial-driven fixes

1. Pi persisted the current user entry after `before_agent_start`. Prompt
   entries are now resolved at settlement when the persisted entry exists.
2. Duplicate prompt text initially selected an already-assigned Pi entry.
   Matching now excludes assigned entry IDs and selects the fresh persisted
   entry.
3. The terminal editor's Ctrl+U line-kill binding was used to replace a
   prefilled prompt exactly; the final live rewrite is recorded without
   duplicated instructions.

## Scope

Teaching sessions capture human-guided work. They do not add an activity
observer, workflow extraction, workflow replay, or backtesting surface. The
deterministic suite covers remote conflicts and interrupted publication; the
private trial did not inject those failures or perform a deep rollback to an
earlier successful prompt.

## Implementation commits

- `3e4e557` Add teaching session controller and Pi extension
- `c67de95` Test teaching publication and rollback boundaries
- `1d62124` Keep teaching and train sessions mutually exclusive
- `471be73` Resolve Pi prompt entries at settlement
- `f1e2622` Resolve duplicate teaching prompts to fresh Pi entries
- `fe064e2` Mark teaching session plan as verified
