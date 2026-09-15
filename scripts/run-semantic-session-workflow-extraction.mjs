#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { loadContract, supervisePi } from "/home/bendi/pi-product-factory/src/supervisor.mjs";
import { buildSessionEvidencePacket } from "./build-session-evidence-packet.mjs";

function value(argv, flag, fallback) {
  const index = argv.indexOf(flag);
  return index === -1 ? fallback : argv[index + 1];
}

function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function relative(projectDir, filePath) {
  return path.relative(projectDir, filePath) || ".";
}

function boundaryCheck(boundary, pattern, safeTextPattern) {
  const entries = Object.entries(boundary ?? {}).filter(([name]) => pattern.test(name));
  const allText = Array.isArray(boundary)
    ? boundary.map((value) => typeof value === "object" ? JSON.stringify(value) : String(value)).join("\n")
    : Object.entries(boundary ?? {}).map(([name, value]) => `${name}: ${String(value)}`).join("\n");
  const lines = allText.split(/[\n.;]+/).filter(Boolean);
  const positive = /\b(?:opened|read|copied|included|accessed|exposed)\b/i;
  const negative = /\b(?:no|not|never|without|did not|was not|were not)\b/i;
  return {
    hasSafe: entries.some(([, value]) => value === false) || safeTextPattern.test(allText) || lines.some((line) => pattern.test(line) && negative.test(line)),
    hasTrue: entries.some(([, value]) => value === true) || lines.some((line) => pattern.test(line) && positive.test(line) && !negative.test(line)),
  };
}

function nextAttempt(runDir, requested) {
  if (requested !== undefined && requested !== null) {
    const value = Number(requested);
    if (!Number.isInteger(value) || value < 1) throw new Error("--attempt must be a positive integer");
    return value;
  }
  let highest = 0;
  if (fs.existsSync(runDir)) {
    for (const entry of fs.readdirSync(runDir, { withFileTypes: true })) {
      const match = /^attempt-(\d+)$/.exec(entry.name);
      if (entry.isDirectory() && match) highest = Math.max(highest, Number(match[1]));
    }
  }
  return highest + 1;
}

function validateDossierHandoff(handoffPath, { expectedRunId, expectedSessionId, dossierPath, evidencePacketPath }) {
  if (!fs.existsSync(handoffPath)) throw new Error(`missing handoff: ${handoffPath}`);
  const handoff = readJson(handoffPath);
  const required = ["schemaVersion", "handoffType", "runId", "sessionId", "status", "dossierPath", "evidencePacketPath", "evidenceReferences", "boundaryChecks", "summary", "unknowns", "intervention"];
  const missing = required.filter((field) => !(field in handoff));
  if (missing.length > 0) throw new Error(`handoff missing fields: ${missing.join(", ")}`);
  if (handoff.schemaVersion !== 1 || handoff.runId !== expectedRunId || handoff.sessionId !== expectedSessionId) {
    throw new Error(`handoff identity mismatch at ${handoffPath}`);
  }
  if (handoff.status !== "ready_for_verification") throw new Error(`dossier handoff is not ready_for_verification: ${handoff.status}`);
  if (path.resolve(handoff.dossierPath) !== path.resolve(dossierPath)) throw new Error(`dossier path mismatch at ${handoffPath}`);
  if (path.resolve(handoff.evidencePacketPath) !== path.resolve(evidencePacketPath)) throw new Error(`evidence packet path mismatch at ${handoffPath}`);
  if (!Array.isArray(handoff.evidenceReferences) || handoff.evidenceReferences.length === 0) throw new Error(`dossier handoff has no evidence references: ${handoffPath}`);
  const boundary = handoff.boundaryChecks;
  const rawSession = boundaryCheck(boundary, /raw.*session|session.*raw/i, /only the declared evidence packet|raw(?:\s+\w+){0,3}\s+session[^\n.;]*\b(?:not|no|never)\b/i);
  const otherSession = boundaryCheck(boundary, /other.*historical.*session|historical.*session.*other|other.*session/i, /only the declared evidence packet|other\s+(?:historical\s+)?sessions?[^\n.;]*\b(?:not|no|never)\b/i);
  const siblingData = boundaryCheck(boundary, /sibling|other.*worker|worker.*artifact|other.*artifact/i, /only the declared evidence packet|(?:sibling|other workers?|worker artifacts?|sibling dossiers?)[^\n.;]*\b(?:not|no|never)\b/i);
  const transcript = boundaryCheck(boundary, /transcript/i, /(?:no|not|never)\b[^\n.;]*(?:full|raw) transcript|(?:full|raw) transcript[^\n.;]*\b(?:not|no|never)\b/i);
  const secrets = boundaryCheck(boundary, /secret/i, /(?:no|not|never)\b[^\n.;]*secret|secret[^\n.;]*\b(?:not|no|never)\b/i);
  const missingBoundaryAssertion = !rawSession.hasSafe || !otherSession.hasSafe || !siblingData.hasSafe || !transcript.hasSafe || !secrets.hasSafe;
  if (rawSession.hasTrue || otherSession.hasTrue || siblingData.hasTrue || transcript.hasTrue || secrets.hasTrue || missingBoundaryAssertion) {
    throw new Error(`dossier handoff violated its declared read boundary: ${handoffPath}`);
  }
  return handoff;
}

