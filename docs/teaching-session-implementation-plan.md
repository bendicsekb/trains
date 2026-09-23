# Teaching session v0: implementation and testing plan

Status: implemented and verified on branch `teach-session-v0`. Deterministic tests pass, and the live private Pi trial completed the read-only, publication, PR reuse, explained rollback, backup preservation, rewrite, and restart-recovery paths. The private trial report records exact hashes, terminal evidence, and the one trial-discovered prompt-mapping defect that was fixed before the final rewrite/recovery run.

Scope: [agreed design](./teaching-session-design.md). Idea: https://github.com/bendicsekb/ideas/issues/11.

## Outcome

Use terminal Pi to solve a small feature one prompt at a time. Every code-producing prompt gets a new unsigned commit and push on one session branch and draft PR. After a prompt finishes, the navigator can explain a failure, preserve the attempt, rewind conversation and code, and rewrite an earlier prompt without carrying the abandoned context forward.

No activity observer, custom activity view, workflow extraction, workflow iteration, or backtesting. The live trial below tests this product; it does not implement a workflow replay engine.

## Example: three successful prompts, then a rollback

The navigator is adding search to a notes app. Commands below are proposed interfaces, not claims that the implementation already exists.

Launch Pi in the repository and run `/teach-start`. The extension records the starting commit and creates the session branch. Continue prompting Pi normally.

| Prompt | Navigator's instruction | Result after Pi finishes |
| --- | --- | --- |
| 1 | Add a search field above the notes list. Filter by title as I type. | Unsigned commit A is pushed; the session's draft PR is opened. Review passes. |
| 2 | Also search the note body, case-insensitively. | Unsigned commit B is pushed to the same PR. Review passes. |
| 3 | Add a clear button and an empty-results message. | Unsigned commit C is pushed to the same PR. Review passes. |
| 4 | Highlight matching text in the results. | Unsigned commit D is pushed. Review discovers that Pi replaced the note renderer and broke links. |

Enter `/teach-rollback` and select prompt 4, “Highlight matching text in the results.” Selecting a prompt means returning to immediately **before** that prompt.

The extension requires an explanation. The navigator writes:

> You replaced the existing renderer and broke links. I wanted highlighting added while preserving the current rendering behavior.

After the explanation is submitted, the extension:

1. Creates and pushes a backup branch pointing to D, preserving the failed code.
2. Records the exact explanation, abandoned conversation references, and backup branch with the session.
3. Resets the session branch to C and force-pushes it with the expected remote SHA lease. The same draft PR now shows the three successful changes.
4. Restores Pi's conversation to before prompt 4, with no abandoned-attempt messages or branch summary.
5. Places the original prompt in the editor for rewriting.

The navigator changes the prompt to:

> Highlight matching text using the existing note renderer. Preserve links and formatting. First inspect how the renderer works, then add highlighting without replacing it.

Pi receives the earlier successful conversation plus this rewritten prompt. It receives neither the failed attempt nor the rollback explanation. When Pi finishes, unsigned commit E is pushed to the same draft PR.

```text
Current session branch: start → A → B → C → E
Preserved backup:       start → A → B → C → D
```

The failed code at D, its conversation, and the explanation remain inspectable. The session records the relationship between the original and rewritten prompts.

Selecting prompt 2 instead would restore code to A and remove prompts 2–4 and their results from Pi's active context, while preserving the entire abandoned path. Rollback can therefore discard multiple completed prompts, not only the most recent one.

Use this example as a user-facing acceptance walkthrough alongside the smaller private-repo CLI trial below.

## Implementation sequence

### 1. Establish the Pi and Git boundaries

- Add a teaching-session extension alongside the existing train runner. Keep teaching and train execution mutually exclusive within a session; leave the existing train state machine unchanged.
- Proposed commands: `/teach-start`, `/teach-status`, `/teach-rollback`, `/teach-resume-publication`, and `/teach-end`. These names may be simplified during implementation without changing behavior.
- Begin from a clean working tree and a recorded commit. Use a dedicated session branch and durable session identifier. Do not include unrelated working changes.
- Map each submitted user prompt to its Pi entry ID, parent context boundary, and pre-prompt Git commit. A prompt may contain many model/tool turns; it produces only one publication boundary after the full agent run settles.
- Verify the installed Pi lifecycle hooks before choosing the adapter. `agent_settled` means retries and automatic continuations are finished; a tool result or low-level `agent_end` alone is insufficient.
- Keep control commands and failure explanations out of ordinary agent messages. Do not queue multiple teaching prompts while Pi is working.

