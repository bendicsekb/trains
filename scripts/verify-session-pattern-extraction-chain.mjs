#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function value(argv, flag, fallback) {
  const index = argv.indexOf(flag);
  return index === -1 ? fallback : argv[index + 1];
}

const argv = process.argv.slice(2);
const contractPath = value(argv, "--contract");
if (!contractPath) {
  console.error("Usage: verify-session-pattern-extraction-chain.mjs --contract <contract.json>");
  process.exit(2);
}

const resolvedContractPath = path.resolve(contractPath);
const contract = JSON.parse(fs.readFileSync(resolvedContractPath, "utf8"));
const runDir = path.dirname(resolvedContractPath);
const chainDir = path.join(runDir, "chain");
const failures = [];
const checks = [];

function check(id, ok, details) {
  checks.push({ id, ok, details });
  if (!ok) failures.push(`${id}: ${details}`);
}

check("contract-schema", contract.schemaVersion === 1 && Array.isArray(contract.acceptance) && contract.acceptance.length === 7, "master contract schema and seven acceptance checks");
check("fresh-context-contract", contract.metadata?.freshContextPerStep === true, "master contract requires fresh contexts per step");
check("handoff-only-contract", contract.metadata?.handoffOnlyContextTransfer === true, "master contract requires handoff-only context transfer");

const manifestPath = path.join(chainDir, "chain-manifest.json");
if (!fs.existsSync(manifestPath)) {
  check("chain-manifest", false, `missing ${manifestPath}`);
} else {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  check("chain-manifest", manifest.runId === contract.runId && manifest.stages?.length === 6, "six stages and matching run id");
  check("context-boundary", manifest.contextBoundary === "one fresh Pi --no-session process per train step; only declared JSON handoffs cross steps", "manifest records fresh-process/handoff-only boundary");
}

const initialHandoffPath = path.join(chainDir, "00-initial-handoff.json");
check("initial-handoff", fs.existsSync(initialHandoffPath), "initial input handoff exists");

const stepsRoot = path.join(chainDir, "steps");
const stepDirs = fs.existsSync(stepsRoot)
  ? fs.readdirSync(stepsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(stepsRoot, entry.name)).sort()
  : [];
for (const stepDir of stepDirs) {
  const stepContractPath = path.join(stepDir, "contract.json");
  const handoffPath = path.join(stepDir, "handoff.json");
  check(`step-contract:${path.basename(stepDir)}`, fs.existsSync(stepContractPath), "step contract exists");
  if (!fs.existsSync(stepContractPath)) continue;
  const stepContract = JSON.parse(fs.readFileSync(stepContractPath, "utf8"));
  check(`step-fresh-context:${stepContract.runId}`, stepContract.metadata?.freshContext === true && stepContract.metadata?.handoffInput !== undefined, "fresh context and declared input handoff");
  check(`step-no-session:${stepContract.runId}`, fs.existsSync(path.join(stepDir, "events.ndjson"))
    ? fs.readFileSync(path.join(stepDir, "events.ndjson"), "utf8").includes('"--no-session"')
    : true, "Pi launch includes --no-session when events exist");
  check(`handoff:${stepContract.runId}`, fs.existsSync(handoffPath), "handoff exists");
  if (!fs.existsSync(handoffPath)) continue;
  let handoff;
  try {
    handoff = JSON.parse(fs.readFileSync(handoffPath, "utf8"));
  } catch (error) {
    check(`handoff-json:${stepContract.runId}`, false, error.message);
    continue;
  }
  const required = ["schemaVersion", "runId", "step", "status", "inputsRead", "outputsWritten", "evidenceRefs", "decisions", "openQuestions", "nextStep", "claimsNotMade"];
  check(`handoff-fields:${stepContract.runId}`, required.every((field) => field in handoff), "all required handoff fields exist");
  check(`handoff-identity:${stepContract.runId}`, handoff.schemaVersion === 1 && handoff.runId === stepContract.runId && handoff.step === stepContract.metadata.stage, "handoff identity matches its step contract");
  check(`handoff-paths:${stepContract.runId}`, [...(handoff.inputsRead ?? []), ...(handoff.outputsWritten ?? [])].every((entry) => typeof entry === "string" && !path.isAbsolute(entry) && !entry.split(path.sep).includes("..")), "handoff paths are relative and contained");
  if (stepContract.metadata.stage === "loop-until-converged") {
    check(`convergence:${stepContract.runId}`, ["continue", "converged", "insufficient_evidence", "max_iterations_exceeded", "unsafe", "overfit"].includes(handoff.convergence?.status), "convergence status is declared");
  }
}

const resultPath = path.join(chainDir, "chain-result.json");
if (fs.existsSync(resultPath)) {
  const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  check("chain-result", result.runId === contract.runId && typeof result.status === "string" && Array.isArray(result.stages), "chain result is structurally valid");
  check("result-boundary", result.contextBoundary === "fresh Pi --no-session process per stage; inter-stage state crosses only through declared JSON handoffs", "chain result records context boundary");
}

const output = { overall_pass: failures.length === 0, checks, failure_count: failures.length, failures };
console.log(JSON.stringify(output, null, 2));
process.exitCode = failures.length === 0 ? 0 : 1;