function validateAggregatorHandoff(handoffPath, { expectedRunId, dossierPaths }) {
  if (!fs.existsSync(handoffPath)) throw new Error(`missing handoff: ${handoffPath}`);
  const handoff = readJson(handoffPath);
  const required = ["schemaVersion", "handoffType", "runId", "status", "dossierCount", "sourceDossiers", "summary", "unknowns", "intervention"];
  const missing = required.filter((field) => !(field in handoff));
  if (missing.length > 0) throw new Error(`aggregator handoff missing fields: ${missing.join(", ")}`);
  if (handoff.schemaVersion !== 1 || handoff.runId !== expectedRunId) throw new Error(`aggregator handoff identity mismatch at ${handoffPath}`);
  if (handoff.status !== "ready_for_verification") throw new Error(`aggregator handoff is not ready_for_verification: ${handoff.status}`);
  if (handoff.dossierCount !== dossierPaths.length) throw new Error(`aggregator dossier count mismatch at ${handoffPath}`);
  if (!Array.isArray(handoff.sourceDossiers) || handoff.sourceDossiers.length !== dossierPaths.length) throw new Error(`aggregator source dossier list mismatch at ${handoffPath}`);
  return handoff;
}

function selectSessions(interest, maxSessions) {
  const eligible = interest.sessions.filter((session) => (
    session.split === "development"
    && (session.skillUsage.productFactory.matched || session.skillUsage.productFactoryPi.matched)
    && ["likely_building", "possibly_building"].includes(session.building.status)
  ));
  const uniqueGroups = new Set();
  return eligible
    .sort((a, b) => {
      const aPi = a.skillUsage.productFactoryPi.matched ? 1 : 0;
      const bPi = b.skillUsage.productFactoryPi.matched ? 1 : 0;
      const aBuild = a.building.status === "likely_building" ? 1 : 0;
      const bBuild = b.building.status === "likely_building" ? 1 : 0;
      return bPi - aPi || bBuild - aBuild || b.humanMessageCount - a.humanMessageCount || a.sourceReference.localeCompare(b.sourceReference);
    })
    .filter((session) => {
      const group = session.independenceGroup ?? session.id;
      if (uniqueGroups.has(group)) return false;
      uniqueGroups.add(group);
      return true;
    })
    .slice(0, maxSessions);
}

