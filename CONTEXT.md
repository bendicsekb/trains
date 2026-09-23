# Trains

Trains externalize recurring human workflows so agents can perform them consistently. Teaching sessions capture reviewable, recoverable human-guided work.

## Language

**Train**:
A reusable, composable process for work or reasoning.

**Car**:
A prescribed unit of work or reasoning within a train.

**Handoff**:
An explicit result that a car or train produces for another to consume.

**Teaching session**:
A problem-solving conversation in which a person directs an agent and explains their approach, with Git checkpoints, reviewable changes, and explained rollback.

**Attempt**:
A preserved path through solving a problem, including its conversation, work products, and feedback, even when abandoned in favor of another path.

**Session branch**:
The current code path for a teaching session and the subject of its single draft PR. Rolling back changes this path while preserving the abandoned code on a backup branch.

**Backup branch**:
A preserved code path from before a rollback, associated with its teaching session and abandoned attempt.

**Rollback explanation**:
The user's required account of what went wrong in an abandoned attempt. It is preserved as learning evidence without entering the resumed agent's context.
