# Session-pattern extraction operating contract

This document explains how to execute `session-pattern-extraction.yaml`. It is intentionally more precise than the generic train definition because historical-session mining is especially vulnerable to hindsight bias and overfitting.

## Corpus preflight

Before Pi interprets a corpus, run `scripts/build-session-corpus-index.mjs` once against every declared session root. The index is the default input for discovery and contains structural metadata and hashes, not copied transcript text. This keeps a multi-gigabyte corpus out of one model context and makes the snapshot auditable. Then run `scripts/build-session-interest-index.mjs` against that frozen index. It reads each source only through the index snapshot cutoff and emits metadata for selecting interesting sessions: human-message count, explicit product-factory/product-factory-pi signals, and a bounded building classification. It strips synthetic Codex context and does not retain message text.

The interest scan is a discovery signal, not a semantic outcome label. “Likely building” means the session contains observable combinations such as file editing plus command execution, or implementation language plus editing/commands. It must be checked by the discovery worker against the selected source boundary before being promoted to a workflow pattern. The structural chain remains structural-only; semantic extraction is a separate experiment with its own bounded, allowlisted contract.

## Bounded semantic extraction

Run `scripts/run-semantic-session-workflow-extraction.mjs` only after the frozen interest index exists. The runner selects development-split sessions with an explicit `product-factory` or `product-factory-pi` signal and `likely_building`/`possibly_building` evidence, then deduplicates by independence group. It deterministically reads each selected source once to create a clipped, secret-redacted evidence packet; the Pi dossier worker reads that packet, not the raw transcript. This keeps semantic judgment in a fresh context without asking the model to navigate multi-megabyte session logs.

Each selected session gets a fresh supervised Pi `--no-session` dossier context. The aggregator is another fresh `--no-session` context whose declared inputs are only the interest index and bounded dossiers. It must compare the session-derived workflow with the prior idea, report support counts and contradictions, and leave backtesting/convergence pending. It may not reopen raw sessions or worker events.

The runner writes `attempt-001`, `attempt-002`, and so on under the run directory and artifact directory. A failed attempt writes an explicit `result.json`; the next attempt starts from clean worker ledgers rather than appending to a partial run. The reliability loop is:

1. Run a one-session canary.
2. Inspect the failed phase and artifact, then adjust the runner contract or verifier.
3. Rerun in a new attempt directory until the canary passes independently.
4. Run the selected multi-session extraction.
5. Run `scripts/verify-semantic-session-workflow-extraction.mjs` against the accepted result.

The verifier is intentionally separate from Pi. It checks bounded packet/dossier sizes, required sections, explicit boundary assertions, report support-count bounds, pending backtest status, and `--no-session` in every supervisor launch. A successful extraction is not convergence; it is the input to the next backtest train.

## Observational backtest boundary

Run `scripts/run-semantic-workflow-backtest.mjs` against a candidate report and the tuning split after extraction. This repaired mode creates one fresh evaluator context per tuning case plus a fresh aggregator. It compares the candidate and prior idea on the same bounded trace, but does not call that a causal replay: the evaluator may label directly observed support, contradiction, or unknown, while counterfactual task success and outcome fidelity remain unknown unless the evidence directly supports them. Run `scripts/verify-semantic-workflow-backtest.mjs` independently. A report with unknown metrics is an honest incomplete backtest, not a reason to invent scores or touch the holdout.

## Pi execution and context boundaries

The workflow is executed as a chain of trains, not as one long Pi conversation. Each stage starts a new supervised Pi RPC process with `--no-session` and its own run contract and event ledger:

1. identify sessions;
2. extract workflow patterns;
3. define the candidate train;
4. backtest;
5. compare and adjust;
6. decide whether to loop or freeze.

The only state that crosses the boundary is the previous stage's declared JSON handoff plus the source artifacts explicitly listed in the next contract. A stage must not read another stage's events, contract, handoff, or private reasoning. The handoff records decisions, evidence references, unknowns, claims not made, and the next route. Stages 4–6 repeat with fresh contexts until the convergence handoff returns a terminal status.

The discovery stage receives the interest index as a declared artifact. It fixes the development/tuning/holdout split before applying the ranking. Its default review set is then the top 25 eligible sessions by human-message count, every eligible session with an explicit product-factory or product-factory-pi signal, and the top 25 eligible likely-building sessions. It still preserves the full corpus inventory and fixed splits; prioritization does not delete or relabel unselected sessions, and holdout ranking never becomes extraction evidence.

## Post-run executive analysis

Once the chain has a terminal result, the runner starts one independent post-run analyst in a new `--no-session` Pi context. The analyst is not another extraction or backtest stage. It reads the completed chain result, chain event ledger, stage handoffs, declared workflow files, and output artifacts, then writes:

- `executive-summary.json` with machine-readable topic, statistics, extracted workflow, `newPatterns`, `matchedExisting`, convergence, and unknowns fields;
- `executive-summary.md` with the founder-facing summary;
- an analyst handoff recording the evidence boundary and report outputs.

The analyst must distinguish observed facts, bounded structural inferences, and unknowns. The current first run deliberately indexed structure without copying transcript text, so its per-session semantic topics and outcome metrics remain unknown. A future semantic extraction mode must add a separate, allowlisted input contract before those fields can be populated.

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