### 2. Persist the session record

- Implement a small testable session controller, durable storage, and Git/GitHub adapter behind the extension.
- Store starting commit, session branch, PR identity, prompt boundaries, publication results, rollback explanations, backup branch names and commit IDs, Pi session/entry references, and operation recovery state.
- Preserve explanation wording exactly. Identify original and rewritten prompts through their common rollback boundary.
- Keep metadata outside the code checkout and model prompt inputs, for example under a session directory in Git's common directory. Pi custom entries may hold controller metadata but must not become agent context.
- Retain Pi session files and abandoned conversation paths durably. Reloading the extension or restarting Pi must not lose checkpoints or feedback.
- Do not put private trial transcripts, prompts, or diffs in the public Trains repo. Use synthetic fixtures for public tests and private storage for live evidence.

### 3. Publish each code-producing prompt

- Detect repository changes when Pi settles, including newly created non-ignored files. Commit the session's scoped changes with signing disabled for that command, then push the session branch.
- Create a draft PR on the first publishable change. Reuse its identity for every later prompt, rollback, and corrected attempt.
- Read-only prompts record a conversation boundary but produce no empty commit.
- The controller owns publication; tell the worker to leave commit, push, and PR actions to it. Detect unexpected worker-created commits rather than silently losing the prompt-to-commit mapping.
- Record the local commit before pushing. If push or PR creation fails, expose an explicit recoverable state. Retrying must reuse the same commit/PR rather than duplicating them.
- Do not present a prompt as fully published, or accept a dependent rollback, while publication is unresolved.

### 4. Implement explained rollback

- Permit rollback only after the submitted prompt has finished and publication has resolved. Let the navigator choose a completed prompt to rewrite.
- Require a nonblank explanation before any Git or conversation mutation. Cancellation preserves the current state.
- Persist the explanation and abandoned context references, create a unique backup branch at the abandoned tip, push it, and verify the remote backup before resetting the session branch.
- Record the backup branch beside the session branch in the session record. Keep the same draft PR.
- Restore the exact pre-prompt code checkpoint and force-push the session branch with an explicit expected remote SHA lease. A concurrent remote change must stop the operation instead of overwriting unexpected work.
- Navigate to the conversation before the selected prompt without generating a branch summary; put the original prompt in the editor for rewriting. Use supported Pi context/navigation APIs so the model context is actually rebuilt.
- Confirm that abandoned tool results, assistant messages, feedback, and later compaction summaries do not enter the rebuilt context. Preserve earlier legitimate context.
- Guard native tree/fork navigation during teaching so it cannot bypass the explanation and code restore contract.
- Journal stages because local reset, remote push, and context navigation are not atomic. If any stage fails, retain the backup and show an actionable incomplete operation; resume deterministically before another agent prompt runs.

### 5. Package and document

- Register the extension in the Pi package; document startup, normal prompting, PR review, rollback, resumption, and where the retained evidence lives.
- Keep the implementation modular enough to test with temporary Git repositories and a fake Pi context.
- Update the agreed design only where implementation clarifies mechanics; preserve the settled v0 boundary.
- After verification, update the Product Controller with the actual capability and evidence using the maintain-product-controller skill. Do not describe the planned capability as working before the live trial passes.

## Automated testing

Use the existing Node test runner. Test actual Git behavior against temporary working repositories and bare remotes; use a fake GitHub adapter for error cases and real GitHub for the live trial.

