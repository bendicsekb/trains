import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadTrain } from "../src/train-definition.mjs";
import { createTrainExtension, TrainMachine } from "../extensions/train-runner.js";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "trains-native-"));
}

function writeTrain(directory, name, contents) {
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, contents, "utf8");
  return filePath;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fakePiContext(cwd) {
  const sessions = [];
  let sequence = 0;

  function createContext() {
    const id = `session-${++sequence}`;
    const entries = [];
    const sessionFile = path.join(cwd, `${id}.jsonl`);
    const manager = {
      getEntries: () => entries,
      getSessionFile: () => sessionFile,
      getSessionId: () => id,
      appendCustomEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
    };
    const context = {
      cwd,
      mode: "tui",
      hasUI: true,
      ui: { notify(message, level) { notifications.push({ message, level }); } },
      sessionManager: manager,
      async newSession(options) {
        const next = createContext();
        if (options.setup) await options.setup(next.sessionManager);
        if (options.withSession) await options.withSession(next);
        return { cancelled: false };
      },
      async sendUserMessage(text) { prompts.push({ id, text }); },
      abort() { aborted.push(id); },
      isIdle: () => true,
    };
    sessions.push(context);
    return context;
  }

  const notifications = [];
  const prompts = [];
  const aborted = [];
  const root = createContext();
  return { root, sessions, prompts, notifications, aborted };
}

test("native extension advances only after a structured handoff and creates fresh sessions", async () => {
  const directory = tempDir();
  const trainPath = writeTrain(directory, "linear.yaml", `
id: linear
steps:
  first:
    inputs:
      request: {doc: Work request.}
    procedure:
      - Produce the first result.
    outputs:
      result:
        doc: First result.
        acceptance: [The result is concrete.]
  second:
    inputs:
      prior: {ref: first.result}
    procedure:
      - Produce the final result from the prior handoff.
    outputs:
      final:
        doc: Final result.
        acceptance: [The final result is concrete.]
`);
  const pi = { appendEntry() {}, sendUserMessage() {} };
  const fake = fakePiContext(directory);
  const machine = new TrainMachine({ pi, id: () => "run-1" });
  machine.attachContext(fake.root);

  await machine.start(trainPath, { request: "ship it" });
  assert.equal(machine.status().active.step, "first");
  assert.equal(fake.prompts.length, 1);
  assert.match(fake.prompts[0].text, /ship it/);
  assert.equal(fake.sessions.length, 2, "root plus one fresh car session");

  await machine.onSettled();
  assert.equal(machine.status().status, "blocked", "a stopped car without a handoff cannot advance");

  await machine.steer("Please complete the first result and hand it off.");
  await machine.acceptHandoff({
    outputs: { result: "first-result" },
    summary: "Produced the first result.",
    evidenceRefs: ["test:first"],
    claimsNotMade: ["No claim about the final result."],
  });
  await machine.onSettled();

  assert.equal(machine.status().status, "running");
  assert.equal(machine.status().active.step, "second");
  assert.equal(fake.sessions.length, 3, "the next car gets a distinct fresh session");
  assert.match(fake.prompts.at(-1).text, /first-result/);
  assert.equal(machine.state.frames[0].values.first.result, "first-result");
});