function workerContract({ master, session, index, total, interestPath, evidencePacketPath, dossierPath, handoffPath }) {
  const runId = `${master.runId}-dossier-${String(index + 1).padStart(2, "0")}-${session.id}`;
  return {
    schemaVersion: 1,
    runId,
    package: master.package ?? "trains/session-workflow-extraction",
    createdAt: new Date().toISOString(),
    goal: [
      `You are semantic dossier worker ${index + 1} of ${total} in a bounded session-workflow extraction run.`,
      "This is a fresh Pi context. Read exactly one deterministic bounded evidence packet derived from one declared historical session plus the declared interest metadata; do not open the raw session, read any other historical session, another worker's events, or another worker's dossier.",
      "Analyze what actually happened in this session: the user's problem and topic, whether the work was building, the sequence of product/engineering decisions, evidence and verification, interventions, failures, recovery, and reusable workflow behaviors.",
      "The product-factory/product-factory-pi signal is a discovery hint, not proof that the skill was followed. Separate explicit behavior from mere reference.",
      "Write a bounded semantic dossier as JSON without copying transcript blocks or secrets, then write the required handoff.",
      `Read the evidence packet at ${evidencePacketPath}. Write the dossier to ${dossierPath} and the handoff to ${handoffPath}.`,
      `The exact dossier and handoff runId is ${runId}; copy that value exactly and do not use the parent runId ${master.runId}. The exact sessionId is ${session.id}.`,
      "The handoff must be JSON with schemaVersion 1, handoffType semantic-session-dossier-handoff, the exact runId and sessionId above, status ready_for_verification, dossierPath, evidencePacketPath, non-empty evidenceReferences, boundaryChecks, summary, unknowns, and intervention.",
    ].join(" "),
    projectDir: master.projectDir,
    claimBoundary: {
      mayClaim: [
        "session topic and workflow behavior supported by the declared session transcript",
        "observed building actions, decisions, verification, and interventions",
        "bounded reusable patterns with evidence pointing to session ordinals or timestamps",
      ],
      mayNotClaim: [
        "that a skill was successfully followed merely because its name appears",
        "user value, product success, or workflow generalization from one session",
        "facts from other sessions or hidden agent state",
        "semantic convergence or backtest performance",
      ],
    },
    acceptance: [
      {
        id: "D1",
        statement: `A bounded semantic dossier exists at ${dossierPath} with topic, buildingAssessment, workflowTrace, evidence, unknowns, and claimsNotMade.`,
        verify: `Read ${dossierPath}; validate required sections and confirm no full transcript is copied.`,
      },
      {
        id: "D2",
        statement: `A valid handoff exists at ${handoffPath} and points to the dossier.`,
        verify: `Validate handoff identity, declared paths, and evidence references independently.`,
      },
    ],
    sourceOfTruth: [interestPath, evidencePacketPath],
    nonGoals: [
      "Do not modify source sessions, workflow definitions, or sibling repositories.",
      "Do not emit raw transcript text, secrets, or long quotations.",
      "Do not infer a reusable rule from a single local tactic without marking its scope.",
    ],
    escalationPolicy: [
      "Escalate if the session source is missing, malformed, or cannot be read within the declared boundary.",
      "Escalate if the session contains sensitive material that cannot be safely summarized.",
      "Escalate if the requested claim requires another session or an outcome not present in this session.",
    ],
    metadata: {
      workflowMode: "semantic-session-dossier",
      freshContext: true,
      sessionId: session.id,
      sessionOrdinal: index + 1,
      sourceSession: session.sourceReference,
      evidencePacket: relative(master.projectDir, evidencePacketPath),
      discoverySignals: {
        humanMessageCount: session.humanMessageCount,
        productFactory: session.skillUsage.productFactory.matched,
        productFactoryPi: session.skillUsage.productFactoryPi.matched,
        buildingStatus: session.building.status,
        split: session.split,
      },
      outputDossier: relative(master.projectDir, dossierPath),
      outputHandoff: relative(master.projectDir, handoffPath),
      expectedHandoffRunId: runId,
    },
  };
}

