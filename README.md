# Trains

A small framework for turning recurring agent work and reasoning into explicit, composable workflows that can be executed more consistently.

The canonical conceptual and YAML contract is [docs/trains-spec.md](docs/trains-spec.md).

## Core concepts

### Train

A **train** is a reusable unit of work or reasoning.

A train is lean declarative YAML containing:

- an `id`;
- steps containing only `inputs`, `procedure`, and `outputs`.
- an optional `repeat` property on a car that invokes a looped procedure.

An input or output is either documented inline with `doc` or linked with `ref`. References imply dependencies, and output acceptance checks live on the output they validate. Outputs should be concrete results or references—such as a commit hash, report path, deployment URL, or test run—not generic workflow state. The working environment remains implicit unless a step needs an immutable handoff. The first unbound inputs and final outputs form the workflow interface, so it is not declared again at the top level. Runner choice, context isolation, retries, paths, provenance, evidence counts, lifecycle state, and backtest bookkeeping stay outside the train YAML.

A step must perform a meaningful transformation, verification, classification, or decision. Do not add a bookkeeping-only step to persist an existing result: when durability matters, require the producing output itself to be a concrete durable reference.

Repetition is control flow, not a step. A loop applies to one car; if several cars repeat together, put them in a nested train and repeat the invoking car. `repeat.inputs` explicitly feeds outputs into the next invocation, while `repeat.until` references a literal-boolean protocol stop predicate; semantic acceptance is verified separately.

### Handoff

A **handoff** is the explicit output of a train that another train can consume.

The existence of a clear handoff matters more than choosing one universal handoff format up front.

### Workflow

A **workflow** is a train composed of other trains.

Composition is recursive: a train may begin as one broad process and later be decomposed into smaller trains when that improves consistency.

## Refinement model

Trains are created progressively rather than by specifying every process in advance.

1. Describe a process at the highest useful level.
2. Run it.
3. Observe where execution is inconsistent or repeatedly requires human guidance.
4. Make that part explicit as a train, or refine an existing train.
5. Compose the refined train back into the larger workflow.

This is the main mechanism for **forcing a workflow**: recurring implicit reasoning is gradually converted into explicit, reusable process.

## First workflow: extract patterns from Codex sessions

The first workflow turns a set of previous Codex sessions into a candidate train, then tests and refines that train against sessions it did not learn from.

It has six stages:

1. **Identify sessions** — find relevant sessions, assign stable identifiers, record metadata, remove duplicates, and split the corpus into development, tuning, and holdout sets before interpreting the sessions.
2. **Extract a workflow** — turn repeated successful behavior into evidence-backed pattern cards: trigger, context, actions, decisions, handoffs, interventions, outcomes, and failure modes.
3. **Define it** — encode the candidate as a declarative train with explicit inputs, outputs, acceptance checks, safety constraints, and known exceptions.
4. **Backtest** — replay the candidate from each session's pre-execution context, without exposing the original future transcript, and compare it with a baseline.
5. **Compare and adjust** — classify misses, make the smallest justified change, and record the reason and expected effect.
6. **Loop** — return to backtest after every adjustment until the convergence gate passes; then run the frozen candidate once on the holdout set.

The canonical first workflow is [workflows/session-pattern-extraction.yaml](workflows/session-pattern-extraction.yaml). Its operating contract is [docs/session-pattern-extraction.md](docs/session-pattern-extraction.md). The deterministic corpus preflight is [scripts/build-session-corpus-index.mjs](scripts/build-session-corpus-index.mjs), followed by the bounded interest scan in [scripts/build-session-interest-index.mjs](scripts/build-session-interest-index.mjs). The Pi chain runner is [scripts/run-session-pattern-extraction-chain.mjs](scripts/run-session-pattern-extraction-chain.mjs).

When executed by Pi, every stage is a new `--no-session` RPC process. The stage's JSON handoff is the only context transferred to the next stage; the chain runner routes stages 4–6 back to backtest with a new context until the convergence handoff is terminal. After the chain terminates, it spawns one more fresh Pi context as a post-run analyst. That analyst reads only the completed chain's logs, handoffs, and artifacts, then writes an executive report covering topic, statistics, extracted workflow, new-versus-matched patterns, and convergence. A clean worker exit still means `needs_verification`, and the chain verifier must inspect the handoffs and artifacts independently.

The post-run report is [scripts/run-session-pattern-extraction-summary.mjs](scripts/run-session-pattern-extraction-summary.mjs). It can also be run against an already completed chain. In a structural-only run, the report explicitly marks semantic session topics, task outcomes, and executable workflow success as unknown; it does not infer them from tool names or filenames.

Discovery now ranks sessions using a frozen-snapshot interest index: canonical human-message count, explicit `product-factory` / `product-factory-pi` references, and observable building signals. Synthetic Codex context and embedded review transcripts are excluded from the human count. The scan stores no message text.

The bounded semantic follow-up is [scripts/run-semantic-session-workflow-extraction.mjs](scripts/run-semantic-session-workflow-extraction.mjs). It selects development-split sessions with those historical signals and observable building activity, creates a clipped/redacted evidence packet for each source, runs one fresh Pi dossier context per session, and hands only the dossiers to a fresh aggregator. The semantic path then deterministically defines the extracted pattern as `candidate-train.yaml`; this closes the define-workflow gap without asking the model to invent a second representation. Each retry gets a numbered attempt directory. Verify a completed run with [scripts/verify-semantic-session-workflow-extraction.mjs](scripts/verify-semantic-session-workflow-extraction.mjs); the verifier checks artifact shape, boundedness, handoff boundaries, `--no-session` isolation, and exact correspondence between the extraction report and candidate YAML independently. After verification, [scripts/define-semantic-workflow-candidate.mjs](scripts/define-semantic-workflow-candidate.mjs) registers it under `workflows/candidates/` without a separate approval gate. Registration makes it an official versioned candidate, not a converged workflow; identifier or version collisions must be resolved explicitly rather than silently overwritten.