test("shared-session train keeps nested cars and human judgement in one Pi session", async () => {
  const directory = tempDir();
  writeTrain(directory, "child.yaml", `
id: child
steps:
  teach:
    inputs:
      mission: {doc: Mission.}
    procedure:
      - Explain the mission.
    outputs:
      briefing:
        doc: Decision briefing.
        acceptance: [The decision is explained.]
  decide:
    human:
      prompt: {ref: teach.briefing}
    outputs:
      judgement:
        doc: Human judgement.
        acceptance: [The judgement is recorded.]
  assess:
    inputs:
      judgement: {ref: decide.judgement}
    procedure:
      - Assess the judgement.
    outputs:
      result:
        doc: Final assessment.
        acceptance: [The judgement is assessed.]
`);
  const trainPath = writeTrain(directory, "shared.yaml", `
id: shared
session: shared
steps:
  discover:
    inputs:
      goal: {doc: Goal.}
    procedure:
      - Discover the mission.
    outputs:
      mission:
        doc: Mission.
        acceptance: [The mission is concrete.]
  wayfind:
    inputs:
      mission: {ref: discover.mission}
    procedure:
      ref: ./child.yaml
    outputs:
      result: {ref: assess.result}
`);
  const fake = fakePiContext(directory);
  fake.root.newSession = undefined;
  const machine = new TrainMachine({ pi: { appendEntry() {}, sendUserMessage() {} }, id: () => "run-shared" });
  machine.attachContext(fake.root);

  await machine.start(trainPath, { goal: "Test the shared session" });
  assert.equal(machine.status().session, "shared");
  assert.equal(machine.state.active.sessionId, fake.root.sessionManager.getSessionId());
  await machine.acceptHandoff({ outputs: { mission: "Map the system" }, summary: "Mapped it", evidenceRefs: [], claimsNotMade: [] });
  await machine.onSettled();
  assert.equal(machine.status().active.step, "teach");
  assert.match(fake.prompts.at(-1).text, /Earlier cars remain in the conversation/);
  await machine.acceptHandoff({ outputs: { briefing: "Choose a direction" }, summary: "Taught it", evidenceRefs: [], claimsNotMade: [] });
  await machine.onSettled();
  assert.equal(machine.status().status, "waiting_human");
  await machine.acceptHumanInput("Proceed carefully");
  assert.equal(machine.status().active.step, "assess");
  assert.match(fake.prompts.at(-1).text, /Proceed carefully/);
  await machine.acceptHandoff({ outputs: { result: "Accepted" }, summary: "Assessed it", evidenceRefs: [], claimsNotMade: [] });
  await machine.onSettled();
  assert.equal(machine.status().status, "completed");
  assert.deepEqual(machine.state.outputs, { result: "Accepted" });
  assert.equal(fake.sessions.length, 1);
  assert.equal(fake.prompts.length, 3);
});

test("resume retries a blocked car that never created its worker session", async () => {
  const directory = tempDir();
  const trainPath = writeTrain(directory, "resume.yaml", `
id: resume
steps:
  first:
    inputs:
      request: {doc: Work request.}
    procedure:
      - Produce the result.
    outputs:
      result:
        doc: Result.
        acceptance: [The result is concrete.]
`);
  const fake = fakePiContext(directory);
  const machine = new TrainMachine({ pi: { appendEntry() {}, sendUserMessage() {} }, id: () => "run-resume" });
  machine.attachContext(fake.root);
  const newSession = fake.root.newSession;
  fake.root.newSession = undefined;

  await machine.start(trainPath, { request: "ship it" });
  assert.equal(machine.status().status, "blocked");
  assert.equal(machine.state.active.sessionId, null);

  fake.root.newSession = newSession;
  await machine.resume();

  assert.equal(machine.status().status, "running");
  assert.equal(machine.status().active.step, "first");
  assert.equal(fake.sessions.length, 2, "resume creates a fresh worker session");
});

test("human nodes persist teaching as a prompt and resume with the human output", async () => {
  const directory = tempDir();
  const trainPath = writeTrain(directory, "human.yaml", `
id: human
steps:
  teach:
    inputs:
      request: {doc: Work request.}
    procedure:
      - Prepare the decision context.
    outputs:
      briefing:
        doc: Teaching block.
        acceptance: [The context is explained.]
  decide:
    human:
      prompt: {ref: teach.briefing}
    outputs:
      judgement:
        doc: Human answer.
        acceptance: [The answer is recorded.]
`);
  const fake = fakePiContext(directory);
  const machine = new TrainMachine({ pi: { appendEntry() {}, sendUserMessage() {} }, id: () => "run-human" });
  machine.attachContext(fake.root);

  await machine.start(trainPath, { request: "choose a direction" });
  await machine.acceptHandoff({
    outputs: { briefing: "Current context and trade-offs." },
    summary: "Prepared the teaching block.",
    evidenceRefs: ["test:briefing"],
    claimsNotMade: [],
  });
  await machine.onSettled();

  assert.equal(machine.status().status, "waiting_human");
  assert.equal(machine.status().active.mode, "human");
  assert.equal(machine.state.active.humanPrompt, "Current context and trade-offs.");
  assert.match(fake.notifications.at(-1).message, /Current context and trade-offs/);

  await machine.acceptHumanInput("Choose the reversible option.");
  assert.equal(machine.status().status, "completed");
  assert.deepEqual(machine.state.outputs, { judgement: "Choose the reversible option." });
  assert.ok(machine.state.history.some((entry) => entry.type === "human_answer"));
});

