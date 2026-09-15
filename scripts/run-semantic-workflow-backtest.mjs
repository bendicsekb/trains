#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { loadContract, supervisePi } from "/home/bendi/pi-product-factory/src/supervisor.mjs";
import { buildSessionEvidencePacket } from "./build-session-evidence-packet.mjs";

const METRICS = [
  "task_success",
  "outcome_fidelity",
  "human_intervention_rate",
  "unnecessary_steps",
  "safety_violations",
  "unhandled_branches",
];

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

function nextAttempt(runDir, requested) {
  if (requested !== undefined && requested !== null) {
    const attempt = Number(requested);
    if (!Number.isInteger(attempt) || attempt < 1) throw new Error("--attempt must be a positive integer");
    return attempt;
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

function selectSessions(interest, split, maxSessions) {
  const eligible = interest.sessions.filter((session) => (
    session.split === split
    && (session.skillUsage.productFactory.matched || session.skillUsage.productFactoryPi.matched)
    && ["likely_building", "possibly_building"].includes(session.building.status)
  ));
  const groups = new Set();
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
      if (groups.has(group)) return false;
      groups.add(group);
      return true;
    })
    .slice(0, maxSessions);
}

function boundaryChecks() {
  return {
    rawSessionOpened: false,
    otherHistoricalSessionsOpened: false,
    siblingWorkerArtifactsOpened: false,
    fullTranscriptCopied: false,
    secretsCopied: false,
    note: "This is an observational trace evaluation, not a hidden-future replay. The evaluator reads one bounded packet and the declared workflow definitions only.",
  };
}

function caseContract({ master, candidatePath, baselinePath, evidencePacketPath, casePath, handoffPath, session, index, total, split }) {
  const runId = `${master.runId}-case-${String(index + 1).padStart(2, "0")}-${session.id}`;
  return {
    schemaVersion: 1,
    runId,
    package: master.package ?? "trains/session-workflow-extraction",
    createdAt: new Date().toISOString(),
    goal: [
      `You are observational backtest evaluator ${index + 1} of ${total} for the ${split} split.`,
      "This is not a causal replay and must not be presented as one. Read exactly one bounded evidence packet, the candidate workflow definition, and the baseline workflow definition.",
      "Judge whether the observed trace contains direct evidence that each workflow would have supported the relevant behavior. Do not invent task success, user value, counterfactual outcomes, or safety conclusions.",
      "Use unknown whenever the packet cannot support a metric. Unknown is a valid result, not a failure to be repaired.",
      "For candidate and baseline separately, return every declared metric with status supported, unsupported, mixed, or unknown, evidence references, and a short rationale. Return a metric-level comparison only when the difference is directly supported; otherwise use unknown.",
      `Use the exact caseId ${session.id} and exact sessionId ${session.id}. Use evaluationMode observational_trace_not_replay. The handoff runId must be ${runId}; do not use the parent runId ${master.runId}.`,
      `Write the bounded case result to ${casePath} and the required handoff to ${handoffPath}.`,
    ].join(" "),
    projectDir: master.projectDir,
    claimBoundary: {
      mayClaim: [
        "what the bounded historical trace explicitly supports or does not support",
        "whether candidate and baseline rules are visible in the observed trace",
        "unknowns and limitations of observational evaluation",
      ],
      mayNotClaim: [
        "that the candidate caused the historical outcome",
        "that the baseline would have produced a different counterfactual outcome",
        "semantic replay success, user value, production readiness, or convergence from one case",
        "facts from other cases, raw sessions, or worker events",
      ],
    },
    acceptance: [
      {
        id: "B1",
        statement: `A bounded case result exists at ${casePath} with candidate, baseline, comparison, metrics, evidence, and unknowns.`,
        verify: `Read ${casePath}; confirm every metric is explicit and unknowns are preserved.`,
      },
      {
        id: "B2",
        statement: `A valid handoff exists at ${handoffPath} and declares the observational boundary.`,
        verify: `Validate the handoff identity, paths, boundary checks, and case status independently.`,
      },
    ],
    sourceOfTruth: [evidencePacketPath, candidatePath, baselinePath],
    nonGoals: [
      "Do not open the raw session path exposed in metadata.",
      "Do not open other cases or worker artifacts.",
      "Do not turn unknown metrics into a pass or fail for the candidate.",
      "Do not use this result to alter the candidate without an explicit comparison decision.",
    ],
    escalationPolicy: [
      "Escalate if the packet or workflow definitions are missing or malformed.",
      "Escalate if the case cannot be evaluated without raw transcript access.",
      "Return unknown metrics rather than forcing a judgment when evidence is insufficient.",
    ],
    metadata: {
      workflowMode: "observational-semantic-backtest-case",
      evaluationMode: "observational_trace_not_replay",
      split,
      freshContext: true,
      sessionId: session.id,
      sessionOrdinal: index + 1,
      sourceSession: session.sourceReference,
      evidencePacket: relative(master.projectDir, evidencePacketPath),
      candidateDefinition: relative(master.projectDir, candidatePath),
      baselineDefinition: relative(master.projectDir, baselinePath),
      outputCase: relative(master.projectDir, casePath),
      outputHandoff: relative(master.projectDir, handoffPath),
      expectedHandoffRunId: runId,
    },
  };
}

