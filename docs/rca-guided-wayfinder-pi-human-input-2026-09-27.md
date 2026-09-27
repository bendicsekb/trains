# RCA: guided Wayfinder Pi recovery incident

Date: 2026-09-27  
Run: `train-1790537624115` / `guided-wayfinder`  
Pi: `0.87.1`

## Summary

The train reached its human decision node correctly and persisted the user's
judgement. It then blocked while starting the next `assess` car because plain
text input was handled through a restricted Pi context that could not create a
new session.

The incident exposed four separate problems:

1. Human input advanced from the wrong Pi context.
2. The runner persisted a half-started car with no worker session, but had no
   recovery path for that state.
3. Installing a new extension did not reload the already-running Pi process.
4. `/train-resume` did not await its async handler, so validation errors became
   uncaught exceptions and terminated Pi.

The run ultimately recovered. The repaired `assess` car ran, rejected the
first judgement as insufficient, and returned the train to the teaching loop,
where it is waiting for the next human judgement as designed.

## Impact

- The judgement was not lost; it is present in the persisted `human_answer` and
  `car_handoff` history.
- `assess:i1:a2` never started a worker session.
- `/train-answer` could not help after the failure because the human node had
  already completed.
- Normal chat continued while the state machine was blocked, producing replies
  that sounded like progress even though no train transition occurred.
- Two recovery attempts crashed Pi before the correct session and extension
  were used.

## Timeline (UTC)

| Time | Event |
|---|---|
| 19:33:44 | `discover` started. |
| 19:34:21 | The first worker handoff used the wrong envelope: `summary`, `evidenceRefs`, and `claimsNotMade` were placed inside `outputs`. The car retried successfully. |
| 19:34:42–19:35:32 | `discover`, `explore`, and `teach` completed; the human node entered `waiting_human`. |
| 19:53:29 | Plain-text judgement was accepted and persisted. The next `assess` invocation was created with `sessionId: null`. |
| 19:53:29 | `newSession()` failed because the input context did not provide it. The run became `blocked`, with `handoffRecorded: false`. |
| 20:02–20:03 | “hey”, “ok let’s go”, and “what did we assess?” received ordinary model replies. These were not train transitions. |
| 20:14 | `e419242` fixed future plain-input advancement. |
| 20:15 | `c3dd750` added recovery for cars blocked before worker startup. |
| 20:16 | `/train-resume` ran in a process still loading `b0254cb`; Pi crashed on the old resume guard. |
| 20:19 | `/train-resume` ran with the newer code, but the command still allowed an async validation error to escape; Pi crashed again. |
| 20:20 | The correct session and extension were loaded. `assess:i1:a3` started in a fresh worker, handed off, and returned the train to `teach`/human review. |

## Root cause

The original input path was:

```text
plain text
  → pi.on("input")
  → acceptHumanInput()
  → drive()
  → startCar()
  → newSession()
```

Pi's `input` event supplies an `ExtensionContext`. It can persist state, but it
does not expose `newSession()`. `acceptHumanInput()` therefore accepted the
answer correctly, then tried to start `assess` using a context that could not
create the worker session.

The runner persisted the active invocation before calling `newSession()`. That
made the failure durable as:

```text
status: blocked
active.step: assess
active.sessionId: null
active.handoff: null
```

The persisted state was accurate, but the old runner had no operation that
reset this half-started invocation and retried it.

## Contributing failures

### Handoff contract was initially too easy to violate

The first `discover` worker put required top-level handoff metadata inside the
`outputs` object. The runner rejected it, but the retry path worked. This was a
transient contract-learning failure, not the cause of the later block.

### Runtime reload was mistaken for installation

`pi install /home/bendi/trains` updates the package registration and files; it
does not replace extension code already loaded in an open Pi process. The first
recovery stack pointed at line 572 from `b0254cb`, proving that the old process
was still running the pre-fix extension.

### Recovery state was session-bound and not made explicit

Train state is stored in Pi custom session entries. `/train-resume` depended on
the command running in the session containing the blocked train, but did not
restore or clearly display that state before validating it.

### Async command errors could crash Pi

The command handler called `machine.resume()` without `await`. When resume
rejected with `Train is not paused or blocked`, the rejection escaped the
handler and was recorded as an `uncaught_exception`.

### Conversation was not gated by train state

Once blocked, ordinary user messages still received ordinary assistant replies.
Those replies were not backed by persisted train transitions, but nothing in
the UI made that distinction obvious.

## Corrective changes already shipped

- `e419242` preserves a session-capable context and makes plain human input
  defer advancement through `/train-advance`.
- `c3dd750` resets a blocked invocation with no worker session and retries it
  through a fresh `newSession()`.
- Regression coverage now includes plain human input and pre-worker recovery;
  the repository suite passes `11/11`.
- The run was successfully recovered and reached the intended teach → human
  loop again.

Relevant implementation: [extensions/train-runner.js](../extensions/train-runner.js)

## Follow-up actions

1. Make `/train-resume` `await machine.resume()` and catch command errors,
   showing a notification instead of allowing Pi to terminate.
2. Restore state before every state-dependent command and show the active run,
   session, and loaded Trains revision in `/train-status`.
3. Add a fresh-process integration test: install/load the extension, restore a
   persisted blocked session, run `/train-resume`, and verify a new worker.
4. Make blocked state prominent and prevent ordinary replies from implying that
   the train advanced without a persisted transition.
5. Document the operational recovery sequence: restart Pi, reopen the exact
   session containing the run, verify `/train-status`, then run
   `/train-resume`.

## Evidence

- Original run: `/home/bendi/.pi/agent/sessions/--home-bendi--/2026-09-27T19-35-17-286Z_01a0e45d-5626-77f7-a586-d136d73de797.jsonl`
- Successful recovery: `/home/bendi/.pi/agent/sessions/--home-bendi--/2026-09-27T20-20-11-182Z_01a0e486-712e-72f6-9596-d23c125f5a70.jsonl`
- Pi crash registry: `/home/bendi/.pi/agent/crashes.json`
- Original implementation: commit `b0254cb`
- Plain-input fix: commit `e419242`
- Recovery fix: commit `c3dd750`