| Behavior | Independent assertion |
| --- | --- |
| Start | Recorded base commit matches the clean checkout; dirty/unrelated changes are rejected without modification. |
| Prompt boundary | Several tool/model turns result in one checkpoint and one post-settlement publication. |
| Read-only prompt | HEAD and remote remain unchanged; prompt still has a valid rollback boundary. |
| Code publication | New commit contains the expected diff, has no signature, and equals the remote session tip. |
| Repeated publication | A second prompt creates a distinct commit on the same branch and PR. |
| Required explanation | Empty, whitespace-only, and cancelled input do not move conversation, HEAD, or remote refs. |
| Busy state | Rollback does not abort or rewind an executing prompt. |
| Preserve attempt | Backup local/remote refs resolve to the abandoned tip; transcript references and exact reason survive reload. |
| Restore code | HEAD and remote equal the selected pre-prompt commit; files added or removed by the abandoned attempt are restored correctly. |
| Restore conversation | Assembled Pi context retains pre-boundary content but excludes synthetic abandoned-message, tool-result, criticism, and compaction markers. |
| Rewrite | Selected prompt returns to the editor and its edited successor records the correct parent boundary. |
| PR continuity | Publication, rollback, and retry do not create a second draft PR. |
| Error recovery | Commit/push/PR/backup/navigation failures and restart at rollback stages cannot silently lose evidence or double-publish. |
| Remote conflict | Force-with-lease refuses an unexpected remote tip and retains recoverable local state. |
| Native navigation | Tree/fork shortcuts cannot perform an unrecorded rollback. |
| Existing functionality | All existing Trains parser and native-runner tests still pass. |

## Live trial: one feature in a private repo

Use `bendicsekb/agentic-engineering`, verified private during planning. Trains itself is public. The existing agentic-engineering checkout has unrelated edits, so use a separate clean worktree from its remote base. Do not alter the original checkout or merge the trial into main.

Create a disposable fixture branch containing a tiny dependency-free Node CLI under `experiments/pi-teaching-trial/`. The session branch and single draft PR target that fixture branch, keeping the review focused on the feature. Inspect repository instructions and CI triggers before pushing. Keep all remote mutations to these uniquely named trial branches and PR.

Feature: convert a title into a URL slug. Example: `Hello World` becomes `hello-world`. No network dependencies or deployment required.

1. **Prepare:** create and commit the baseline fixture and its independent acceptance checks. Record the base hash. Launch the actual installed Pi CLI with the teaching extension and an authenticated model; record exact runtime/model settings.
2. **Read-only prompt:** ask Pi to inspect the fixture and explain where the feature belongs. Verify no commit and no premature PR.
3. **First code prompt:** ask for a basic lowercase-and-space-replacement implementation. Wait for Pi to settle. Verify one new unsigned commit, remote equality, and one draft PR.
4. **Second code prompt:** ask for another bounded part of the same feature, such as its CLI usage example. Verify a second new commit and the same draft PR.
5. **Review the flaw:** independently demonstrate that repeated whitespace or punctuation produces an unsuitable slug. Record the real output. This is a deliberately limited first specification, not an unexpected model failure.
6. **Reject blank explanation:** invoke rollback to the first code prompt with empty/whitespace feedback. Verify every relevant ref and context boundary stays unchanged.
7. **Explain and roll back:** write a reason describing the observed punctuation/whitespace issue. Verify the backup branch is pushed at the abandoned tip, the session branch and PR head return to the pre-feature checkpoint, and both abandoned code commits remain reachable from the backup.
8. **Check context:** inspect the actual assembled Pi context at the restored boundary. A synthetic marker included only in the abandoned path and a different marker in the rollback explanation must be absent. Do not rely only on asking the model whether it remembers them.
9. **Rewrite:** change the original prompt to require lowercasing, trimming, collapsing separator runs, and removing punctuation. Run Pi again. Verify a new unsigned commit and push to the same PR, and run independent CLI acceptance checks.
10. **Resume:** restart Pi/the extension and verify session identity, prompt mappings, PR, backup branch, and exact explanation remain accessible. Do not inject abandoned evidence into the worker context during restoration.
11. **Review evidence:** inspect the final GitHub diff, PR draft state and head, remote backup, retained failed code, and successful CLI outputs. Keep the PR and backup for user review; leave the trial unmerged.