The repaired backtest is [scripts/run-semantic-workflow-backtest.mjs](scripts/run-semantic-workflow-backtest.mjs). It refuses to run unless the candidate YAML exactly matches the extraction report, then evaluates that first-class candidate and the prior idea on separate tuning sessions in fresh contexts. It explicitly runs in `observational_trace_not_replay` mode: causal task success and counterfactual outcomes remain unknown unless directly evidenced. Unknown metrics are retained rather than forced into pass/fail values. Verify it with [scripts/verify-semantic-workflow-backtest.mjs](scripts/verify-semantic-workflow-backtest.mjs). Holdout remains sealed until an explicit candidate-freeze decision.

The workflow must preserve evidence links for every extracted rule. A pattern is not promoted merely because it appears often: the candidate must also make the observed outcome easier to reproduce, avoid material regressions against the baseline, and expose uncertainty instead of silently generalising an exception.

The book-guided slow loop is [workflows/slow-loop.yaml](workflows/slow-loop.yaml). It takes one engineering book or body of knowledge as input, inspects the target codebase for evidence-backed rule candidates, matches them to the book, defines tests, and implements only the justified changes. An empty candidate set or no-change result is valid when the inspection does not support an improvement.

## Goal

The goal is to externalise recurring human engineering workflows so agents can execute them with less micromanagement.

The human should increasingly provide intent and guidance at the highest useful level, while trains encode how recurring work is carried out and handed from one stage to the next.

## Generic Pi runner

The primary runtime is now the Pi-native extension in
[`extensions/train-runner.js`](extensions/train-runner.js). Install this repo as
a Pi package or load the extension directly:

```bash
pi install /home/bendi/trains
# or, for a one-off run:
pi -e /home/bendi/trains/extensions/train-runner.js
```

Inside Pi, start a train with:

```text
/train workflows/your-train.yaml {"request":"..."}
/train-status
/train-steer Please re-check the evidence boundary.
/train-pause
/train-resume
/train-cancel
```

The extension is the state machine: it loads the lean YAML, schedules runnable
cars, creates a fresh Pi session with `newSession()` for every invocation,
passes only declared inputs, and advances only after the car calls the
terminating `train_handoff` tool and Pi emits `agent_settled`. In RPC and
replacement-session runtimes, that event queues the internal
`/train-advance` command so the next transition re-enters through a
command-capable context before calling `newSession()`. Complete state
snapshots are persisted as `trains.state.v1` custom session entries, so the
controller can reconstruct itself after a session reload. Nested procedures are
call frames, and car-level repeats create another fresh invocation with
explicit feedback inputs. `/train-steer` records the exact intervention in
the same state history.

The handoff is structurally validated. YAML acceptance clauses remain
worker-facing prose unless a deterministic verifier or human review supplies
semantic evidence; terminal runs therefore retain a verification boundary
instead of treating an agent assertion as independent proof.

The subprocess runner below remains as a compatibility and regression harness
for the earlier batch workflow. It is not the Pi-native execution path.

`src/trains-runner.mjs` is the first generic execution engine for the contract
above. It compiles references into a dependency graph, runs each car in a fresh
Pi `--no-session` RPC process, validates a structured handoff, supports nested
train call frames, evaluates one-car `repeat` loops, and persists a resumable
state snapshot plus append-only events outside the train YAML.

Run it with:

```bash
npm install
node scripts/run-train.mjs \
  --train workflows/your-train.yaml \
  --input-json inputs.json \
  --pi-cli /path/to/pi-cli.js \
  --worker-command /path/to/node \
  --provider openai-codex \
  --model gpt-5.6-luna \
  --thinking xhigh
```

The run directory contains `state.json`, `events.ndjson`, one supervised Pi
run per car invocation, and nested call-frame state. A clean Pi exit is still
only `needs_verification`; the runner advances a car only after independently
validating its handoff envelope. Prose acceptance checks remain worker-facing
contracts, so semantic acceptance must be independently verified by the caller.

The required handoff shape is:

```json
{
  "schemaVersion": 1,
  "runId": "...",
  "trainId": "...",
  "step": "...",
  "invocationId": "...",
  "status": "ready_for_verification",
  "outputs": {"result": {"accepted": true}},
  "evidenceRefs": [],
  "claimsNotMade": []
}
```

The runner intentionally does not add `state`, model settings, retries, paths,
or tool policy to train YAML. The native extension uses Pi's session and
extension APIs for interactive execution; the compatibility runner uses the
existing Pi Product Factory supervisor for batch execution.

## Initial schema direction

The first workflow establishes a deliberately small schema vocabulary:

- `id` identifies a train;
- each step has only `inputs`, `procedure`, and `outputs`;
- `doc` defines an input or output inline and `ref` links to another output;
- output-local `acceptance` validates that output;
- optional car-level `repeat` declares explicit feedback inputs and the accepted output that ends the loop.

Pi execution details and run evidence live beside the workflow in runners, contracts, reports, and registry records. New train fields should be added only when executable meaning cannot be represented with this core.

Remaining design questions are now downstream of this first workflow: which artifact types deserve standard formats, how different execution engines should expose replay, and which metrics generalise across train families.