test("plain human input keeps the session-capable context for the next car", async () => {
  const directory = tempDir();
  const trainPath = writeTrain(directory, "plain-input.yaml", `
id: plain-input
steps:
  teach:
    inputs:
      request: {doc: Work request.}
    procedure:
      - Prepare the decision context.
    outputs:
      briefing:
        doc: Teaching block.
        acceptance: [The context is explained.]
  decide:
    human:
      prompt: {ref: teach.briefing}
    outputs:
      judgement:
        doc: Human answer.
        acceptance: [The answer is recorded.]
  assess:
    inputs:
      judgement: {ref: decide.judgement}
    procedure:
      - Verify the chosen direction.
    outputs:
      result:
        doc: Assessment.
        acceptance: [The direction is assessed.]
`);
  const fake = fakePiContext(directory);
  const events = new Map();
  const commands = new Map();
  const tools = new Map();
  const queuedMessages = [];
  const pi = {
    appendEntry() {},
    sendUserMessage(message) { queuedMessages.push(message); },
    on(name, handler) { events.set(name, handler); },
    registerCommand(name, definition) { commands.set(name, definition); },
    registerTool(definition) { tools.set(definition.name, definition); },
  };
  createTrainExtension()(pi);

  await commands.get("train").handler(`${trainPath} {"request":"choose a direction"}`, fake.root);
  const teachingContext = fake.sessions.at(-1);
  await tools.get("train_handoff").execute("test", {
    outputs: { briefing: "Current context and trade-offs." },
    summary: "Prepared the teaching block.",
    evidenceRefs: ["test:briefing"],
    claimsNotMade: [],
  });
  await events.get("agent_settled")();
  await commands.get("train-advance").handler("", teachingContext);

  assert.equal(teachingContext.newSession instanceof Function, true);
  assert.equal(fake.sessions.length, 2, "root plus teaching session");

  const restrictedInputContext = { ...teachingContext, newSession: undefined };
  const result = await events.get("input")({ text: "Choose the reversible option." }, restrictedInputContext);

  assert.deepEqual(result, { action: "handled" });
  assert.equal(queuedMessages.at(-1), "/train-advance");
  assert.equal(fake.sessions.length, 2, "plain input should wait for the command context to advance");
  await commands.get("train-advance").handler("", teachingContext);
  assert.equal(fake.sessions.length, 3, "the queued advance should start the next car session");
  const latestState = fake.sessions.at(-1).sessionManager.getEntries().at(-1).data;
  assert.equal(latestState.status, "running");
  assert.equal(latestState.active.stepId, "assess");
  assert.equal(fake.sessions.at(-1).sessionManager.getSessionId(), "session-3");
});

