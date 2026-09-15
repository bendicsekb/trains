# Trains specification

Status: sufficient for the first runner implementation; intentionally minimal.

This is the canonical target contract. Existing prototype workflows and runners
still use an earlier top-level repeat form; they must be migrated to the nested,
single-car loop described here before they are considered conforming.

## Founding note

The following is the founder's original description, preserved verbatim:

> Trains
>
> Train of thought - cars are individual thoughts
>
> Analogy is like a PA- it can be whatever the best it still won't know things like oh we do things this way. And for that a brain is not good for that we need processes.
>
> For the processes i came up with trains which is train of thought where you describe your processes in trains of thought then observe the result and steer again until the agent gets it right. So basically I help the agent through a task, explain we do thing this way or really just get it over the line with instructoons and leading questions and then we'll do a learning loop where we adjust the tracks for the trains. A train should be composable infinitely, a task is like a callstack, but we trust the agent to do the work inside a train, we're not micromanagers. If something goes wrong we change the tracks or add more cars to the train - ie change the process to follow to specify it more to then make right thing to do the easiest or most natural thing the agent does. We don't want to contort the agent with rules, we want to make the processes so that the natural answer is the right one. This is basically "employee handbook" vs "good team boundaries".
>
> The evolution should be: we define a super lean process in a yaml, like steps, handoff and dependencies. I imagine pi to be the state machine, the runner of these steps, with a new clean context each step, context should be seeded with its task description and all relevant handoffs from steps this depends on. So the yaml (or multiple) defines the graph (cycles possible) and then pi will run it. I kinda see we'll want to specify very specific tools per train or maybe even per car
>
> I need to figure out how to guide the process actively and not just do retros/rcas

## Purpose

Trains externalize how work is done. A capable agent may know how to perform a task without knowing how this team performs it. A brain supplies knowledge; a train supplies process.

The objective is not to constrain the agent with exhaustive rules. It is to shape the process so the natural next action is usually the right one. The train defines boundaries and handoffs while trusting the agent to reason inside each car.

## Core model

- A **train** is a composable process.
- A **car** is one meaningful thought or unit of work.
- A **track** is a dependency created by an input reference.
- A **handoff** is a car output consumed by another car.
- A train may invoke another train, producing a call stack.
- Composition is recursive; no special distinction exists between a train and a workflow made from trains.
- Pi is the execution engine, not part of the declarative workflow.

## Minimal definition

```yaml
id: example

steps:
  first:
    inputs:
      request: {doc: Work to perform.}
    procedure:
      - Perform one meaningful unit of work.
    outputs:
      result:
        doc: Concrete result or durable reference.
        acceptance:
          - The requested result is supported by evidence.

  second:
    inputs:
      result: {ref: first.result}
    procedure:
      - Use the result.
    outputs:
      final:
        doc: Final result.
        acceptance:
          - The result satisfies the request.
```

The first unbound `doc` inputs form the train's input interface. Final outputs that are not consumed inside the train form its output interface. They are not declared again at the top level.

## Inputs and outputs

An input is exactly one of:

```yaml
request: {doc: Work to perform.}
prior: {ref: earlier.result}
```

- `doc` introduces an input at the current train boundary.
- `ref` consumes a declared output and creates the dependency on its producer.
- There is no generic workflow state. The working environment is implicit.
- When a stable handoff matters, produce a concrete value or reference such as a commit hash, report path, deployment URL, test run, or decision record.

An output has a `doc` or a `ref` and is validated where it is declared:

```yaml
revision:
  doc: Commit containing the implemented change.
  acceptance:
    - The commit contains only the scoped change and its verification.
```

A referenced nested output inherits its output contract unless the parent narrows it further.

## Procedures and composition

A procedure is either instructions trusted to the executing agent:

```yaml
procedure:
  - Inspect the relevant boundary and choose the smallest useful action.
```

or another train:

```yaml
procedure:
  ref: ./bounded-engineering-cycle.yaml
```

Invoking a train pushes it onto the execution call stack. Its declared inputs are supplied to the child; its final outputs return to the calling car.

## Repetition

Repetition is a property of one car, not a standalone car and not an arbitrary range of sibling cars. When several cars must repeat together, place them in a nested train and repeat the car that invokes it.

```yaml
improve:
  inputs:
    brief: {ref: frame.brief}
  procedure:
    ref: ./bounded-engineering-cycle.yaml
  repeat:
    inputs:
      previous: {ref: result}
    until: {ref: result.accepted}
  outputs:
    result: {ref: resolve.result}
```

Loop semantics:

1. The first invocation receives the car's ordinary inputs.
2. After each invocation, the runner evaluates `repeat.until`.
3. If it is not satisfied, `repeat.inputs` are resolved from that invocation's outputs and added to the next invocation.
4. Repeat inputs may not silently overwrite ordinary inputs.
5. Only the final accepted outputs return to the parent train; intermediate outputs remain in execution history.
6. Operational iteration limits, retries, timeouts, and failure recovery belong to the runner, not the train definition.

This explicit feedback edge replaces implicit mutable state.

## Pi execution

For each car invocation, Pi starts a clean context seeded with:

- the car's procedure;
- its declared inputs;
- the relevant outputs referenced by those inputs;
- no undeclared sibling context or private reasoning.

Pi executes the car, validates its outputs against their acceptance checks, and hands the outputs to dependent cars. A nested train receives its own call frame and clean car contexts.

The runner owns process mechanics including model selection, context creation, retries, timeouts, persistence, event logs, and supervision. Those mechanics do not belong in train YAML.

## Learning loop

1. Begin with the leanest process that can plausibly work.
2. Run it and observe the outputs and interventions.
3. Steer the agent when necessary to get the task over the line.
4. Determine whether the miss came from the car, track, handoff, boundary, runner, or one-off circumstances.
5. Change or add the smallest car or track that makes the desired behavior natural next time.
6. Re-run and retain only improvements supported by evidence.

The process evolves from actual collaboration. Retrospectives and RCAs are evidence for changing the tracks, not the only time learning may happen.

## Design constraints

- Keep train YAML semantic and lean.
- Trust the agent inside a car; do not encode implementation micromanagement.
- Every car must perform meaningful transformation, verification, classification, or decision-making.
- Do not create bookkeeping-only cars. Durability belongs in concrete outputs.
- Dependencies come from references rather than separate ordering declarations.
- Acceptance belongs to the output it validates.
- Do not hide cross-iteration data in generic state.
- Do not put Pi flags, paths, retries, provenance, evidence counts, lifecycle status, or backtest bookkeeping in train YAML.

## Open design questions

### Active steering

Define how human guidance enters a running car and how the intervention becomes evidence for a proposed track change during the same run, rather than waiting only for a retrospective or RCA.

### Tool boundaries

Determine whether tools are declared per train, per car, or supplied entirely by the runner. Prefer the coarsest boundary that reliably makes the intended action natural while preserving safety.
