# Trains

A small framework for turning recurring agent work and reasoning into explicit, composable workflows that can be executed more consistently.

## Core concepts

### Train

A **train** is a reusable unit of work or reasoning.

A train is defined declaratively, initially as YAML, with a GitHub-CI-like structure. It may define:

- inputs;
- outputs / handoffs;
- steps;
- dependencies;
- other trains it invokes or depends on.

The exact schema is intentionally not fixed yet.

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

The workflow must preserve evidence links for every extracted rule. A pattern is not promoted merely because it appears often: the candidate must also make the observed outcome easier to reproduce, avoid material regressions against the baseline, and expose uncertainty instead of silently generalising an exception.

## Goal

The goal is to externalise recurring human engineering workflows so agents can execute them with less micromanagement.

The human should increasingly provide intent and guidance at the highest useful level, while trains encode how recurring work is carried out and handed from one stage to the next.

## Initial schema direction

The first workflow establishes a deliberately small schema vocabulary:

- `version`, `kind`, and `id` identify a train;
- `inputs` and `outputs` define the handoff contract;
- `parameters` hold tunable thresholds without hiding them in prose;
- `steps` describe work, dependencies, artifacts, and acceptance checks;
- `routing` expresses the explicit loop between backtest and comparison;
- `convergence` defines when refinement stops.

This is a starting contract, not a claim that every future train needs the same fields. New schema should be added when a workflow cannot be made testable or composable without it.

Remaining design questions are now downstream of this first workflow: which artifact types deserve standard formats, how different execution engines should expose replay, and which metrics generalise across train families.