test("guided Wayfinder retries teaching and human judgement until the review accepts it", async () => {
  const directory = tempDir();
  const fake = fakePiContext(directory);
  const machine = new TrainMachine({ pi: { appendEntry() {}, sendUserMessage() {} }, id: () => "run-guided-wayfinder" });
  machine.attachContext(fake.root);

  await machine.start(path.join(repoRoot, "trains/guided-wayfinder/guided-wayfinder.yaml"), {
    goal: "Reach the goal",
  });

  await machine.acceptHandoff({
    outputs: { mission: { goal: "Reach the goal", initial_map: "Known parts and fog" } },
    summary: "Established the destination and initial map.",
    evidenceRefs: ["test:mission"],
    claimsNotMade: [],
  });
  await machine.onSettled();

  await machine.acceptHandoff({
    outputs: { map: "Map after exploration", frontier: "Choose the integration boundary" },
    summary: "Found the first decision frontier.",
    evidenceRefs: ["test:frontier"],
    claimsNotMade: [],
  });
  await machine.onSettled();

  await machine.acceptHandoff({
    outputs: {
      briefing: "Teaching: these are the two boundary options and their trade-offs.",
      requires_human: true,
      recommended_judgement: "Proceed with the reversible option and verify it.",
    },
    summary: "Taught the decision context.",
    evidenceRefs: ["test:briefing-1"],
    claimsNotMade: [],
  });
  await machine.onSettled();
  assert.equal(machine.status().status, "waiting_human");
  await machine.acceptHumanInput("I am not sure yet.");

  await machine.acceptHandoff({
    outputs: { result: { accepted: false, feedback: "Choose a boundary or ask for one specific missing fact." } },
    summary: "The answer needs clarification.",
    evidenceRefs: ["test:review-1"],
    claimsNotMade: [],
  });
  await machine.onSettled();
  assert.equal(machine.status().active?.step, "teach");

  await machine.acceptHandoff({
    outputs: {
      briefing: "Teaching again: option A is reversible; option B is faster but irreversible.",
      requires_human: true,
      recommended_judgement: "Proceed with the reversible option and verify it.",
    },
    summary: "Addressed the review feedback.",
    evidenceRefs: ["test:briefing-2"],
    claimsNotMade: [],
  });
  await machine.onSettled();
  assert.equal(machine.status().status, "waiting_human");
  await machine.acceptHumanInput("Choose option A because reversibility matters.");

  await machine.acceptHandoff({
    outputs: { result: { accepted: true, feedback: "The direction and guardrail are explicit." } },
    summary: "The answer is sufficient.",
    evidenceRefs: ["test:review-2"],
    claimsNotMade: [],
  });
  await machine.onSettled();
  assert.equal(machine.status().active.step, "fix");

  await machine.acceptHandoff({
    outputs: { fix_plan: "Apply the reversible boundary change and test it." },
    summary: "Defined the fix steps.",
    evidenceRefs: ["test:fix"],
    claimsNotMade: [],
  });
  await machine.onSettled();
  await machine.acceptHandoff({
    outputs: { result: { stop: true, next_map: "Goal reached", next_frontier: null } },
    summary: "Verified the goal.",
    evidenceRefs: ["test:complete"],
    claimsNotMade: [],
  });
  await machine.onSettled();

  assert.equal(machine.status().status, "completed");
  assert.ok(machine.state.history.filter((entry) => entry.type === "human_answer").length === 2);
});

test("guided Wayfinder skips human input when an in-scope reversible default is sufficient", async () => {
  const directory = tempDir();
  const fake = fakePiContext(directory);
  const machine = new TrainMachine({ pi: { appendEntry() {}, sendUserMessage() {} }, id: () => "run-guided-wayfinder-autonomy" });
  machine.attachContext(fake.root);

  await machine.start(path.join(repoRoot, "trains/guided-wayfinder/guided-wayfinder.yaml"), {
    goal: "Build the isolated prototype and verify it",
  });
  await machine.acceptHandoff({
    outputs: { mission: { goal: "Build the isolated prototype and verify it", initial_map: "New isolated project" } },
    summary: "Established the project boundary.",
    evidenceRefs: ["test:mission"],
    claimsNotMade: [],
  });
  await machine.onSettled();
  await machine.acceptHandoff({
    outputs: { map: "The project is new and isolated.", frontier: "Implement the local prototype and run its full local checks." },
    summary: "Found routine, reversible work within the goal.",
    evidenceRefs: ["test:frontier"],
    claimsNotMade: [],
  });
  await machine.onSettled();
  await machine.acceptHandoff({
    outputs: {
      briefing: "No human judgement is needed. I will implement the prototype and run the full local test suite.",
      requires_human: false,
      recommended_judgement: "Proceed with the natural path, run the full local suite, and fix in-scope failures.",
    },
    summary: "Applied the autonomy policy to a new isolated project.",
    evidenceRefs: ["test:autonomy-policy"],
    claimsNotMade: [],
  });
  await machine.onSettled();

  assert.equal(machine.status().status, "running");
  assert.equal(machine.status().active?.step, "assess");
  assert.equal(machine.state.history.filter((entry) => entry.type === "human_skipped").length, 1);
  assert.equal(machine.state.history.filter((entry) => entry.type === "human_answer").length, 0);

  await machine.acceptHandoff({
    outputs: { result: { accepted: true, feedback: "The default is in scope and its verification is explicit." } },
    summary: "Accepted the autonomous recommendation.",
    evidenceRefs: ["test:autonomy-review"],
    claimsNotMade: [],
  });
  await machine.onSettled();
  await machine.acceptHandoff({
    outputs: { fix_plan: "Implement the prototype and run all relevant local checks." },
    summary: "Planned routine project work.",
    evidenceRefs: ["test:autonomy-fix"],
    claimsNotMade: [],
  });
  await machine.onSettled();
  await machine.acceptHandoff({
    outputs: { result: { stop: true, next_map: "Prototype and checks complete", next_frontier: null } },
    summary: "Verified the local goal.",
    evidenceRefs: ["test:autonomy-complete"],
    claimsNotMade: [],
  });
  await machine.onSettled();

  assert.equal(machine.status().status, "completed");
});

