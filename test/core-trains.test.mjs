import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadTrain } from "../src/train-definition.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("core trains are stored under trains and parse with their declared interfaces", () => {
  const candidateDiscovery = loadTrain(path.join(repoRoot, "trains/discover-candidate-trains/discover-candidate-trains.yaml"));
  const trainImprovement = loadTrain(path.join(repoRoot, "trains/improve-train/improve-train.yaml"));
  const guidedWayfinder = loadTrain(path.join(repoRoot, "trains/guided-wayfinder/guided-wayfinder.yaml"));

  assert.equal(candidateDiscovery.definition.id, "discover-candidate-trains");
  assert.deepEqual(candidateDiscovery.interfaceInputs, ["sessions", "target", "constraints"]);
  assert.ok(candidateDiscovery.nested.has("iterate"));

  assert.equal(trainImprovement.definition.id, "improve-train");
  assert.deepEqual(trainImprovement.interfaceInputs, ["sessions", "target", "constraints"]);
  assert.deepEqual(trainImprovement.finalOutputs, [{ stepId: "evaluate", outputId: "evaluation" }]);

  assert.equal(guidedWayfinder.definition.id, "guided-wayfinder");
  assert.deepEqual(guidedWayfinder.interfaceInputs, ["goal"]);
  const sharedWayfinder = loadTrain(path.join(repoRoot, "trains/guided-wayfinder/guided-wayfinder-shared.yaml"));
  assert.deepEqual(sharedWayfinder.interfaceInputs, ["goal"]);
  assert.equal(sharedWayfinder.definition.session, "shared");
  assert.ok(guidedWayfinder.nested.has("wayfind"));
  assert.deepEqual(guidedWayfinder.finalOutputs, [{ stepId: "wayfind", outputId: "result" }]);
  assert.deepEqual(Object.keys(guidedWayfinder.nested.get("wayfind").definition.steps), [
    "explore",
    "decision",
    "fix",
    "explore_next",
  ]);
  const judgement = guidedWayfinder.nested.get("wayfind").nested.get("decision");
  assert.deepEqual(Object.keys(judgement.definition.steps), ["teach", "decide", "assess"]);
  assert.deepEqual(judgement.definition.steps.decide.human.prompt, { ref: "teach.briefing" });
  assert.deepEqual(judgement.definition.steps.decide.human.when, { ref: "teach.requires_human" });
  assert.deepEqual(judgement.definition.steps.decide.human.otherwise, { judgement: { ref: "teach.recommended_judgement" } });
  assert.equal(judgement.definition.steps.assess.outputs.result.doc.includes("accepted"), true);
});
