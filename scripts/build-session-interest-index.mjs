#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

function value(argv, flag, fallback) {
  const index = argv.indexOf(flag);
  return index === -1 ? fallback : argv[index + 1];
}

function textFrom(valueToRead, depth = 0) {
  if (depth > 8 || valueToRead == null) return "";
  if (typeof valueToRead === "string") return valueToRead;
  if (Array.isArray(valueToRead)) return valueToRead.map((item) => textFrom(item, depth + 1)).join("\n");
  if (typeof valueToRead !== "object") return "";
  return ["text", "input_text", "output_text", "message", "content", "summary", "name", "input", "arguments", "command", "output"]
    .filter((key) => key in valueToRead)
    .map((key) => textFrom(valueToRead[key], depth + 1))
    .join("\n");
}

function stripSyntheticContext(text) {
  return text
    .replace(/<codex_internal_context[\s\S]*?<\/codex_internal_context>/gi, " ")
    .replace(/<skills_instructions>[\s\S]*?<\/skills_instructions>/gi, " ")
    .replace(/<recommended_plugins>[\s\S]*?<\/recommended_plugins>/gi, " ")
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, " ")
    .replace(/<skill>[\s\S]*?<\/skill>/gi, " ")
    .replace(/<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/gi, " ")
    .replace(/The following is the Codex agent history[\s\S]*/gi, " ")
    .trim();
}

