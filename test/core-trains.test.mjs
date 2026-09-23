import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadTrain } from "../src/train-definition.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("core trains are stored under trains and parse with their declared interfaces", () => {
  const sessionPatterns = loadTrain(path.join(repoRoot, "trains/session-pattern-extraction/session-pattern-extraction.yaml"));
  const processObservability = loadTrain(path.join(repoRoot, "trains/agent-process-observability/agent-process-observability.yaml"));

  assert.equal(sessionPatterns.definition.id, "session-pattern-extraction");
  assert.deepEqual(sessionPatterns.interfaceInputs, ["sessions", "target", "constraints"]);
  assert.ok(sessionPatterns.nested.has("iterate"));

  assert.equal(processObservability.definition.id, "agent-process-observability");
  assert.deepEqual(processObservability.interfaceInputs, ["sessions", "target", "constraints"]);
  assert.deepEqual(processObservability.finalOutputs, [{ stepId: "evaluate", outputId: "evaluation" }]);
});