Exercise terminal menus/editor restoration in a real PTY. A scripted RPC driver can repeat lower-level checks, but must not replace verification of the terminal interaction the user will use.

## How Codex will drive Pi, observe the experience, and adjust it

Codex acts as the navigator and independent reviewer; the real Pi agent writes the trial feature. Codex implements and fixes the teaching extension in Trains, but does not quietly repair Pi's feature code or perform the extension's commits, backups, or rollback on its behalf. Such a workaround would hide the behavior being tested.

### Driver setup

- Launch the installed Pi CLI through `exec_command` with a live PTY, the teaching extension, the private fixture worktree as its working directory, and the configured authenticated provider/model. Record the exact launch command and versions.
- Retain the terminal process identifier. Use `write_stdin` to enter normal prompts and slash commands and to operate the actual picker and editor. Resolve actual key bindings from the installed Pi interface instead of guessing them.
- Drive one prompt at a time. Observe Pi until the agent settles and publication finishes; do not use a fixed delay as proof of completion. Investigate a bounded stall and retain the output if progress stops.
- Run independent Git, GitHub, and feature checks in separate shell calls against the same worktree. Use read-only observation of the session record and Pi context for verification; do not use internal controller methods as a substitute for the terminal actions.
- Save trial artifacts outside the checkout/model inputs in a private run directory with numbered attempts. Keep raw terminal output, Pi session references, command results, and a concise human-readable journal. Distinguish observations from interpretations.

### Expanded example: three accepted prompts, then a rejected change

This is the primary user-experience rehearsal. It expands the smaller slug trial above to exercise the same shape as the notes-app walkthrough: three reviewed changes survive a rollback of the fourth.

The fixture starts with a minimal Node CLI skeleton. Use the following prompts, adapting only the fixture path and entry-point name. Keep the exact submitted versions in the trial record.

| Action driven by Codex | Example input | What Codex verifies before continuing |
| --- | --- | --- |
| Start | `/teach-start` | Base hash and session branch recorded; no change to the original checkout. |
| Inspect | “Inspect this CLI fixture and explain where slug formatting belongs. Do not change files.” | No commit, no push of code, and no draft PR created prematurely. |
| Prompt 1 | “Implement title-to-slug conversion: lowercase the input and replace runs of spaces with one hyphen. Add focused tests.” | `Hello World` becomes `hello-world`; commit A is unsigned and pushed; one draft PR exists. |
| Prompt 2 | “Add a --separator option, defaulting to a hyphen. Keep the existing behavior and add a test for underscores.” | Default behavior still works, custom separator works; new commit B and same PR. |
| Prompt 3 | “When no title argument is supplied, read the title from stdin. Keep command-line input working and add tests.” | Both input paths work; new commit C and same PR. |
| Prompt 4 | “Before slug formatting, strip all characters except ASCII letters and whitespace. Keep the existing CLI options.” | New commit D is pushed. Review `Release 2026` and show whether digits are lost. |
| Review | Run independent acceptance checks and inspect the actual PR diff. | Record the observed output and whether the requested simplification is unsuitable. Do not claim Pi failed the literal prompt: this is a navigator correction. |
| Invalid rollback | `/teach-rollback`, select prompt 4, submit blank/whitespace explanation; also exercise cancel. | No HEAD, remote ref, or context movement. The terminal clearly says an explanation is required. |
| Valid rollback | Select prompt 4 and write: “The requested filter loses digits from titles such as Release 2026. Preserve digits and remove punctuation instead; keep separators and stdin behavior.” | Backup is pushed at D; exact reason and old conversation retained; session branch and same PR return to C. |
| Rewrite | Edit restored prompt to: “Remove punctuation while preserving ASCII letters, digits, and whitespace. Keep --separator and stdin support. Add a Release 2026 test.” | Rebuilt context contains successful prior prompts but no abandoned prompt/results or explanation. New unsigned commit E is pushed to the existing PR. |
| Review again | Test `Release 2026`, punctuation, repeated spaces, custom separator, and stdin. | Expected outputs pass; A/B/C behavior remains intact; backup still exposes D. |
| Resume | Exit cleanly, relaunch Pi, and resume the teaching session. | Same PR/branch and usable prompt history; retained exact reason and backup; no abandoned context reintroduced. |

