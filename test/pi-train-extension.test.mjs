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

test("guided Wayfinder retries teaching and human judgement until the review accepts it", async () => {
  const directory = tempDir();
  const fake = fakePiContext(directory);
  const machine = new TrainMachine({ pi: { appendEntry() {}, sendUserMessage() {} }, id: () => "run-guided-wayfinder" });
  machine.attachContext(fake.root);

  await machine.start(path.join(repoRoot, "trains/guided-wayfinder/guided-wayfinder.yaml"), {
    goal: "Reach the goal",
    current_system: "Partial system description",
    blockers: "Unknown integration boundary",
    constraints: "Keep changes reversible",
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
    outputs: { briefing: "Teaching: these are the two boundary options and their trade-offs." },
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
    outputs: { briefing: "Teaching again: option A is reversible; option B is faster but irreversible." },
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
  for (const name of ["train", "train-status", "train-answer", "train-advance", "train-steer", "train-pause", "train-resume", "train-cancel"]) assert.ok(commands.has(name), name);
});
