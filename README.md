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

## Open questions

- What is the minimal YAML schema for a train?
- What should count as a train boundary?
- Which handoff formats should be standardised, if any?
- How should trains express dependencies and composition?
- When is inconsistency significant enough to justify creating or refining a train?

## References

The context-boundary and intentional-compaction framing is informed by Dex Horthy's discussion of **trajectory poisoning** and **intentional compaction** with Gergely Orosz on *The Pragmatic Engineer*: [Context engineering with Dex Horthy](https://newsletter.pragmaticengineer.com/p/context-engineering-with-dex-horthy) (15 July 2026).
