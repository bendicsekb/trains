# Session-pattern extraction operating contract

This document explains how to execute `session-pattern-extraction.yaml`. It is intentionally more precise than the generic train definition because historical-session mining is especially vulnerable to hindsight bias and overfitting.

## Corpus preflight

Before Pi interprets a corpus, run `scripts/build-session-corpus-index.mjs` once against every declared session root. The index is the default input for discovery and contains structural metadata and hashes, not copied transcript text. This keeps a multi-gigabyte corpus out of one model context and makes the snapshot auditable. Pi may inspect source transcripts only through bounded, allowlisted reads selected from the index.

## What counts as a useful extraction

The output is not a summary of the sessions. It is a candidate procedure that another agent can follow from the same starting context. Each promoted rule should answer:

- What triggers it, and what preconditions must hold?
- What action or decision does it add?
- What evidence supports it, from how many independent sessions?
- What outcome does it protect or improve?
- When does it not apply?
- What should happen when the evidence is insufficient?

The extraction should preserve a pattern's scope. For example, “inspect the existing code before editing” may be a broad invariant, while “use command X for repository Y” is likely a context-bound tactic.

## Split and replay rules

Split the corpus before interpreting outcomes:

- **Development** sessions provide evidence for pattern extraction and the first candidate.
- **Tuning** sessions are the feedback loop for backtest and adjustment.
- **Holdout** sessions are sealed until the candidate is frozen.

Retries and continuations from the same underlying task belong to one independence group. They may show failure recovery, but they do not count as separate confirmation of a rule.

During replay, the candidate may see only the context available at the selected session boundary. It must not see the historical assistant's later messages, tool results, final answer, or evaluator judgment. A replay that needs hidden historical information is an execution failure or a missing input contract, not a successful match.

## Comparison protocol

Every iteration compares three things where available:

1. the candidate's current result;
2. the declared baseline under the same case conditions;
3. the previous candidate, to distinguish real improvement from random variation.

The default metric set is:

- primary: task success and correctness of the requested outcome;
- secondary: outcome fidelity, human intervention rate, unnecessary work, safety violations, and unhandled branches.

If a metric cannot be evaluated for a case, record `unknown` with a reason. Do not convert unknown into a pass or remove the case from the aggregate without reporting it.

## Convergence and human gates

The loop stops only when the candidate satisfies all required convergence checks. “No obvious problem” is not a convergence result. The workflow should return `max_iterations_exceeded` rather than silently accept an unstable candidate.

The sixth stage owns the loop decision. A tuning result that needs a change sets `convergence.status` to `continue` and routes back to `backtest`; a candidate that passes the tuning checks is frozen, evaluated once on holdout, and becomes `converged` only after that holdout run passes. Holdout evidence can fail convergence, but it cannot be used to make another candidate change in the same run.

Human review is required when a change affects safety, privacy, permissions, irreversible actions, or the meaning of the target behavior. A human may also reject convergence even when the numeric checks pass; that decision and its rationale belong in the convergence record.

The final artifact should include the frozen train, evidence links, the split manifest, per-case backtest results, aggregate comparison, known limitations, and the next observation that would justify reopening it.