function buildAggregatorContract({ master, runDir, artifactDir, interestPath, dossierPaths, reportJsonPath, reportMarkdownPath, handoffPath, selectedSessions }) {
  const runId = `${master.runId}-aggregator`;
  const priorIdea = "Product work may follow: capture intent/problem and uncertainty; form a hypothesis; choose a cheap test; implement; observe and independently verify; update evidence/state; iterate or ship when the evidence gate passes.";
  return {
    schemaVersion: 1,
    runId,
    package: master.package ?? "trains/session-workflow-extraction",
    createdAt: new Date().toISOString(),
    goal: [
      "You are the fresh aggregator context for a semantic workflow extraction run.",
      "Read only the declared interest index, selected session metadata, and bounded semantic dossiers. Do not reopen raw historical sessions or read worker events/private reasoning.",
      "Extract the common workflow that is actually evidenced across the dossiers. Treat frequency as support, not proof of quality.",
      `Compare the session-derived workflow with this prior idea, without importing any other skill text: ${priorIdea}`,
      "Report the topic, session/building statistics, extracted workflow, new patterns versus matches to the prior idea, contradictions, interventions, evidence gaps, and what would need backtesting.",
      `Write JSON to ${reportJsonPath}, Markdown to ${reportMarkdownPath}, and the required handoff to ${handoffPath}. Do not write the handoff until both report files exist and contain the required sections.`,
      `The exact aggregator handoff runId is ${runId}; copy it exactly and do not use the parent runId ${master.runId}.`,
      `The aggregator handoff must be JSON with schemaVersion 1, handoffType semantic-workflow-aggregation-handoff, the exact runId above, status ready_for_verification, dossierCount ${dossierPaths.length}, sourceDossiers containing all ${dossierPaths.length} declared dossier paths, summary, unknowns, and intervention.`,
    ].join(" "),
    projectDir: master.projectDir,
    claimBoundary: {
      mayClaim: [
        "cross-session patterns supported by the declared dossiers",
        "observed versus inferred distinctions and support counts",
        "matches or differences relative to the prior idea stated in this contract",
      ],
      mayNotClaim: [
        "that the extracted workflow is validated, converged, or superior without backtesting",
        "user value or product success from process traces",
        "facts from raw sessions or worker context outside the dossiers",
      ],
    },
    acceptance: [
      {
        id: "A1",
        statement: `The JSON report exists at ${reportJsonPath} with topic, stats, extractedWorkflow, matchedPriorIdea, newFromSessions, contradictions, backtestPlan, and unknowns.`,
        verify: `Read ${reportJsonPath}; validate the required sections and evidence support counts.`,
      },
      {
        id: "A2",
        statement: `The Markdown report exists at ${reportMarkdownPath} with the executive extraction sections.`,
        verify: `Read ${reportMarkdownPath}; confirm topic, statistics, workflow, new/matched, and backtest sections.`,
      },
      {
        id: "A3",
        statement: `The aggregator handoff exists at ${handoffPath} and records that backtest remains pending.`,
        verify: `Validate handoff identity and explicit non-convergence claim.`,
      },
    ],
    sourceOfTruth: [interestPath, ...dossierPaths],
    nonGoals: [
      "Do not reopen raw session files.",
      "Do not silently merge contradictory session behavior.",
      "Do not call extraction convergence before a separate backtest.",
    ],
    escalationPolicy: [
      "Escalate if dossier support is too sparse or contradictory to define a workflow.",
      "Escalate if the comparison to the prior idea cannot be grounded in dossier evidence.",
    ],
    metadata: {
      workflowMode: "semantic-session-workflow-aggregation",
      freshContext: true,
      dossierCount: dossierPaths.length,
      selectedSessionIds: selectedSessions.map((session) => session.id),
      priorIdea,
      outputs: [reportJsonPath, reportMarkdownPath, handoffPath],
      expectedHandoffRunId: runId,
    },
  };
}