test("replacement-session extension instance restores state before settling a car", async () => {
  const directory = tempDir();
  const trainPath = writeTrain(directory, "single.yaml", [
    "id: single",
    "steps:",
    "  first:",
    "    inputs:",
    "      request: {doc: Work request.}",
    "    procedure:",
    "      - Produce the first result.",
    "    outputs:",
    "      result:",
    "        doc: First result.",
    "        acceptance: [The result is concrete.]",
  ].join("\n"));
  const fake = fakePiContext(directory);
  const firstMachine = new TrainMachine({ pi: { appendEntry() {}, sendUserMessage() {} }, id: () => "run-replacement" });
  firstMachine.attachContext(fake.root);
  await firstMachine.start(trainPath, { request: "ship it" });
  await firstMachine.acceptHandoff({
    outputs: { result: "first-result" },
    summary: "Produced the first result.",
    evidenceRefs: ["test:first"],
    claimsNotMade: [],
  });

  const replacementMachine = new TrainMachine({ pi: { appendEntry() {}, sendUserMessage() {} }, id: () => "unused" });
  replacementMachine.attachContext(fake.sessions[1]);
  assert.equal(replacementMachine.state, null);
  await replacementMachine.onSettled(fake.sessions[1]);

  assert.equal(replacementMachine.status().status, "completed");
  assert.deepEqual(replacementMachine.state.outputs, { result: "first-result" });
});

test("native extension carries repeat feedback and nested outputs through frames", async () => {
  const directory = tempDir();
  const childPath = writeTrain(directory, "child.yaml", `
id: child
steps:
  resolve:
    inputs:
      seed: {doc: Seed.}
      previous: {doc: Optional previous result.}
    procedure:
      - Resolve the seed.
    outputs:
      result:
        doc: Resolution.
        acceptance: [The resolution is explicit.]
`);
  const parentPath = writeTrain(directory, "parent.yaml", `
id: parent
steps:
  improve:
    inputs:
      seed: {doc: Seed.}
    procedure:
      ref: ./child.yaml
    repeat:
      inputs:
        previous: {ref: result}
      until: {ref: result.accepted}
    outputs:
      result: {ref: resolve.result}
`);
  const fake = fakePiContext(directory);
  const machine = new TrainMachine({ pi: { appendEntry() {}, sendUserMessage() {} }, id: () => "run-2" });
  machine.attachContext(fake.root);

  await machine.start(parentPath, { seed: "seed" });
  assert.equal(machine.status().active.step, "resolve");
  await machine.acceptHandoff({
    outputs: { result: { accepted: false, text: "try again" } },
    summary: "The first pass needs another iteration.",
    evidenceRefs: ["test:first-pass"],
    claimsNotMade: [],
  });
  await machine.onSettled();
  assert.equal(machine.status().active.step, "resolve");
  assert.equal(machine.state.frames[0].steps.improve.iteration, 2, "the repeat belongs to the parent car");
  assert.equal(machine.state.frames.length, 2, "the repeated nested car has a child call frame");
  assert.match(fake.prompts.at(-1).text, /try again/);

  await machine.acceptHandoff({
    outputs: { result: { accepted: true, text: "done" } },
    summary: "The second pass is accepted.",
    evidenceRefs: ["test:second-pass"],
    claimsNotMade: [],
  });
  await machine.onSettled();
  assert.equal(machine.status().status, "completed");
  assert.deepEqual(machine.state.outputs, { result: { accepted: true, text: "done" } });
  assert.ok(machine.state.history.some((entry) => entry.type === "car_handoff" && entry.accepted === false));
  assert.ok(loadTrain(parentPath).nested.has("improve"));
});

