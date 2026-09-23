import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadTrain } from "../src/train-definition.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("core trains are stored under trains and parse with their declared interfaces", () => {
  const candidateDiscovery = loadTrain(path.join(repoRoot, "trains/discover-candidate-trains/discover-candidate-trains.yaml"));
  const trainImprovement = loadTrain(path.join(repoRoot, "trains/improve-train/improve-train.yaml"));

  assert.equal(candidateDiscovery.definition.id, "discover-candidate-trains");
  assert.deepEqual(candidateDiscovery.interfaceInputs, ["sessions", "target", "constraints"]);
  assert.ok(candidateDiscovery.nested.has("iterate"));

  assert.equal(trainImprovement.definition.id, "improve-train");
  assert.deepEqual(trainImprovement.interfaceInputs, ["sessions", "target", "constraints"]);
  assert.deepEqual(trainImprovement.finalOutputs, [{ stepId: "evaluate", outputId: "evaluation" }]);
});
