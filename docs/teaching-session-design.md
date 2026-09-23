# Teaching sessions

Status: implemented v0. This is the product contract for the Git-backed Pi
teaching session; operational use is documented in
[`teaching-sessions.md`](./teaching-sessions.md).

## Purpose

A teaching session lets a navigator guide Pi through ordinary prompts while
keeping each settled code change reviewable and recoverable. The navigator can
explain a failed attempt, restore the code and conversation to the selected
boundary, and rewrite the prompt without losing the abandoned evidence.

## Contract

- Start only from a clean, named Git branch. The extension creates
  `teach/<session-id>` and stores its record in Git's common directory.
- Record every prompt boundary, including read-only prompts. A settled prompt
  with code changes produces one unsigned commit and push.
- Create one draft pull request for the session's first code change and reuse
  it for subsequent changes and rewrites.
- Require a nonblank explanation before rollback. Preserve the exact text,
  abandoned Pi entries, and abandoned code on a pushed backup branch.
- Restore the session branch to immediately before the selected prompt using
  force-with-lease, then navigate Pi to that prompt's parent without a branch
  summary and prefill the original prompt for editing.
- Journal publication and rollback stages. An incomplete operation remains
  recoverable through `/teach-resume-publication`.
- Block native tree/fork/clone navigation and executable train runs while a
  teaching session is active.

## Scope

Teaching sessions capture human-guided work; executable Trains run declared
workflows. The teaching extension does not provide an activity observer,
workflow extraction, workflow replay, or backtesting surface.

The implementation is covered by the deterministic Trains suite and the
private real-Pi trial recorded in the implementation record.