function isSyntheticHumanMessage(rawText, cleanText) {
  if (!cleanText) return true;
  if (/The following is the Codex agent history/i.test(rawText)) return true;
  if (/^# AGENTS\.md instructions\b/i.test(cleanText)) return true;
  return false;
}

function isHumanRecord(record) {
  if (record.type === "response_item" && record.payload?.type === "message" && record.payload.role === "user") return true;
  if (record.type === "message" && record.role === "user") return true;
  if (record.type === "event_msg" && record.payload?.type === "user_message") return true;
  return false;
}

function messageRole(record) {
  if (record.type === "response_item") return record.payload?.role ?? null;
  if (record.type === "message") return record.role ?? null;
  if (record.type === "event_msg" && record.payload?.type === "user_message") return "user";
  return null;
}

function messageText(record) {
  if (record.type === "response_item") return textFrom(record.payload?.content);
  if (record.type === "message") return textFrom(record.content ?? record.message ?? record.text);
  if (record.type === "event_msg") return textFrom(record.payload?.message ?? record.payload?.content ?? record.payload?.text);
  return "";
}

function recordToolName(record) {
  if (record.type === "response_item" && ["function_call", "custom_tool_call", "tool_call"].includes(record.payload?.type)) {
    return record.payload.name ?? record.payload.tool_name ?? null;
  }
  if (record.type === "event_msg" && record.payload?.type === "tool_call") {
    return record.payload.name ?? record.payload.tool_name ?? null;
  }
  return null;
}

const skillPatterns = {
  productFactoryPi: [
    /\$product-factory-pi\b/i,
    /\bproduct-factory-pi\b/i,
    /\/product-factory-pi(?:\/|\b)/i,
  ],
  productFactory: [
    /\$product-factory(?!-pi)\b/i,
    /\bproduct-factory(?!-pi)\b/i,
    /\bproduct factory\b/i,
    /\/product-factory\/SKILL\.md\b/i,
  ],
};

function matchedSkills(text) {
  return Object.entries(skillPatterns)
    .filter(([, patterns]) => patterns.some((pattern) => pattern.test(text)))
    .map(([skill]) => skill);
}

const buildingTools = new Set([
  "apply_patch",
  "edit",
  "write_file",
  "create_file",
  "delete_file",
  "exec_command",
  "shell_command",
  "write_stdin",
  "git",
  "npm",
  "pnpm",
  "yarn",
  "pytest",
]);

const buildingLanguage = [
  /\b(build|implement|create|add|fix|edit|refactor|scaffold|ship|deploy)\b/i,
  /\b(run|pass|write|add)\b.{0,30}\b(test|tests|test suite|spec)\b/i,
  /\b(git\s+(commit|push)|npm\s+(run|test|install)|pnpm\s+(run|test)|yarn\s+(run|test)|cargo\s+(build|test)|pytest)\b/i,
  /\b(code|repository|repo|source|file|component|endpoint|worker|app)\b/i,
];

function addHit(target, skill, role, record, operational = false) {
  const bucket = target[skill];
  bucket.matchCount += 1;
  bucket.roles[role] = (bucket.roles[role] ?? 0) + 1;
  if (operational) bucket.operationalSignalCount += 1;
  if (role === "user" && !bucket.firstHumanReference) {
    bucket.firstHumanReference = { ordinal: record.ordinal ?? null, timestamp: record.timestamp ?? null };
  }
  if (!bucket.firstMatch) bucket.firstMatch = { ordinal: record.ordinal ?? null, timestamp: record.timestamp ?? null, role };
}

function emptySkillBuckets() {
  return {
    productFactory: { matched: false, matchCount: 0, operationalSignalCount: 0, roles: {}, firstMatch: null, firstHumanReference: null },
    productFactoryPi: { matched: false, matchCount: 0, operationalSignalCount: 0, roles: {}, firstMatch: null, firstHumanReference: null },
  };
}

function operationalSignal(skill, role, text) {
  if (role === "developer") return false;
  if (skill === "productFactoryPi") return /\b(use|using|run|route|through|supervis|handoff|worker|Pi Product Factory|pi-factory)\b/i.test(text);
  return /\b(use|using|run|route|through|follow|gate|iteration|evidence|factory\.py|product controller|product factory workflow)\b/i.test(text);
}

function emptyBuilding() {
  return {
    status: "not_detected",
    score: 0,
    signals: [],
    toolCounts: {},
    lexicalHitCount: 0,
    editToolCount: 0,
    commandToolCount: 0,
    testSignalCount: 0,
    versionControlSignalCount: 0,
  };
}

function classifyBuilding(building, humanIntentCount) {
  const categories = new Set();
  if (building.editToolCount > 0) categories.add("file_editing_tool");
  if (building.commandToolCount > 0) categories.add("command_execution");
  if (building.lexicalHitCount > 0) categories.add("implementation_language");
  if (building.testSignalCount > 0) categories.add("verification");
  if (building.versionControlSignalCount > 0) categories.add("version_control");
  building.signals = [...categories];
  building.score = categories.size + Math.min(humanIntentCount, 3);
  if (categories.has("file_editing_tool") && categories.has("command_execution")) building.status = "likely_building";
  else if (categories.has("implementation_language") && (categories.has("file_editing_tool") || categories.has("command_execution"))) building.status = "likely_building";
  else if (categories.size > 0 && humanIntentCount > 0) building.status = "possibly_building";
  return building;
}

async function loadJson(filePath) {
  return JSON.parse(await fs.promises.readFile(path.resolve(filePath), "utf8"));
}

async function inspectSession(session, cutoff, inventoryEntry, progress) {
  const filePath = path.resolve(session.path);
  const summary = {
    id: session.id,
    sourceReference: filePath,
    firstTimestamp: null,
    lastTimestamp: null,
    humanMessageCount: 0,
    syntheticHumanMessageCount: 0,
    assistantMessageCount: 0,
    developerMessageCount: 0,
    reviewWrapperMessageCount: 0,
    invalidJsonLines: 0,
    truncatedAtSnapshot: false,
    skillUsage: emptySkillBuckets(),
    building: emptyBuilding(),
    selection: inventoryEntry?.selection ?? null,
    split: inventoryEntry?.split ?? null,
    independenceGroup: inventoryEntry?.independenceGroup ?? null,
    cwd: inventoryEntry?.structuralMetadata?.cwd ?? null,
    threadName: inventoryEntry?.structuralMetadata?.threadName ?? null,
  };
  const seenHumanMessages = new Set();
  let humanIntentCount = 0;
  const input = fs.createReadStream(filePath);
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  if (progress) process.stderr.write(`interest-index ${filePath}\n`);
  for await (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      summary.invalidJsonLines += 1;
      continue;
    }
    if (record.timestamp && cutoff && record.timestamp > cutoff) {
      summary.truncatedAtSnapshot = true;
      break;
    }
    if (record.timestamp) {
      if (!summary.firstTimestamp) summary.firstTimestamp = record.timestamp;
      summary.lastTimestamp = record.timestamp;
    }

    const toolName = recordToolName(record);
    if (typeof toolName === "string") {
      summary.building.toolCounts[toolName] = (summary.building.toolCounts[toolName] ?? 0) + 1;
      if (buildingTools.has(toolName)) {
        if (["apply_patch", "edit", "write_file", "create_file", "delete_file"].includes(toolName)) summary.building.editToolCount += 1;
        else if (["exec_command", "shell_command", "write_stdin", "git", "npm", "pnpm", "yarn", "pytest"].includes(toolName)) summary.building.commandToolCount += 1;
      }
    }

    if (!isHumanRecord(record) && !(record.type === "response_item" && record.payload?.type === "message")) continue;
    const role = messageRole(record);
    const rawText = messageText(record);
    const cleanText = role === "user" ? stripSyntheticContext(rawText) : rawText;
    const textForSignals = rawText;
    const reviewWrapper = /The following is the Codex agent history/i.test(rawText);
    const hash = crypto.createHash("sha1").update(`${role}\n${record.timestamp ?? ""}\n${rawText}`).digest("hex");

    if (role === "user") {
      const human = !isSyntheticHumanMessage(rawText, cleanText);
      if (reviewWrapper) summary.reviewWrapperMessageCount += 1;
      if (!human) summary.syntheticHumanMessageCount += 1;
      if (human && !seenHumanMessages.has(hash)) {
        seenHumanMessages.add(hash);
        summary.humanMessageCount += 1;
      }
      if (human && /\b(build|implement|create|add|fix|edit|refactor|ship|deploy|run tests|write code)\b/i.test(cleanText)) humanIntentCount += 1;
    } else if (role === "assistant") {
      summary.assistantMessageCount += 1;
    } else if (role === "developer") {
      summary.developerMessageCount += 1;
      continue;
    }

    for (const skill of (reviewWrapper ? [] : matchedSkills(textForSignals))) {
      const operational = operationalSignal(skill, role, textForSignals);
      summary.skillUsage[skill].matched = true;
      addHit(summary.skillUsage, skill, role, record, operational);
      if (role === "user" && /\$product-factory|\/SKILL\.md|<skill>|<name>/i.test(textForSignals)) summary.skillUsage[skill].explicitReferenceCount = (summary.skillUsage[skill].explicitReferenceCount ?? 0) + 1;
    }

    if (role !== "developer" && !reviewWrapper) {
      const lexicalMatches = buildingLanguage.filter((pattern) => pattern.test(textForSignals)).length;
      summary.building.lexicalHitCount += lexicalMatches;
      if (/\b(test|tests|test suite|pytest|npm test|pnpm test|yarn test|cargo test)\b/i.test(textForSignals)) summary.building.testSignalCount += 1;
      if (/\b(git\s+(commit|push|diff|status)|commit|pull request|PR)\b/i.test(textForSignals)) summary.building.versionControlSignalCount += 1;
    }
  }
  summary.building = classifyBuilding(summary.building, humanIntentCount);
  summary.sessionKind = summary.reviewWrapperMessageCount > 0 ? "review-wrapper-or-embedded-transcript" : "normal-session-record";
  summary.skillUsage.productFactory.used = summary.skillUsage.productFactory.matched && (summary.skillUsage.productFactory.operationalSignalCount > 0 || (summary.skillUsage.productFactory.explicitReferenceCount ?? 0) > 0);
  summary.skillUsage.productFactoryPi.used = summary.skillUsage.productFactoryPi.matched && (summary.skillUsage.productFactoryPi.operationalSignalCount > 0 || (summary.skillUsage.productFactoryPi.explicitReferenceCount ?? 0) > 0);
  return summary;
}