If Pi asks a clarifying question, record it and answer in the navigator role; that answer is part of the actual trace. If it avoids the anticipated flaw, do not invent a failure. Inspect the real behavior and choose another explicit, documented requirement correction that exercises rollback.

After this path passes, exercise a deeper rollback to prompt 2 in the same disposable session. Verify code returns to A, later prompts are absent from the active context, the complete previous tip is preserved on a second unique remote backup, and the PR identity remains unchanged. Rewrite prompt 2, let Pi complete it, and verify another publication works. Leave the final PR description clear about the final demonstrated feature state.

### Evidence after every interaction

Codex records:

- The navigator input and what Pi actually displayed, including errors, clarification requests, and publication status.
- Before/after local HEAD and remote session SHA; commit signature absence and diff; PR number, draft state, and head SHA when a PR exists.
- Prompt entry and pre-prompt commit mapping, plus backup ref and exact explanation for a rollback.
- Independent acceptance command, exit code, and output. A model's “tests passed” message is not the result.
- For context restoration, the actual assembled message list or a test-only capture at the provider-input boundary with synthetic markers. If the installed runtime cannot expose this reliably, mark that check unknown and implement a verifiable probe before declaring context restoration passed.
- Any manual intervention, ambiguity, unexpected wait, misleading status, or extra action needed to complete the intended interaction.

### What needs adjusting: review questions

After each completed prompt and rollback, Codex assesses both correctness and friction:

- Can the navigator tell Pi has finished and the code is available on GitHub?
- Can they select the intended prompt without interpreting internal identifiers?
- Is “return to before this prompt” unambiguous, including when several later prompts will be abandoned?
- Does blank feedback get rejected without losing the selected prompt or moving anything?
- Is the original prompt conveniently editable, and is the failed attempt easy to find afterward?
- Are the same PR and backup references visible when needed, including after restart?
- Does the extension interfere with ordinary Pi prompting or expose its own bookkeeping as conversation content?

These are observations from a Codex-operated trial, not evidence of human usability satisfaction. Report that limit explicitly.

### Fix-and-retest loop

1. When a check fails or the interaction is awkward, preserve the numbered attempt and write a short finding: expected behavior, actual behavior, evidence, likely cause, and proposed smallest adjustment.
2. Classify it as teaching-extension behavior, Pi integration, Git/GitHub publication, environment/provider access, or feature-prompt behavior. Do not conflate an intentionally inadequate feature request with a rollback-system defect.
3. Reproduce the issue deterministically where possible. Add a meaningful regression test for state loss, context leakage, duplicate publication, or broken recovery before fixing it.
4. Fix authorized implementation mechanics in Trains, run affected tests, and retry the failed interaction from a known boundary. Keep failed evidence and label the new attempt; do not overwrite the first report.
5. Re-run the complete successful terminal path after the final fix, including PR publication, rejected blank feedback, backup preservation, clean-context rewrite, and restart. A passing isolated test is insufficient for the finished experience.
6. Continue until the v0 acceptance checks pass or there is a concrete external blocker. For a blocker, report the exact boundary and retained evidence rather than fabricating a pass. Bring product-scope changes back to the user; make routine implementation fixes autonomously.

The final report includes a feature-by-feature result table, links to the single trial PR and backup branches, the concrete adjustments made after observation, and remaining limitations. Keep the trial branches and draft PR for review; do not merge or delete the failed attempts.

## Evidence and completion

Produce a concise private trial report mapping each v0 behavior to pass/fail/unknown, with PR link, base/session/backup hashes, exact commands and verification outputs, transcript references, failure explanation, and original/rewritten prompt references. A Pi success message or clean exit is not acceptance evidence.

Completion requires passing deterministic tests, a successful real Pi terminal walkthrough, independently verified GitHub state, preserved failed evidence, demonstrated context rollback, accurate usage docs, and an updated Product Controller. Report any limitation explicitly rather than treating it as a pass.