test("resume extends an exhausted repeat budget in a bounded, persisted increment", async () => {
  const directory = tempDir();
  const childPath = writeTrain(directory, "child.yaml", `
id: child
steps:
  work:
    inputs:
      seed: {doc: Seed.}
      previous: {doc: Optional previous result.}
    procedure: [Produce a result.]
    outputs:
      result:
        doc: Result.
        acceptance: [The result is explicit.]
`);
  const parentPath = writeTrain(directory, "parent.yaml", `
id: parent
steps:
  loop:
    inputs:
      seed: {doc: Seed.}
    procedure: {ref: ./child.yaml}
    repeat:
      inputs:
        previous: {ref: result}
      until: {ref: result.stop}
    outputs:
      result: {ref: work.result}
`);
  const fake = fakePiContext(directory);
  const machine = new TrainMachine({ pi: { appendEntry() {}, sendUserMessage() {} }, maxIterations: 1 });
  machine.attachContext(fake.root);
  await machine.start(parentPath, { seed: "seed" });
  await machine.acceptHandoff({ outputs: { result: { stop: false } }, summary: "Continue the loop.", evidenceRefs: [], claimsNotMade: [] });
  await machine.onSettled();

  assert.equal(machine.state.status, "blocked");
  assert.equal(machine.state.blockedReason, "Car loop exceeded maxIterations=1");
  assert.equal(machine.state.frames.length, 2, "completed child frame remains available for continuation");

  await machine.resume();
  assert.equal(machine.state.maxIterations, 5, "resume adds one bounded four-iteration increment");
  assert.ok(machine.state.history.some((entry) => entry.type === "repeat_budget_extended" && entry.newLimit === 5));
  assert.equal(machine.status().active.step, "work");

  await machine.acceptHandoff({ outputs: { result: { stop: true } }, summary: "The loop condition is satisfied.", evidenceRefs: [], claimsNotMade: [] });
  await machine.onSettled();
  assert.equal(machine.state.status, "completed");
});

test("missing nested repeat boolean keeps its frame and can be repaired", async () => {
  const directory = tempDir();
  writeTrain(directory, "child.yaml", `
id: child
steps:
  work:
    inputs:
      seed: {doc: Seed.}
      previous: {doc: Optional previous result.}
    procedure: [Produce a result.]
    outputs:
      result:
        doc: Result.
        acceptance: [The result is explicit.]
`);
  const parentPath = writeTrain(directory, "parent.yaml", `
id: parent
steps:
  loop:
    inputs:
      seed: {doc: Seed.}
    procedure: {ref: ./child.yaml}
    repeat:
      inputs:
        previous: {ref: result}
      until: {ref: result.stop}
    outputs:
      result: {ref: work.result}
`);
  const fake = fakePiContext(directory);
  const machine = new TrainMachine({ pi: { appendEntry() {}, sendUserMessage() {} } });
  machine.attachContext(fake.root);
  await machine.start(parentPath, { seed: "seed" });
  await machine.acceptHandoff({ outputs: { result: { text: "pending" } }, summary: "Pending", evidenceRefs: [], claimsNotMade: [] });
  await machine.onSettled();
  assert.equal(machine.state.status, "blocked");
  assert.equal(machine.state.frames.length, 2, "child frame survives the failed repeat check");
  await machine.repairMissingRepeatBoolean(false);
  assert.equal(machine.state.status, "running");
  assert.equal(machine.state.frames[0].steps.loop.iteration, 2);
  assert.equal(machine.state.frames[0].steps.loop.lastOutputs.result.stop, false);
  assert.equal(machine.status().active.step, "work");
});

test("extension registers Pi-native commands and the terminating handoff tool", () => {
  const tools = new Map();
  const commands = new Map();
  const pi = {
    registerTool(definition) { tools.set(definition.name, definition); },
    registerCommand(name, definition) { commands.set(name, definition); },
    on() {},
  };
  createTrainExtension()(pi);
  assert.ok(tools.has("train_handoff"));
  assert.deepEqual(tools.get("train_handoff").parameters.required, ["outputs", "summary", "evidenceRefs", "claimsNotMade"]);
  assert.match(tools.get("train_handoff").promptGuidelines[0], /top-level summary/);
  for (const name of ["train", "train-status", "train-answer", "train-advance", "train-steer", "train-pause", "train-resume", "train-repair-repeat", "train-cancel"]) assert.ok(commands.has(name), name);
});
