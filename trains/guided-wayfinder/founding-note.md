# Founding note

Captured 2026-09-27. Preserved verbatim.

> Let's add a train where we go through mattpocock wayfinder but in pi with fix steps and add a discovery and teach car too where the train teaches me what I need to do and I just give judgement. The idea here is that mattpocock wayfinder asks questions which is allright but it assumes complete knowledge of the system, which I don't have and do not want to have. I want to instead make a judgement call, given this current system and this goal and these blockers what should we do. I like the original idea of map and fog of war, I want something more, the teaching block, where the agent before every call tells me what the context is, I even push further to explain parts and then make the decision. I want simple steps that reflect the explore teach decide explore loop.

## Design interpretation

This train keeps Wayfinder's useful map, frontier, and fog-of-war model: the map is a low-resolution index of the route, while the frontier is the smallest decision that can be made now. The difference is the human contract. The human is not expected to know the architecture or answer a long interview; Pi explores the current system, teaches the decision-relevant context, and asks for judgement only where values, scope, or trade-offs matter.

The fixed cycle is:

1. **Explore** the current frontier and update the map.
2. **Teach** the relevant context, evidence, unknowns, options, and consequences.
3. **Decide** through a first-class human node whose input is the teaching block and whose output is the human's judgement. If the answer is incomplete, a separate review car returns concrete feedback and the teach → human block repeats.
4. **Fix** by turning that judgement into the smallest safe next steps.
5. **Explore** again by executing or investigating those steps, verifying the result, and exposing the next frontier.

The cycle repeats until the goal or a verified handoff is reached. Pi owns the exploration and implementation; the human owns judgement. A missing fact stays visible as fog rather than becoming a confident guess.

The human node is intentionally tiny: teaching is the prompt, the human answer is the output, and the persisted `waiting_human` state is the boundary between Pi's work and human judgement. Human answers are not trusted as automatically sufficient; the fresh review car checks whether the answer is usable and drives the retry loop when it is not.

The inspiration is Matt Pocock's [Wayfinder](https://github.com/mattpocock/skills/blob/main/docs/engineering/wayfinder.md), adapted to Trains' fresh-context Pi execution and explicit handoffs.

## Natural path and autonomy

Captured 2026-10-03.

> “I often hit what I'd describe as a roadblock, and then I fix the infra we do not choose a workaround.”
>
> “there should be a way that feels natural simple and elegant, and first we need to check if that works and only then start hacking around.”

> “If it's on a project we've just created do whatever. If it's reversible do whatever. Human input is very expensive, be as autonomous as we can”

At a blocker, separate verified facts (known knowns), specific open questions or assumptions (known unknowns), and relevant territory not yet investigated (unknown unknowns). State the simple, conventional solution an experienced engineer would try first, given the system, and its smallest useful check. Pursue and verify it when safe and in scope. Use a workaround only when evidence or a concrete constraint rules out the natural path, and record why.

The goal authorizes in-scope work. Do reversible implementation and validation autonomously, including narrow project-scoped infrastructure changes with a clear rollback. Ask only when the goal leaves a consequential choice open: destructive or hard-to-reverse work, out-of-scope effects, broad security or privacy impact, material ongoing cost, or a genuine value or direction trade-off.

## Issue #15: self-unblocking before escalation

Captured 2026-10-03 from [ideas Issue #15](https://github.com/bendicsekb/ideas/issues/15), “Gate human escalation behind self-unblocking investigation.”

> Human escalation should be a **gated recovery path, not an immediate fallback**.

Before escalating a blocker, follow Issue #15's resolve-before-escalating procedure:

1. Collect the relevant requirements/specs.
2. Inspect the relevant system/context/evidence.
3. Reconcile contradictions.
4. Try plausible approaches.
5. Record what was tried and what happened.
6. Reassess whether the blocker still exists.

Then classify the result:

- **Unblocked** — the investigation finds a viable way forward, so the agent resumes normal work.
- **Still investigating** — useful things remain to try, so the agent keeps working.
- **Genuinely blocked** — the relevant investigation is exhausted and the remaining blocker is precise.

> You may escalate because you are blocked only after doing the work that might prove you are not blocked.

Only this state waits for a human. The handoff states the problem, requirements, attempts and results, remaining uncertainty, and judgement needed. A viable path returns to work; useful investigation stays agent-owned. Independent consequential choices may still need human judgement.

> This should likely be a **generic escalation protocol at the runtime/process level**, rather than something every train author manually encodes in every workflow.

The current Wayfinder applies this protocol in its teaching step before the conditional human gate. The long-term direction is a generic runtime or process rule, so each train does not need to define it again.
