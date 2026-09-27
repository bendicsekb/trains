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
