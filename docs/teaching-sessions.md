# Teaching sessions v0

Teaching sessions are ordinary terminal Pi conversations with Git checkpoints
and explained rollback. They are separate from executable Trains: a teaching
session captures human-guided work, while a train executes a declared
workflow.

## Start and prompt normally

Load the Trains package or both extensions, then start Pi in a clean checkout:

```bash
pi -e /path/to/trains/extensions/train-runner.js \
   -e /path/to/trains/extensions/teaching-session.js
```

Run `/teach-start`. The extension records the current commit and named branch,
creates `teach/<session-id>`, and stores its durable record under Git's common
directory in `teaching-sessions/`. Metadata is outside the checkout and is not
sent to the model.

Continue with ordinary prompts. When Pi's complete agent run settles, the
extension inspects the working tree. A code-producing prompt gets one unsigned
commit and a push. The first such push creates one draft GitHub pull request;
later prompts reuse it. A read-only prompt records its Pi boundary without an
empty commit or pull request.

Useful commands:

- `/teach-status` shows the session branch, prompt mappings, publication state,
  pull request, rollback records, and any recovery operation.
- `/teach-rollback` opens a prompt picker and then a required explanation
  editor. A cancelled or blank explanation changes nothing.
- `/teach-resume-publication` retries an interrupted commit/push/PR or rollback
  operation from its journaled stage.
- `/teach-end` ends a clean, fully settled session while leaving its branches,
  pull request, session file, and evidence available.

## Rollback behavior

Selecting a completed prompt means “return to immediately before this prompt.”
The extension first preserves the abandoned tip on a unique remote backup branch
(`teach/backup-...`) and records the exact explanation and Pi entry references.
It then restores the session branch with an explicit force-with-lease, navigates
Pi to the selected user entry with summaries disabled, and puts the original
prompt back in the editor. The abandoned conversation remains in Pi's append-
only session tree but is not on the active context path.

The rewritten prompt is recorded as a new prompt linked to the rolled-back
prompt's boundary. It creates a new commit on the same session branch and the
same draft pull request. Native `/tree`, `/fork`, and `/clone` navigation is
blocked during an active teaching session so it cannot bypass the explanation
and Git restore contract. Teaching and executable train runs are mutually
exclusive in one Pi session.

## Lifecycle boundary and recovery

The supported Pi runtime emits `agent_end` with `willRetry`; the extension
publishes only after the final event. It also handles `agent_settled` when that
event is emitted. A worker-created commit is treated as an unexpected
publication boundary and blocks rather than being silently remapped.

Commit, push, pull-request, backup, reset, and conversation-navigation stages
are journaled. If a non-atomic stage fails, the record retains the evidence and
`/teach-resume-publication` continues from the recorded stage. A remote session
branch change stops rollback before force-pushing it.

The controller is independently testable against temporary Git repositories and
bare remotes. Live trial transcripts, prompts, diffs, and pull requests belong
in a private trial directory/repository, not in this public Trains repository.
