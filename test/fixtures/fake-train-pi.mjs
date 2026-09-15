#!/usr/bin/env node

import fs from "node:fs";
import readline from "node:readline";

const failMarker = process.env.FAKE_TRAIN_FAIL_ONCE;
if (failMarker && !fs.existsSync(failMarker)) {
  fs.writeFileSync(failMarker, "failed\n");
  process.stderr.write("fake train worker failed once\n");
  process.exit(1);
}

console.log(JSON.stringify({ type: "agent_start" }));
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  const request = JSON.parse(line);
  if (request.type !== "prompt") continue;
  const prompt = request.message;
  const runId = prompt.match(/^Run: (.+)$/m)?.[1];
  const trainId = prompt.match(/of train ([^\s.]+)/)?.[1];
  const step = prompt.match(/Execute car ([^\s]+) of train/)?.[1];
  const invocationId = prompt.match(/^Invocation: (.+)$/m)?.[1];
  const handoffPath = prompt.match(/Write exactly one JSON handoff to: (.+)$/m)?.[1];
  const outputNames = (prompt.match(/^Expected output names: (.+)$/m)?.[1] ?? "").split(", ").filter(Boolean);
  const outputs = {};
  for (const name of outputNames) {
    if (name === "brief") outputs[name] = { text: "declared brief" };
    else if (name === "result") outputs[name] = { accepted: /-i2-/.test(invocationId ?? "") || /child|work/.test(step ?? ""), value: `result-${step}` };
    else outputs[name] = { accepted: true, value: `${name}-${step}` };
  }
  fs.writeFileSync(handoffPath, `${JSON.stringify({
    schemaVersion: 1,
    runId,
    trainId,
    step,
    invocationId,
    status: "ready_for_verification",
    inputsRead: [],
    outputs,
    evidenceRefs: [handoffPath],
    decisions: [],
    openQuestions: [],
    claimsNotMade: ["overall train completion"],
  }, null, 2)}\n`);
  console.log(JSON.stringify({ type: "agent_end", messages: [] }));
  break;
}
