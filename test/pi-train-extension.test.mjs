import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

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
  for (const name of ["train", "train-status", "train-advance", "train-steer", "train-pause", "train-resume", "train-cancel"]) assert.ok(commands.has(name), name);
});

test("train start refuses a teaching session in the same Pi conversation", async () => {
  const directory = tempDir();
  const trainPath = writeTrain(directory, "blocked.yaml", `
id: blocked
steps:
  first:
    inputs:
      request: {doc: Work request.}
    procedure:
      - Produce a result.
    outputs:
      result: {doc: Result.}
`);
  const fake = fakePiContext(directory);
  fake.root.sessionManager.getEntries().push({
    type: "custom",
    customType: "teaching.session.v1",
    data: { status: "active", id: "teaching-1" },
  });
  const machine = new TrainMachine({ pi: { appendEntry() {}, sendUserMessage() {} } });
  machine.attachContext(fake.root);
  assert.throws(() => machine.start(trainPath, { request: "ship it" }), /teaching session is active/);
});