function aggregatorContract({ master, candidatePath, baselinePath, casePaths, reportJsonPath, reportMarkdownPath, handoffPath, split, selectedSessions }) {
  const runId = `${master.runId}-aggregator`;
  return {
    schemaVersion: 1,
    runId,
    package: master.package ?? "trains/session-workflow-extraction",
    createdAt: new Date().toISOString(),
    goal: [
      `You are the fresh aggregator for an observational semantic backtest on the ${split} split.`,
      "Read only the candidate definition, baseline definition, and bounded case results. Do not open evidence packets, raw sessions, or worker events.",
      `The exact bounded case result path(s) you must open are: ${casePaths.join(" | ")}. There are exactly ${casePaths.length} case result(s); do not infer missing cases from candidate support-dossier counts.`,
      "Aggregate each metric without silently dropping unknowns. Separate observed trace support from causal replay evidence.",
      "Decide whether the evidence supports continue, insufficient_evidence, or a narrow candidate adjustment. Do not claim convergence from this observational backtest.",
      `Write JSON to ${reportJsonPath}, Markdown to ${reportMarkdownPath}, and the required handoff to ${handoffPath}. The JSON report must have top-level evaluationMode observational_trace_not_replay, split ${split}, candidate, baseline, perCase (one entry for every exact case path), aggregate with candidate/baseline/comparison metric objects, decision, limitations, and unknowns.`,
      `The exact aggregator handoff runId is ${runId}; copy it exactly and do not use the parent runId ${master.runId}. The handoff must have schemaVersion 1, handoffType semantic-backtest-aggregation-handoff, that exact runId, status ready_for_verification, numeric caseCount ${casePaths.length}, sourceCases containing the exact case paths, split ${split}, evaluationMode observational_trace_not_replay, convergence with a non-converged status, and unknowns. Do not write the handoff until both report files exist.`,
    ].join(" "),
    projectDir: master.projectDir,
    claimBoundary: {
      mayClaim: [
        "per-case and aggregate observational support for candidate and baseline behaviors",
        "clear differences in explicitness or safety handling visible in the cases",
        "unknowns, evaluator limitations, and a bounded next adjustment",
      ],
      mayNotClaim: [
        "causal superiority, counterfactual task success, or convergence",
        "facts from packets, raw sessions, or worker events not present in case results",
        "holdout performance when the split is not holdout",
      ],
    },
    acceptance: [
      {
        id: "BA1",
        statement: `The backtest report exists at ${reportJsonPath} with per-case coverage, aggregate metrics, comparison, limitations, and decision.`,
        verify: `Read ${reportJsonPath}; confirm every case and every metric are represented.`,
      },
      {
        id: "BA2",
        statement: `The Markdown report exists at ${reportMarkdownPath} and says whether evidence is sufficient without claiming convergence.`,
        verify: `Read ${reportMarkdownPath}; confirm observational mode and non-convergence.`,
      },
      {
        id: "BA3",
        statement: `The handoff exists at ${handoffPath} and preserves the no-convergence boundary.`,
        verify: `Validate identity, case count, split, unknown metrics, and convergence status.`,
      },
    ],
    sourceOfTruth: [candidatePath, baselinePath, ...casePaths],
    nonGoals: [
      "Do not open evidence packets or raw session files.",
      "Do not use holdout evidence to adjust a candidate.",
      "Do not call an observational trace evaluation a replay or convergence result.",
    ],
    escalationPolicy: [
      "Escalate if any case result is missing, malformed, or omits metrics.",
      "Choose insufficient_evidence when unknowns prevent a defensible comparison.",
      "Propose at most one narrow adjustment, and only when repeated evidence supports it.",
    ],
    metadata: {
      workflowMode: "observational-semantic-backtest-aggregation",
      evaluationMode: "observational_trace_not_replay",
      freshContext: true,
      split,
      caseCount: casePaths.length,
      selectedSessionIds: selectedSessions.map((session) => session.id),
      outputs: [reportJsonPath, reportMarkdownPath, handoffPath],
      expectedHandoffRunId: runId,
      exactCasePaths: casePaths,
    },
  };
}