async function run() {
  const argv = process.argv.slice(2);
  const contractPath = value(argv, "--contract");
  if (!contractPath) throw new Error("Usage: run-semantic-session-workflow-extraction.mjs --contract <contract.json> [--interest-index <file>] [--max-sessions 4]");
  const masterPath = path.resolve(contractPath);
  const master = loadContract(masterPath);
  const projectDir = master.projectDir;
  const runDir = path.dirname(masterPath);
  const interestPath = path.resolve(value(argv, "--interest-index", path.join(projectDir, "artifacts/session-pattern-extraction/full-4-20260914/00-session-interest-index.json")));
  const baseArtifactDir = path.resolve(value(argv, "--artifact-dir", path.join(runDir, "artifacts")));
  const attempt = nextAttempt(runDir, value(argv, "--attempt", undefined));
  const attemptLabel = `attempt-${String(attempt).padStart(3, "0")}`;
  const attemptDir = path.join(runDir, attemptLabel);
  const artifactDir = path.join(baseArtifactDir, attemptLabel);
  const dossierDir = path.join(artifactDir, "dossiers");
  const maxSessions = Number(value(argv, "--max-sessions", "4"));
  const node = value(argv, "--node", "/home/bendi/.nvm/versions/node/v22.22.0/bin/node");
  const piCli = value(argv, "--pi-cli", "/home/bendi/.npm/_npx/a54d9a87e5358117/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
  const agentDir = value(argv, "--agent-dir", "/home/bendi/.pi/agent");
  const provider = value(argv, "--provider", "openai-codex");
  const model = value(argv, "--model", "gpt-5.6-luna");
  const thinking = value(argv, "--thinking", "xhigh");
  const stallMs = Number(value(argv, "--stall-ms", "300000"));
  const runtimeMs = Number(value(argv, "--runtime-ms", "1200000"));
  const reuseDossierAttemptArg = value(argv, "--reuse-dossier-attempt", undefined);
  const interest = readJson(interestPath);
  let selectedSessions;
  let reuseDossierAttempt = null;
  if (reuseDossierAttemptArg !== undefined) {
    reuseDossierAttempt = path.resolve(reuseDossierAttemptArg);
    const reuseAttemptLabel = path.basename(reuseDossierAttempt);
    const reuseManifestPath = path.join(runDir, reuseAttemptLabel, "selection-manifest.json");
    if (!fs.existsSync(reuseManifestPath)) throw new Error(`cannot reuse dossier attempt without selection manifest: ${reuseManifestPath}`);
    const reuseManifest = readJson(reuseManifestPath);
    selectedSessions = reuseManifest.selectedSessions;
    if (!Array.isArray(selectedSessions) || selectedSessions.length === 0) throw new Error(`reused dossier attempt has no selected sessions: ${reuseManifestPath}`);
  } else {
    selectedSessions = selectSessions(interest, maxSessions);
  }
  if (selectedSessions.length === 0) throw new Error("no eligible development skill-matched building sessions found");

  const manifestPath = path.join(attemptDir, "selection-manifest.json");
  writeJson(manifestPath, {
    schemaVersion: 1,
    runId: master.runId,
    attempt,
    attemptLabel,
    selectionPolicy: "development split + explicit product-factory/product-factory-pi signal + likely/possibly building + one session per independence group; Pi matches sort first",
    sourceInterestIndex: relative(projectDir, interestPath),
    selectedSessions,
  });

  const piArgs = [piCli, "--mode", "rpc", "--no-session", "--provider", provider, "--model", model, "--thinking", thinking, "--extension", "/home/bendi/pi-product-factory/extensions/factory.js"];
  const dossierResults = [];
  if (reuseDossierAttempt) {
    for (let index = 0; index < selectedSessions.length; index += 1) {
      const session = selectedSessions[index];
      const workerDir = path.join(reuseDossierAttempt, "dossiers", `${String(index + 1).padStart(2, "0")}-${session.id}`);
      const evidencePacketPath = path.join(workerDir, "evidence-packet.json");
      const dossierPath = path.join(workerDir, "dossier.json");
      const handoffPath = path.join(workerDir, "handoff.json");
      const workerContractPath = path.join(workerDir, "contract.json");
      if (!fs.existsSync(workerContractPath)) throw new Error(`cannot reuse dossier without worker contract: ${workerContractPath}`);
      const contract = readJson(workerContractPath);
      validateDossierHandoff(handoffPath, { expectedRunId: contract.runId, expectedSessionId: session.id, dossierPath, evidencePacketPath });
      if (!fs.existsSync(dossierPath)) throw new Error(`missing reused dossier: ${dossierPath}`);
      dossierResults.push({
        sessionId: session.id,
        sourceReference: session.sourceReference,
        dossier: relative(projectDir, dossierPath),
        handoff: relative(projectDir, handoffPath),
        supervisorStatus: "needs_verification",
        reason: null,
        handoffStatus: "ready_for_verification",
        reusedFrom: relative(projectDir, reuseDossierAttempt),
      });
    }
  } else {
    for (let index = 0; index < selectedSessions.length; index += 1) {
      const session = selectedSessions[index];
      const workerDir = path.join(dossierDir, `${String(index + 1).padStart(2, "0")}-${session.id}`);
      const evidencePacketPath = path.join(workerDir, "evidence-packet.json");
      const dossierPath = path.join(workerDir, "dossier.json");
      const handoffPath = path.join(workerDir, "handoff.json");
      const evidencePacket = buildSessionEvidencePacket({ sourceReference: session.sourceReference, sessionId: session.id, interestMetadata: session });
      writeJson(evidencePacketPath, evidencePacket);
      const contract = workerContract({ master, session, index, total: selectedSessions.length, interestPath, evidencePacketPath, dossierPath, handoffPath });
      const workerContractPath = path.join(workerDir, "contract.json");
      writeJson(workerContractPath, contract);
      console.error(`dossier ${index + 1}/${selectedSessions.length}: ${session.id} (${evidencePacket.statistics.packetCharacters} packet chars)`);
      const supervisorResult = await supervisePi({ contract, contractPath: workerContractPath, command: node, args: piArgs, cwd: projectDir, env: { PI_CODING_AGENT_DIR: agentDir }, stallMs, maxRuntimeMs: runtimeMs });
      let handoff = null;
      let status = supervisorResult.status;
      let reason = supervisorResult.reason ?? null;
      if (status !== "escalated") {
        try {
          handoff = validateDossierHandoff(handoffPath, {
            expectedRunId: contract.runId,
            expectedSessionId: session.id,
            dossierPath,
            evidencePacketPath,
          });
          if (!fs.existsSync(dossierPath)) throw new Error(`missing dossier: ${dossierPath}`);
        } catch (error) {
          status = "escalated";
          reason = "invalid_dossier_handoff";
          supervisorResult.error = error.message;
        }
      }
      dossierResults.push({ sessionId: session.id, sourceReference: session.sourceReference, dossier: relative(projectDir, dossierPath), handoff: relative(projectDir, handoffPath), supervisorStatus: status, reason, handoffStatus: handoff?.status ?? null });
      if (status === "escalated") {
        const result = {
          schemaVersion: 1,
          runId: master.runId,
          attempt,
          status: "escalated",
          failure: { phase: "dossier", sessionId: session.id, reason, supervisorResult },
          selectionManifest: relative(projectDir, manifestPath),
          selectedSessions: selectedSessions.map((item) => item.id),
          dossierCount: dossierResults.length,
          dossierResults,
          aggregator: null,
          convergence: { status: "blocked_by_extraction_failure", backtestRequired: true },
          unknowns: ["The semantic extraction did not complete; no cross-session workflow was aggregated.", "The failed worker may have left partial events, but those are not treated as a dossier."],
        };
        writeJson(path.join(attemptDir, "result.json"), result);
        console.log(JSON.stringify(result, null, 2));
        process.exitCode = 1;
        return;
      }
    }
  }

  const dossierPaths = dossierResults.map((result) => path.resolve(projectDir, result.dossier));
  const reportJsonPath = path.join(artifactDir, "workflow-extraction.json");
  const reportMarkdownPath = path.join(artifactDir, "workflow-extraction.md");
  const aggregatorDir = path.join(artifactDir, "aggregator");
  const aggregatorHandoffPath = path.join(aggregatorDir, "handoff.json");
  const aggregatorContract = buildAggregatorContract({ master, runDir, artifactDir, interestPath, dossierPaths, reportJsonPath, reportMarkdownPath, handoffPath: aggregatorHandoffPath, selectedSessions });
  const aggregatorContractPath = path.join(aggregatorDir, "contract.json");
  writeJson(aggregatorContractPath, aggregatorContract);
  console.error(`aggregator: ${selectedSessions.length} dossiers`);
  const aggregatorResult = await supervisePi({ contract: aggregatorContract, contractPath: aggregatorContractPath, command: node, args: piArgs, cwd: projectDir, env: { PI_CODING_AGENT_DIR: agentDir }, stallMs, maxRuntimeMs: runtimeMs });
  let aggregatorHandoff = null;
  let aggregatorStatus = aggregatorResult.status;
  let aggregatorReason = aggregatorResult.reason ?? null;
  if (aggregatorStatus !== "escalated") {
    try {
      aggregatorHandoff = validateAggregatorHandoff(aggregatorHandoffPath, { expectedRunId: aggregatorContract.runId, dossierPaths });
      for (const outputPath of [reportJsonPath, reportMarkdownPath]) if (!fs.existsSync(outputPath)) throw new Error(`missing aggregator output: ${outputPath}`);
    } catch (error) {
      aggregatorStatus = "escalated";
      aggregatorReason = "invalid_aggregator_handoff";
      aggregatorResult.error = error.message;
    }
  }

  const result = {
    schemaVersion: 1,
    runId: master.runId,
    attempt,
    status: aggregatorStatus === "escalated" ? "escalated" : "extracted_pending_backtest",
    selectionManifest: relative(projectDir, manifestPath),
    selectedSessions: selectedSessions.map((session) => session.id),
    dossierCount: dossierResults.length,
    dossierResults,
    aggregator: { status: aggregatorStatus, reason: aggregatorReason, contract: relative(projectDir, aggregatorContractPath), handoff: relative(projectDir, aggregatorHandoffPath), reportJson: relative(projectDir, reportJsonPath), reportMarkdown: relative(projectDir, reportMarkdownPath) },
    convergence: { status: "pending_backtest", extractedIn: `${dossierResults.length} fresh dossier contexts plus 1 fresh aggregator context`, backtestRequired: true },
    unknowns: ["The extracted workflow has not yet been independently backtested or compared against a baseline.", "Session-reported outcomes remain evidence from the historical traces, not fresh user-value validation."],
  };
  writeJson(path.join(attemptDir, "result.json"), result);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === "escalated" ? 1 : 0;
}

try {
  await run();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
