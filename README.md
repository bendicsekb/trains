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

By default, crossing a handoff implies a fresh model context; inherited conversational history must be explicit rather than implicit.

### Human step

A **human step** is a blocking step inside a running train or workflow. The run does not end: it remains blocked until the required human result arrives, then continues from that result and the persisted workflow state.

Humans should be treated like a slow, sloppy external API: they may take a long time, respond partially, return arbitrary artifacts, or require several interactions before the dependency is actually satisfied.

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

## Goal

The goal is to externalise recurring human engineering workflows so agents can execute them with less micromanagement.

The human should increasingly provide intent and guidance at the highest useful level, while trains encode how recurring work is carried out and handed from one stage to the next.

A train also forms a context boundary: a new invocation should normally start from fresh model context and consume declared inputs and handoffs rather than inherit the full reasoning trajectory of upstream work. Handoffs therefore act as intentional compaction points, carrying forward decision-relevant state while discarding incidental conversation, exploration, and failed paths. This limits trajectory poisoning and keeps downstream work in a cleaner context.

The goal is not to remove humans from every process, but to put them at the points where their judgment has leverage. A human step should feel like waiting on an API or a rate limit: autonomous work can continue up to that dependency, the workflow blocks while the human learns what they need, talks to whoever they need, and exercises taste or judgment, and then the same workflow resumes from whatever result they return.

## Open questions

- What is the minimal YAML schema for a train?
- What should count as a train boundary?
- Which handoff formats should be standardised, if any?
- How should trains express dependencies and composition?
- When is inconsistency significant enough to justify creating or refining a train?
- How should human steps declare what counts as enough evidence or output to resume?

## References

The context-boundary and intentional-compaction framing is informed by Dex Horthy's discussion of **trajectory poisoning** and **intentional compaction** with Gergely Orosz on *The Pragmatic Engineer*: [Context engineering with Dex Horthy](https://newsletter.pragmaticengineer.com/p/context-engineering-with-dex-horthy) (15 July 2026).