function validateCaseHandoff(handoffPath, { expectedRunId, expectedSessionId, casePath, evidencePacketPath }) {
  if (!fs.existsSync(handoffPath)) throw new Error(`missing case handoff: ${handoffPath}`);
  const handoff = readJson(handoffPath);
  for (const field of ["schemaVersion", "handoffType", "runId", "unknowns"]) {
    if (!(field in handoff)) throw new Error(`case handoff missing ${field}: ${handoffPath}`);
  }
  if (handoff.schemaVersion !== 1 || !["observational-semantic-backtest-case-handoff", "observational_backtest_case_handoff"].includes(handoff.handoffType)) throw new Error(`case handoff type mismatch: ${handoffPath}`);
  if (handoff.runId !== expectedRunId && handoff.runId !== path.basename(path.dirname(handoffPath))) throw new Error(`case handoff identity mismatch: ${handoffPath}`);
  const caseId = handoff.sessionId ?? handoff.caseId ?? "";
  if (handoff.sessionId !== expectedSessionId && !String(caseId).includes(expectedSessionId)) throw new Error(`case handoff session identity mismatch: ${handoffPath}`);
  const declaredCasePath = handoff.casePath ?? handoff.caseResultPath;
  if (!declaredCasePath || path.resolve(declaredCasePath) !== path.resolve(casePath)) throw new Error(`case path mismatch: ${handoffPath}`);
  const boundary = handoff.boundaryChecks ?? handoff.boundary ?? {};
  const unsafeTrueKeys = ["rawSessionOpened", "otherHistoricalSessionsOpened", "siblingWorkerArtifactsOpened", "fullTranscriptCopied", "secretsCopied", "rawTranscriptOpened", "otherCasesOpened", "workerArtifactsOpened", "causalReplay", "semanticReplay", "counterfactualEvaluation"];
  if (unsafeTrueKeys.some((key) => boundary[key] === true)) throw new Error(`case handoff violated its observational boundary: ${handoffPath}`);
  if (boundary.observationalOnly !== true && boundary.observationalTraceOnly !== true && boundary.directTraceSupportOnly !== true && boundary.evaluationModeExact !== true && boundary.type !== "observational_trace_not_replay" && boundary.mode !== "observational-semantic-backtest-case") throw new Error(`case handoff lacks observational boundary: ${handoffPath}`);
  return handoff;
}

function validateAggregatorHandoff(handoffPath, { expectedRunId, casePaths, split }) {
  if (!fs.existsSync(handoffPath)) throw new Error(`missing aggregator handoff: ${handoffPath}`);
  const handoff = readJson(handoffPath);
  for (const field of ["schemaVersion", "handoffType", "runId", "status", "caseCount", "sourceCases", "split", "evaluationMode", "convergence", "unknowns"]) {
    if (!(field in handoff)) throw new Error(`aggregator handoff missing ${field}: ${handoffPath}`);
  }
  if (handoff.schemaVersion !== 1 || handoff.handoffType !== "semantic-backtest-aggregation-handoff" || handoff.runId !== expectedRunId) throw new Error(`aggregator handoff identity mismatch: ${handoffPath}`);
  if (handoff.status !== "ready_for_verification" || handoff.caseCount !== casePaths.length || handoff.split !== split || handoff.evaluationMode !== "observational_trace_not_replay") throw new Error(`aggregator handoff state mismatch: ${handoffPath}`);
  if (!Array.isArray(handoff.sourceCases) || handoff.sourceCases.length !== casePaths.length) throw new Error(`aggregator source case mismatch: ${handoffPath}`);
  if (handoff.convergence?.status === "converged") throw new Error(`aggregator overclaims convergence: ${handoffPath}`);
  return handoff;
}

