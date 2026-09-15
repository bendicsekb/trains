import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { TrainValidationError, loadTrain, runTrain } from "../src/trains-runner.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fakePi = path.join(repoRoot, "test/fixtures/fake-train-pi.mjs");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "trains-runner-"));
}

function write(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
}

function workerOptions(extra = {}) {
  return {
    workerCommand: process.execPath,
    workerArgs: [fakePi],
    stallMs: 500,
    maxRuntimeMs: 5000,
    ...extra,
  };
}

test("loader enforces the lean train contract and rejects legacy top-level repeat", () => {
  const directory = tempDir();
  const invalid = path.join(directory, "invalid.yaml");
  write(invalid, `id: invalid\nrepeat: {}\nsteps:\n  only:\n    inputs:\n      request: {doc: Request}\n    procedure: [Do work]\n    outputs:\n      result:\n        doc: Result\n        acceptance: [Result exists]\n`);
  assert.throws(() => loadTrain(invalid), (error) => error instanceof TrainValidationError && /unknown root field repeat/.test(error.message));
});

test("loader rejects missing refs and repeat input collisions", () => {
  const directory = tempDir();
  const invalid = path.join(directory, "invalid-refs.yaml");
  write(invalid, `id: invalid-refs\nsteps:\n  only:\n    inputs:\n      request: {doc: Request}\n      missing: {ref: nowhere.result}\n    procedure: [Do work]\n    repeat:\n      inputs:\n        request: {ref: only.result}\n      until: {ref: result.accepted}\n    outputs:\n      result:\n        doc: Result\n        acceptance: [Result exists]\n`);
  assert.throws(() => loadTrain(invalid), (error) => error instanceof TrainValidationError
    && /unknown step nowhere/.test(error.message)
    && /would overwrite an ordinary input/.test(error.message));
});

test("runner executes a linear graph, validates fresh Pi handoffs, and repeats one car with explicit feedback", async () => {
  const directory = tempDir();
  const trainPath = path.join(directory, "repeat.yaml");
  write(trainPath, `id: repeat-demo\nsteps:\n  seed:\n    inputs:\n      request: {doc: User request}\n    procedure:\n      - Create a bounded brief.\n    outputs:\n      brief:\n        doc: Brief\n        acceptance:\n          - Brief exists.\n  iterate:\n    inputs:\n      brief: {ref: seed.brief}\n    procedure:\n      - Improve the result using the brief.\n    repeat:\n      inputs:\n        previous: {ref: result}\n      until: {ref: result.accepted}\n    outputs:\n      result:\n        doc: Result\n        acceptance:\n          - Result is accepted.\n`);
  const runDir = path.join(directory, "run");
  const result = await runTrain({ ...workerOptions(), trainPath, inputs: { request: "ship a prototype" }, runDir });
  assert.deepEqual(result.outputs.result, { accepted: true, value: "result-iterate" });
  const state = JSON.parse(fs.readFileSync(path.join(runDir, "state.json"), "utf8"));
  assert.equal(state.status, "completed");
  assert.equal(state.steps.iterate.invocations.length, 2);
  assert.equal(state.steps.iterate.status, "completed");
  const events = fs.readFileSync(path.join(runDir, "events.ndjson"), "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(events.some((event) => event.type === "invocation_started" && event.payload.iteration === 2));
});

test("runner composes a nested train and resolves child outputs through the call frame", async () => {
  const directory = tempDir();
  write(path.join(directory, "child.yaml"), `id: child-demo\nsteps:\n  work:\n    inputs:\n      brief: {doc: Brief from parent}\n    procedure:\n      - Produce a child result.\n    outputs:\n      result:\n        doc: Child result\n        acceptance:\n          - Child result exists.\n`);
  const parentPath = path.join(directory, "parent.yaml");
  write(parentPath, `id: parent-demo\nsteps:\n  seed:\n    inputs:\n      request: {doc: Request}\n    procedure: [Create a brief.]\n    outputs:\n      brief:\n        doc: Brief\n        acceptance: [Brief exists.]\n  child:\n    inputs:\n      brief: {ref: seed.brief}\n    procedure:\n      ref: ./child.yaml\n    outputs:\n      result: {ref: work.result}\n`);
  const result = await runTrain({ ...workerOptions(), trainPath: parentPath, inputs: { request: "compose" }, runDir: path.join(directory, "run") });
  assert.deepEqual(result.outputs.result, { accepted: true, value: "result-work" });
  assert.ok(fs.existsSync(path.join(directory, "run/nested/child/iteration-1/state.json")));
});

test("runner restarts an interrupted car from durable state without discarding completed handoffs", async () => {
  const directory = tempDir();
  const trainPath = path.join(directory, "restart.yaml");
  write(trainPath, `id: restart-demo\nsteps:\n  only:\n    inputs:\n      request: {doc: Request}\n    procedure: [Do work.]\n    outputs:\n      result:\n        doc: Result\n        acceptance: [Result exists.]\n`);
  const runDir = path.join(directory, "run");
  const marker = path.join(directory, "fail-once");
  await assert.rejects(() => runTrain({ ...workerOptions({ workerEnv: { FAKE_TRAIN_FAIL_ONCE: marker } }), trainPath, inputs: { request: "restart" }, runDir }), /did not complete/);
  const failedState = JSON.parse(fs.readFileSync(path.join(runDir, "state.json"), "utf8"));
  assert.equal(failedState.status, "failed");
  const result = await runTrain({ ...workerOptions(), trainPath, inputs: { request: "restart" }, runDir });
  assert.equal(result.state.status, "completed");
  assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, "state.json"), "utf8")).steps.only.status, "completed");
});
