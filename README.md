# Trains

A small framework for turning recurring engineering thought processes into explicit, composable workflows that an agent can execute consistently.

## Core idea

A **train** is a YAML-defined unit of work or reasoning.

A train can contain GitHub-CI-like steps and dependencies, and should produce an explicit handoff that another train can consume.

A **workflow** is a train composed of other trains.

The system should evolve from observed inconsistency: when a train is too vague or unreliable, define another train that makes that part of the process more explicit and consistent, then compose it into the workflow.

In short:

```text
describe workflow
  -> run it
  -> find inconsistency
  -> create or refine a train that constrains that part
  -> compose it back into the workflow
```

The goal is to externalise recurring engineering reasoning so agents need less micromanagement.

## Train shape

Exact syntax is not decided yet, but the control structure should feel like GitHub Actions:

```yaml
name: understand-user-problem

depends_on:
  - collect-user-evidence

steps:
  - read-evidence
  - infer-use-cases
  - identify-underlying-problems

handoff: user-problem-model
```

The important parts are:

- explicit steps;
- dependencies between trains;
- explicit handoffs;
- composability;
- the ability to make an unreliable process more constrained over time.

## Example: feature development

A feature-development workflow could initially be described as these trains:

1. **Collect user evidence**  
   Find relevant asks and context, for example from Slack, GitHub issues, and local chat history.  
   Handoff: raw relevant resources.

2. **Understand the actual user problem**  
   Read the evidence and distinguish the literal request from the underlying use case: what people are trying to achieve, what problem they have, and how they solve it today.  
   Handoff: a structured representation similar to user stories / problem statements.

3. **Understand the current system**  
   Map how the existing product and code work around those use cases, including the relevant code paths and established patterns.  
   Handoff: current-system model.

4. **Explore solutions**  
   Generate plausible approaches, sketch them, prototype where useful, and identify advantages and drawbacks.  
   Handoff: candidate approaches with evidence.

5. **Choose an approach**  
   Compare candidates against the user problems, the current system, established patterns, and the values or trade-offs that matter.  
   Handoff: decision / ADR.

6. **Deliver and learn**  
   Break the decision into atomic changes, implement, merge, ship, monitor, collect feedback, and adjust. This phase contains many further processes and is intentionally not specified yet.

## How the framework grows

Do not try to define every train up front.

Start with a coarse workflow. When execution proves inconsistent, ambiguous, or repeatedly requires human steering, make that part more explicit by adding or refining a train.

A large train may later become a workflow of smaller trains if that is what is needed to make execution reliable.

## Goal

The long-term goal is to encode enough of the recurring engineering process that, before doing work manually, the question becomes:

> How can I guide Pi / Codex / Claude through this process instead?

Then capture that guidance as trains, handoffs, and workflows so the process becomes increasingly executable without micromanagement.

## Open questions

- What is the exact YAML schema for a train?
- What makes something one train versus several trains?
- What should handoff contracts look like?
- How should relevance be determined when collecting evidence?
- When should an inconsistency justify a new train rather than a one-off correction?
- How should values and trade-offs be represented when choosing between approaches?