async function run() {
  const argv = process.argv.slice(2);
  const contractPath = value(argv, "--contract");
  const candidateReportPath = value(argv, "--candidate-report");
  if (!contractPath || !candidateReportPath) throw new Error("Usage: run-semantic-workflow-backtest.mjs --contract <contract.json> --candidate-report <workflow-extraction.json> [--split tuning] [--max-sessions 8]");
  const masterPath = path.resolve(contractPath);
  const master = loadContract(masterPath);
  const projectDir = master.projectDir;
  const candidateReport = readJson(path.resolve(candidateReportPath));
  const split = value(argv, "--split", "tuning");
  if (!["tuning", "holdout"].includes(split)) throw new Error(`unsupported backtest split: ${split}`);
  const interestPath = path.resolve(value(argv, "--interest-index", path.join(projectDir, "artifacts/session-pattern-extraction/full-4-20260914/00-session-interest-index.json")));
  const runDir = path.dirname(masterPath);
  const baseArtifactDir = path.resolve(value(argv, "--artifact-dir", path.join(runDir, "backtest-artifacts")));
  const attemptRoot = path.join(baseArtifactDir, "run-state");
  const attempt = nextAttempt(attemptRoot, value(argv, "--attempt", undefined));
  const attemptLabel = `attempt-${String(attempt).padStart(3, "0")}`;
  const attemptDir = path.join(attemptRoot, attemptLabel);
  const artifactDir = path.join(baseArtifactDir, attemptLabel);
  const caseDir = path.join(artifactDir, "cases");
  const maxSessions = Number(value(argv, "--max-sessions", "8"));
  const node = value(argv, "--node", "/home/bendi/.nvm/versions/node/v22.22.0/bin/node");
  const piCli = value(argv, "--pi-cli", "/home/bendi/.npm/_npx/a54d9a87e5358117/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
  const agentDir = value(argv, "--agent-dir", "/home/bendi/.pi/agent");
  const provider = value(argv, "--provider", "openai-codex");
  const model = value(argv, "--model", "gpt-5.6-luna");
  const thinking = value(argv, "--thinking", "xhigh");
  const stallMs = Number(value(argv, "--stall-ms", "300000"));
  const runtimeMs = Number(value(argv, "--runtime-ms", "1200000"));
  const reuseCaseAttemptArg = value(argv, "--reuse-case-attempt", undefined);
  const interest = readJson(interestPath);
  let selectedSessions;
  let reuseCaseAttempt = null;
  if (reuseCaseAttemptArg !== undefined) {
    reuseCaseAttempt = path.resolve(reuseCaseAttemptArg);
    const reuseAttemptLabel = path.basename(reuseCaseAttempt);
    const reuseManifestPath = path.join(attemptRoot, reuseAttemptLabel, "selection-manifest.json");
    if (!fs.existsSync(reuseManifestPath)) throw new Error(`cannot reuse case attempt without selection manifest: ${reuseManifestPath}`);
    const reuseManifest = readJson(reuseManifestPath);
    selectedSessions = reuseManifest.selectedSessions;
    if (!Array.isArray(selectedSessions) || selectedSessions.length === 0) throw new Error(`reused case attempt has no selected sessions: ${reuseManifestPath}`);
  } else {
    selectedSessions = selectSessions(interest, split, maxSessions);
  }
  if (selectedSessions.length === 0) throw new Error(`no eligible ${split} skill-matched building sessions found`);
  if (split === "holdout" && value(argv, "--allow-holdout", "false") !== "true") throw new Error("holdout is sealed; pass --allow-holdout true only after the candidate is frozen");

  const candidatePath = path.join(artifactDir, "candidate-definition.json");
  const baselinePath = path.join(artifactDir, "baseline-definition.json");
  writeJson(candidatePath, {
    schemaVersion: 1,
    definitionType: "candidate-workflow-definition",
    sourceReport: path.resolve(candidateReportPath),
    workflow: candidateReport.extractedWorkflow,
    additions: candidateReport.newFromSessions,
    limitations: candidateReport.evidenceGaps,
    evaluationBoundary: "Evaluate observed trace support only; causal replay and counterfactual outcome metrics remain unknown.",
  });
  writeJson(baselinePath, {
    schemaVersion: 1,
    definitionType: "baseline-workflow-definition",
    sourceReport: path.resolve(candidateReportPath),
    workflow: candidateReport.matchedPriorIdea?.priorIdea ?? "Product work may follow: capture intent/problem and uncertainty; form a hypothesis; choose a cheap test; implement; observe and independently verify; update evidence/state; iterate or ship when the evidence gate passes.",
    evaluationBoundary: "Evaluate observed trace support only; causal replay and counterfactual outcome metrics remain unknown.",
  });
  const manifestPath = path.join(attemptDir, "selection-manifest.json");
  writeJson(manifestPath, {
    schemaVersion: 1,
    runId: master.runId,
    attempt,
    split,
    evaluationMode: "observational_trace_not_replay",
    selectionPolicy: `${split} split + explicit product-factory/product-factory-pi signal + likely/possibly building + one session per independence group; Pi matches sort first`,
    sourceInterestIndex: relative(projectDir, interestPath),
    candidateDefinition: relative(projectDir, candidatePath),
    baselineDefinition: relative(projectDir, baselinePath),
    selectedSessions,
  });

  const piArgs = [piCli, "--mode", "rpc", "--no-session", "--provider", provider, "--model", model, "--thinking", thinking, "--extension", "/home/bendi/pi-product-factory/extensions/factory.js"];
  const caseResults = [];
  if (reuseCaseAttempt) {
    for (let index = 0; index < selectedSessions.length; index += 1) {
      const session = selectedSessions[index];
      const workerDir = path.join(reuseCaseAttempt, "cases", `${String(index + 1).padStart(2, "0")}-${session.id}`);
      const evidencePacketPath = path.join(workerDir, "evidence-packet.json");
      const casePath = path.join(workerDir, "case.json");
      const handoffPath = path.join(workerDir, "handoff.json");
      const workerContractPath = path.join(workerDir, "contract.json");
      if (!fs.existsSync(workerContractPath)) throw new Error(`cannot reuse case without worker contract: ${workerContractPath}`);
      const workerContractData = readJson(workerContractPath);
      validateCaseHandoff(handoffPath, { expectedRunId: workerContractData.runId, expectedSessionId: session.id, casePath, evidencePacketPath });
      if (!fs.existsSync(casePath)) throw new Error(`missing reused case result: ${casePath}`);
      caseResults.push({ sessionId: session.id, sourceReference: session.sourceReference, case: relative(projectDir, casePath), handoff: relative(projectDir, handoffPath), supervisorStatus: "needs_verification", reason: null, handoffStatus: "ready_for_verification", reusedFrom: relative(projectDir, reuseCaseAttempt) });
    }
  } else for (let index = 0; index < selectedSessions.length; index += 1) {
    const session = selectedSessions[index];
    const workerDir = path.join(caseDir, `${String(index + 1).padStart(2, "0")}-${session.id}`);
    const evidencePacketPath = path.join(workerDir, "evidence-packet.json");
    const casePath = path.join(workerDir, "case.json");
    const handoffPath = path.join(workerDir, "handoff.json");
    const packet = buildSessionEvidencePacket({ sourceReference: session.sourceReference, sessionId: session.id, interestMetadata: session });
    writeJson(evidencePacketPath, packet);
    const contract = caseContract({ master, candidatePath, baselinePath, evidencePacketPath, casePath, handoffPath, session, index, total: selectedSessions.length, split });
    const workerContractPath = path.join(workerDir, "contract.json");
    writeJson(workerContractPath, contract);
    console.error(`backtest case ${index + 1}/${selectedSessions.length}: ${session.id} (${packet.statistics.packetCharacters} packet chars)`);
    const supervisorResult = await supervisePi({ contract, contractPath: workerContractPath, command: node, args: piArgs, cwd: projectDir, env: { PI_CODING_AGENT_DIR: agentDir }, stallMs, maxRuntimeMs: runtimeMs });
    let handoff = null;
    let status = supervisorResult.status;
    let reason = supervisorResult.reason ?? null;
    if (status !== "escalated") {
      try {
        handoff = validateCaseHandoff(handoffPath, { expectedRunId: contract.runId, expectedSessionId: session.id, casePath, evidencePacketPath });
        if (!fs.existsSync(casePath)) throw new Error(`missing case result: ${casePath}`);
      } catch (error) {
        status = "escalated";
        reason = "invalid_case_handoff";
        supervisorResult.error = error.message;
      }
    }
    caseResults.push({ sessionId: session.id, sourceReference: session.sourceReference, case: relative(projectDir, casePath), handoff: relative(projectDir, handoffPath), supervisorStatus: status, reason, handoffStatus: handoff?.status ?? null });
    if (status === "escalated") {
      const result = { schemaVersion: 1, runId: master.runId, attempt, status: "escalated", split, evaluationMode: "observational_trace_not_replay", failure: { phase: "case", sessionId: session.id, reason, supervisorResult }, selectionManifest: relative(projectDir, manifestPath), selectedSessions: selectedSessions.map((item) => item.id), caseCount: caseResults.length, caseResults, aggregator: null, convergence: { status: "insufficient_evidence", backtestRequired: true }, unknowns: ["The observational backtest did not complete; no aggregate comparison was produced.", "No failed case is treated as a candidate regression without an independently verified case result."] };
      writeJson(path.join(attemptDir, "result.json"), result);
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = 1;
      return;
    }
  }

  const casePaths = caseResults.map((result) => path.resolve(projectDir, result.case));
  const reportJsonPath = path.join(artifactDir, "backtest-report.json");
  const reportMarkdownPath = path.join(artifactDir, "backtest-report.md");
  const aggregatorDir = path.join(artifactDir, "aggregator");
  const handoffPath = path.join(aggregatorDir, "handoff.json");
  const contract = aggregatorContract({ master, candidatePath, baselinePath, casePaths, reportJsonPath, reportMarkdownPath, handoffPath, split, selectedSessions });
  const aggregatorContractPath = path.join(aggregatorDir, "contract.json");
  writeJson(aggregatorContractPath, contract);
  console.error(`backtest aggregator: ${casePaths.length} cases`);
  const aggregatorResult = await supervisePi({ contract, contractPath: aggregatorContractPath, command: node, args: piArgs, cwd: projectDir, env: { PI_CODING_AGENT_DIR: agentDir }, stallMs, maxRuntimeMs: runtimeMs });
  let aggregatorHandoff = null;
  let aggregatorStatus = aggregatorResult.status;
  let aggregatorReason = aggregatorResult.reason ?? null;
  if (aggregatorStatus !== "escalated") {
    try {
      aggregatorHandoff = validateAggregatorHandoff(handoffPath, { expectedRunId: contract.runId, casePaths, split });
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
    status: aggregatorStatus === "escalated" ? "escalated" : "backtest_complete_observational",
    split,
    evaluationMode: "observational_trace_not_replay",
    selectionManifest: relative(projectDir, manifestPath),
    candidateDefinition: relative(projectDir, candidatePath),
    baselineDefinition: relative(projectDir, baselinePath),
    selectedSessions: selectedSessions.map((session) => session.id),
    caseCount: caseResults.length,
    caseResults,
    aggregator: { status: aggregatorStatus, reason: aggregatorReason, contract: relative(projectDir, aggregatorContractPath), handoff: relative(projectDir, handoffPath), reportJson: relative(projectDir, reportJsonPath), reportMarkdown: relative(projectDir, reportMarkdownPath) },
    convergence: { status: "not_converged", reason: "observational evidence is not causal replay and does not establish superiority", backtestRequired: true },
    unknowns: ["This run does not replay candidate and baseline from hidden pre-execution contexts.", "Causal task success, counterfactual outcome fidelity, and user value remain unknown unless directly evidenced.", "Holdout remains untouched unless explicitly run after freezing the candidate."],
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
