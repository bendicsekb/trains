#!/usr/bin/env node

import crypto from "node:crypto";
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

export function buildCandidateDefinition(report, { sourceReport, sourceSha256 }) {
  const extracted = report.extractedWorkflow;
  if (!report.topic?.name || !Array.isArray(extracted?.steps) || extracted.steps.length === 0) {
    throw new Error("semantic extraction report does not contain a workflow candidate");
  }
  if (extracted.status !== "candidate_observed_not_validated") {
    throw new Error(`unsupported extracted workflow status: ${extracted.status}`);
  }

  const ids = extracted.steps.map(stepId);
  const steps = extracted.steps.map((step, index) => {
    const supportCount = step.supportCount ?? step.iterationOrBoundedFollowUpSupportCount;
    if (!Number.isInteger(supportCount) || supportCount < 1) {
      throw new Error(`invalid support count for extracted step ${step.step}`);
    }
    return {
      id: ids[index],
      name: step.name,
      needs: index === 0 ? [] : [ids[index - 1]],
      procedure: [step.observedBehavior],
      evidence: {
        supportCount,
        supportDossiers: step.supportDossiers ?? step.iterationOrBoundedFollowUpDossiers ?? [],
      },
      acceptance: [
        index === extracted.steps.length - 1
          ? "The terminal decision and its claim boundary are explicit."
          : "The output and remaining unknowns are explicit before the next step begins.",
      ],
    };
  });

  return {
    version: "0.1.0",
    kind: "train",
    id: slugify(report.topic.name),
    name: report.topic.name,
    status: "candidate",
    maturity: "observed_not_validated",
    purpose: report.topic.statement,
    scope: report.topic.scope,
    provenance: {
      sourceReport,
      sourceSha256,
      parentRunId: report.parentRunId,
      sourceDossierCount: report.topic.sourceDossierCount,
      selectedHumanMessages: report.stats?.selectedSessionMetadataTotals?.humanMessages,
      extractionStatus: extracted.status,
    },
    inputs: {
      intent: { type: "string", required: true },
      constraints: { type: "object", required: false, default: {} },
      currentState: { type: "artifact-set", required: true },
      evidenceBoundary: { type: "object", required: true },
    },
    outputs: {
      scopedResult: { type: "artifact" },
      verificationRecord: { type: "artifact" },
      durableStateUpdate: { type: "artifact" },
      decision: { type: "enum", values: ["repeat", "stop", "accept_scoped_claim"] },
    },
    steps,
    routing: {
      sequential: ids,
      terminal: {
        repeat: ids[1] ?? ids[0],
        stop: "complete",
        accept_scoped_claim: "complete",
      },
    },
    claimBoundary: {
      mayClaim: [
        "The workflow is a versioned candidate observed in the declared development dossiers.",
        "Individual steps have the support counts recorded in this definition.",
      ],
      mayNotClaim: [
        "The workflow is converged, causally superior, or proven to improve task success.",
        "Historical process traces establish user value or product success.",
      ],
    },
    validation: {
      extraction: "verified_before_registry_promotion",
      backtestMode: "observational_trace_not_replay",
      backtestStatus: "insufficient_evidence",
      convergence: "not_converged",
      holdout: "sealed",
    },
    newObservedPatterns: (report.newFromSessions ?? []).map((pattern) => ({
      pattern: pattern.pattern,
      supportCount: pattern.supportCount,
      supportDossiers: pattern.supportDossiers,
    })),
    openQuestions: report.unknowns ?? [],
  };
}

export function defineCandidateFromReport({ projectDir, reportPath, outputPath }) {
  const absoluteReport = path.resolve(reportPath);
  const bytes = fs.readFileSync(absoluteReport);
  const report = JSON.parse(bytes.toString("utf8"));
  const candidate = buildCandidateDefinition(report, {
    sourceReport: path.relative(projectDir, absoluteReport),
    sourceSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  });
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
