#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function value(argv, flag, fallback) {
  const index = argv.indexOf(flag);
  return index === -1 ? fallback : argv[index + 1];
}

function slugify(input) {
  return String(input)
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function stepId(step) {
  const concise = String(step.name)
    .replace(/^(frame|inspect|execute|observe|classify|intervene|update|repeat)\b.*$/i, "$1");
  return `${String(step.step).padStart(2, "0")}-${slugify(concise || step.name)}`;
}

function scalar(value) {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return JSON.stringify(String(value));
}

function yamlKey(key) {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) ? key : JSON.stringify(key);
}

function compactBinding(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length !== 1 || !["doc", "ref"].includes(entries[0][0])) return null;
  const [key, item] = entries[0];
  if (item !== null && typeof item === "object") {
    if (!Array.isArray(item) && Object.keys(item).length === 0) return `{${key}: {}}`;
    return null;
  }
  return `{${key}: ${scalar(item)}}`;
}

function yamlLines(value, indent = 0) {
  const prefix = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${prefix}[]`];
    return value.flatMap((item) => {
      if (item !== null && typeof item === "object") {
        const nested = yamlLines(item, indent + 2);
        return [`${prefix}-`, ...nested];
      }
      return [`${prefix}- ${scalar(item)}`];
    });
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    if (entries.length === 0) return [`${prefix}{}`];
    return entries.flatMap(([key, item]) => {
      if (item !== null && typeof item === "object") {
        const compact = compactBinding(item);
        if (compact) return [`${prefix}${yamlKey(key)}: ${compact}`];
        const empty = Array.isArray(item) ? item.length === 0 : Object.keys(item).length === 0;
        if (empty) return [`${prefix}${yamlKey(key)}: ${Array.isArray(item) ? "[]" : "{}"}`];
        return [`${prefix}${yamlKey(key)}:`, ...yamlLines(item, indent + 2)];
      }
      return [`${prefix}${yamlKey(key)}: ${scalar(item)}`];
    });
  }
  return [`${prefix}${scalar(value)}`];
}

export function renderCandidateYaml(candidate) {
  return `${yamlLines(candidate).join("\n")}\n`;
}

export function buildCandidateDefinition(report) {
  const extracted = report.extractedWorkflow;
  if (!report.topic?.name || !Array.isArray(extracted?.steps) || extracted.steps.length === 0) {
    throw new Error("semantic extraction report does not contain a workflow candidate");
  }
  if (extracted.status !== "candidate_observed_not_validated") {
    throw new Error(`unsupported extracted workflow status: ${extracted.status}`);
  }

  const ids = extracted.steps.map(stepId).map((id) => id.replace(/^\d+-/, ""));
  const outputNames = ["frame", "next_action", "scoped_result", "verification", "classification", "intervention", "durable_state", "decision"];
  const outputDocs = [
    "Intent, constraints, uncertainty, work mode, and evidence boundary.",
    "Bounded next action and stop conditions.",
    "Result of the scoped execution.",
    "Observed evidence from the relevant boundaries.",
    "Classified result, mismatch, or failure.",
    "Smallest evidence-backed change, route, check, or stop.",
    "Updated artifacts, decisions, unknowns, and acceptance state.",
    "Repeat, stop, or accept_scoped_claim.",
  ];
  const acceptance = [
    "Intent, constraints, uncertainty, work mode, and evidence boundary are explicit.",
    "The next action is bounded and its stop conditions are explicit.",
    "Execution stays within scope and preserves required provenance and rollback.",
    "Relevant positive, negative, runtime, and external boundaries are checked without broadening the claim.",
    "Blocked, partial, interrupted, and failed results retain their actual classification.",
    "The response is the smallest change, route, check, or stop supported by evidence.",
    "Artifacts, decisions, unknowns, and acceptance state are durable and remain distinguishable.",
    "The decision is repeat, stop, or accept_scoped_claim, and any accepted claim stays within the evidence boundary.",
  ];
  const steps = Object.fromEntries(extracted.steps.map((step, index) => {
    const supportCount = step.supportCount ?? step.iterationOrBoundedFollowUpSupportCount;
    if (!Number.isInteger(supportCount) || supportCount < 1) throw new Error(`invalid support count for extracted step ${step.step}`);
    const previousOutput = index === 0 ? null : outputNames[index - 1];
    const inputs = index === 0
      ? {
          intent: { doc: "Requested outcome." },
          constraints: { doc: "Optional safety, scope, and environment constraints." },
          current_state: { doc: "Current source, runtime, data, or operational state." },
          evidence_boundary: { doc: "Evidence that may be inspected and claims it may support." },
        }
      : { [previousOutput]: { ref: `${ids[index - 1]}.${previousOutput}` } };
    const outputs = {
      [outputNames[index]]: {
        doc: outputDocs[index],
        acceptance: [acceptance[index]],
      },
    };
    if (index === 2 || index === 5) {
      outputs.work = {
        ref: "inplace",
        acceptance: ["In-place changes stay within the declared scope."],
      };
    }
    const procedure = `${step.name.replace(/\.$/, "")}.`;
    return [ids[index], {
      inputs,
      procedure: [procedure],
      outputs,
    }];
  }));

  return {
    id: slugify(report.topic.name),
    steps,
  };
}

export function defineCandidateFromReport({ projectDir, reportPath, outputPath }) {
  const absoluteReport = path.resolve(reportPath);
  const bytes = fs.readFileSync(absoluteReport);
  const report = JSON.parse(bytes.toString("utf8"));
  const candidate = buildCandidateDefinition(report);
  const rendered = renderCandidateYaml(candidate);
  ensureDir(path.dirname(outputPath));
  fs.writeFileSync(outputPath, rendered, "utf8");
  return { candidate, rendered };
}

function main() {
  const argv = process.argv.slice(2);
  const reportPath = value(argv, "--report", null);
  const outputPath = value(argv, "--output", null);
  const registryOutput = value(argv, "--registry-output", null);
  const replaceRegistry = value(argv, "--replace-registry", "false") === "true";
  const projectDir = path.resolve(value(argv, "--project-dir", process.cwd()));
  if (!reportPath || !outputPath) {
    throw new Error("Usage: define-semantic-workflow-candidate.mjs --report <workflow-extraction.json> --output <candidate-train.yaml> [--registry-output <workflows/candidates/name.yaml>]");
  }
  const result = defineCandidateFromReport({ projectDir, reportPath, outputPath: path.resolve(outputPath) });
  if (registryOutput) {
    const absoluteRegistryOutput = path.resolve(registryOutput);
    ensureDir(path.dirname(absoluteRegistryOutput));
    if (fs.existsSync(absoluteRegistryOutput)) {
      const existing = fs.readFileSync(absoluteRegistryOutput, "utf8");
      if (existing !== result.rendered && !replaceRegistry) {
        throw new Error(`candidate registry collision; choose a new version/path or pass --replace-registry true explicitly: ${absoluteRegistryOutput}`);
      }
    }
    fs.writeFileSync(absoluteRegistryOutput, result.rendered, "utf8");
  }
  console.log(JSON.stringify({
    ok: true,
    candidateId: result.candidate.id,
    status: result.candidate.status,
    maturity: result.candidate.maturity,
    output: path.resolve(outputPath),
    registryOutput: registryOutput ? path.resolve(registryOutput) : null,
  }, null, 2));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
