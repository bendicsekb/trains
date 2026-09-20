import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadTrain } from "../src/train-definition.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("slow-loop workflow preserves the book-to-change handoff chain", () => {
  const train = loadTrain(path.join(repoRoot, "workflows/slow-loop.yaml"));

  assert.deepEqual(train.interfaceInputs, ["book"]);
  assert.deepEqual(Object.keys(train.definition.steps), [
    "inspect_code",
    "match_concepts",
    "define_tests",
    "implement",
  ]);
  assert.deepEqual(train.finalOutputs, [{ stepId: "implement", outputId: "revision" }]);
  assert.equal(train.definition.steps.inspect_code.inputs.book.doc, "One engineering book or body of knowledge to use as the inspection lens for the target codebase.");
  assert.ok(train.definition.steps.inspect_code.outputs.book);
  assert.equal(train.definition.steps.match_concepts.inputs.book.ref, "inspect_code.book");
  assert.equal(train.definition.steps.match_concepts.inputs.candidates.ref, "inspect_code.candidates");
  assert.equal(train.definition.steps.define_tests.inputs.mappings.ref, "match_concepts.mappings");
  assert.equal(train.definition.steps.implement.inputs.tests.ref, "define_tests.tests");

  for (const step of Object.values(train.definition.steps)) {
    for (const output of Object.values(step.outputs)) {
      assert.ok(output.acceptance?.length, "every workflow output has acceptance checks");
    }
  }
});