export async function buildInterestIndex({ indexPath, inventoryPath = null, outputPath, top = 25, progress = false }) {
  const sourceIndex = await loadJson(indexPath);
  const inventory = inventoryPath && fs.existsSync(path.resolve(inventoryPath)) ? await loadJson(inventoryPath) : null;
  const inventoryBySource = new Map((inventory?.sessions ?? []).map((entry) => [path.resolve(entry.sourceReference), entry]));
  const cutoff = sourceIndex.generated_at ?? sourceIndex.generatedAt ?? null;
  const sessions = [];
  for (const session of sourceIndex.sessions ?? []) {
    const sourceReference = path.resolve(session.path ?? session.sourceReference);
    const row = await inspectSession({ ...session, path: sourceReference }, cutoff, inventoryBySource.get(sourceReference), progress);
    sessions.push(row);
  }
  const reviewEligible = (session) => session.selection !== "excluded" && session.split !== "holdout";
  const byHumanMessages = [...sessions].sort((a, b) => b.humanMessageCount - a.humanMessageCount || b.building.score - a.building.score || a.sourceReference.localeCompare(b.sourceReference));
  const byReviewHumanMessages = sessions.filter(reviewEligible).sort((a, b) => b.humanMessageCount - a.humanMessageCount || b.building.score - a.building.score || a.sourceReference.localeCompare(b.sourceReference));
  const skillMatched = sessions.filter((session) => session.skillUsage.productFactory.matched || session.skillUsage.productFactoryPi.matched)
    .sort((a, b) => (b.humanMessageCount + b.building.score) - (a.humanMessageCount + a.building.score));
  const likelyBuilding = sessions.filter((session) => session.building.status === "likely_building")
    .sort((a, b) => b.building.score - a.building.score || b.humanMessageCount - a.humanMessageCount);
  const reviewSkillMatched = skillMatched.filter(reviewEligible);
  const reviewLikelyBuilding = likelyBuilding.filter(reviewEligible);
  const selected = new Map();
  for (const session of byReviewHumanMessages.slice(0, top)) selected.set(session.id, "top-human-message-count");
  for (const session of reviewSkillMatched) selected.set(session.id, selected.get(session.id) ?? "skill-reference");
  for (const session of reviewLikelyBuilding.slice(0, top)) selected.set(session.id, selected.get(session.id) ?? "likely-building");
  for (const session of sessions) session.interestSelection = selected.get(session.id) ?? null;
  const count = (predicate) => sessions.filter(predicate).length;
  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    snapshotAt: cutoff,
    sourceIndex: path.resolve(indexPath),
    inventory: inventoryPath ? path.resolve(inventoryPath) : null,
    privacy: {
      rawTranscriptCopied: false,
      contentTextIncluded: false,
      note: "Message text is scanned transiently at the frozen source-index cutoff; output contains counts, flags, and source references only.",
    },
    selectionPolicy: {
      humanMessageDefinition: "Canonical user-role messages after removing synthetic Codex context, environment, skill payload, and internal continuation blocks; duplicate event representations are de-duplicated.",
      skillSignals: ["product-factory", "product-factory-pi"],
      buildingHeuristic: "likely_building requires edit plus command signals, or implementation language plus edit/command signals; otherwise the result is possibly_building or not_detected.",
      selectedForSemanticReview: `Top ${top} eligible sessions by human message count, every eligible session with an explicit skill signal, and the top ${top} eligible likely-building sessions; holdout sessions are excluded when split metadata is available.`,
    },
    summary: {
      sessionCount: sessions.length,
      totalHumanMessages: sessions.reduce((sum, session) => sum + session.humanMessageCount, 0),
      productFactorySessions: count((session) => session.skillUsage.productFactory.matched),
      productFactoryPiSessions: count((session) => session.skillUsage.productFactoryPi.matched),
      sessionsWithAnySkillSignal: count((session) => session.skillUsage.productFactory.matched || session.skillUsage.productFactoryPi.matched),
      likelyBuildingSessions: count((session) => session.building.status === "likely_building"),
      possiblyBuildingSessions: count((session) => session.building.status === "possibly_building"),
      reviewEligibleSessions: reviewEligible ? sessions.filter(reviewEligible).length : sessions.length,
      holdoutExcludedFromReview: sessions.filter((session) => session.split === "holdout").length,
      sessionsTruncatedAtSnapshot: count((session) => session.truncatedAtSnapshot),
      invalidJsonLines: sessions.reduce((sum, session) => sum + session.invalidJsonLines, 0),
    },
    mostHumanMessages: byHumanMessages[0] ?? null,
    topByHumanMessages: byHumanMessages.slice(0, top),
    topReviewCandidatesByHumanMessages: byReviewHumanMessages.slice(0, top),
    skillMatchedSessions: skillMatched,
    skillMatchedReviewCandidates: reviewSkillMatched,
    likelyBuildingSessions: likelyBuilding.slice(0, top),
    likelyBuildingReviewCandidates: reviewLikelyBuilding.slice(0, top),
    reviewCandidates: sessions.filter((session) => session.interestSelection),
    sessions,
  };
  await fs.promises.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await fs.promises.writeFile(path.resolve(outputPath), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

function usage() {
  console.error(`Usage:
  build-session-interest-index.mjs --index <corpus-index.json> --output <interest-index.json>
    [--inventory <session-inventory.json>] [--top 25] [--progress]`);
}

const argv = process.argv.slice(2);
const indexPath = value(argv, "--index");
const outputPath = value(argv, "--output");
if (indexPath && outputPath) {
  const result = await buildInterestIndex({
    indexPath,
    inventoryPath: value(argv, "--inventory", null),
    outputPath,
    top: Number(value(argv, "--top", "25")),
    progress: argv.includes("--progress"),
  });
  console.log(JSON.stringify({ output: path.resolve(outputPath), snapshotAt: result.snapshotAt, ...result.summary }, null, 2));
} else {
  usage();
  process.exitCode = 2;
}
