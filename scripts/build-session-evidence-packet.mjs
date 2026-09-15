#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MAX_USER_CHARS = 4000;
const MAX_ASSISTANT_CHARS = 1800;
const MAX_ACTION_CHARS = 700;
const MAX_USER_MESSAGES = 200;
const MAX_ASSISTANT_MESSAGES = 80;
const MAX_ACTIONS = 260;

function textFrom(value, depth = 0) {
  if (depth > 8 || value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => textFrom(item, depth + 1)).join("\n");
  if (typeof value !== "object") return "";
  return ["text", "input_text", "output_text", "message", "content", "summary", "name", "input", "arguments", "command", "output"]
    .filter((key) => key in value)
    .map((key) => textFrom(value[key], depth + 1))
    .join("\n");
}

function cleanSyntheticContext(text) {
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

function isSyntheticHuman(rawText, cleanText) {
  if (!cleanText) return true;
  if (/The following is the Codex agent history/i.test(rawText)) return true;
  if (/^# AGENTS\.md instructions\b/i.test(cleanText)) return true;
  return false;
}

function recordMessage(record) {
  if (record.type === "response_item" && record.payload?.type === "message") {
    return { role: record.payload.role ?? null, text: textFrom(record.payload.content) };
  }
  if (record.type === "message") return { role: record.role ?? null, text: textFrom(record.content ?? record.message ?? record.text) };
  if (record.type === "event_msg" && record.payload?.type === "user_message") {
    return { role: "user", text: textFrom(record.payload.message ?? record.payload.content ?? record.payload.text) };
  }
  return null;
}

function toolAction(record) {
  const payload = record.payload ?? {};
  const type = payload.type;
  if (!["custom_tool_call", "function_call", "tool_call"].includes(type)) return null;
  return {
    tool: payload.name ?? payload.tool_name ?? "unknown",
    input: textFrom(payload.input ?? payload.arguments ?? payload.command),
  };
}

function scrubSecrets(text) {
  return text
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,'"`}]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*)[^\s,'"`}]+/gi, "$1[REDACTED]")
    .replace(/(sk-[A-Za-z0-9_-]{12,})/g, "[REDACTED_KEY]");
}

function clip(text, limit) {
  const normalized = scrubSecrets(String(text ?? "")).trim();
  if (normalized.length <= limit) return normalized;
  const head = Math.ceil(limit * 0.72);
  const tail = Math.floor(limit * 0.22);
  return `${normalized.slice(0, head)}\n…[clipped ${normalized.length - head - tail} chars]…\n${normalized.slice(-tail)}`;
}

function hashMessage(role, timestamp, text) {
  return crypto.createHash("sha1").update(`${role}\n${timestamp ?? ""}\n${text}`).digest("hex");
}

export function buildSessionEvidencePacket({ sourceReference, sessionId = null, interestMetadata = null }) {
  const userMessages = [];
  const assistantMessages = [];
  const actions = [];
  const toolCounts = {};
  const seenUsers = new Set();
  const stats = { sourceBytes: fs.statSync(sourceReference).size, sourceLines: 0, invalidJsonLines: 0, syntheticMessagesSkipped: 0 };

  for (const line of fs.readFileSync(sourceReference, "utf8").split("\n")) {
    if (!line.trim()) continue;
    stats.sourceLines += 1;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      stats.invalidJsonLines += 1;
      continue;
    }

    const message = recordMessage(record);
    if (message?.role === "user") {
      const cleaned = cleanSyntheticContext(message.text);
      if (isSyntheticHuman(message.text, cleaned)) {
        stats.syntheticMessagesSkipped += 1;
      } else {
        const hash = hashMessage("user", record.timestamp, message.text);
        if (!seenUsers.has(hash)) {
          seenUsers.add(hash);
          userMessages.push({ ordinal: record.ordinal ?? null, timestamp: record.timestamp ?? null, text: clip(cleaned, MAX_USER_CHARS) });
        }
      }
    } else if (message?.role === "assistant" && message.text.trim()) {
      assistantMessages.push({ ordinal: record.ordinal ?? null, timestamp: record.timestamp ?? null, text: clip(message.text, MAX_ASSISTANT_CHARS) });
    }

    const action = toolAction(record);
    if (action) {
      toolCounts[action.tool] = (toolCounts[action.tool] ?? 0) + 1;
      actions.push({ ordinal: record.ordinal ?? null, timestamp: record.timestamp ?? null, tool: action.tool, input: clip(action.input, MAX_ACTION_CHARS) });
    }
  }

  const packet = {
    schemaVersion: 1,
    packetType: "bounded-session-evidence",
    generatedAt: new Date().toISOString(),
    sessionId,
    sourceReference: path.resolve(sourceReference),
    privacy: {
      fullTranscriptIncluded: false,
      secretsRedacted: true,
      clippedFields: { userMessages: MAX_USER_CHARS, assistantMessages: MAX_ASSISTANT_CHARS, actions: MAX_ACTION_CHARS },
      note: "Deterministic bounded view for semantic extraction. Synthetic setup/context is removed; content is clipped and secret-like values are redacted.",
    },
    interestMetadata,
    statistics: {
      ...stats,
      canonicalUserMessages: userMessages.length,
      assistantMessages: assistantMessages.length,
      toolActions: actions.length,
      toolCounts,
      packetCharacters: 0,
    },
    userMessages: userMessages.slice(0, MAX_USER_MESSAGES),
    assistantMessages: assistantMessages.slice(0, MAX_ASSISTANT_MESSAGES),
    actions: actions.slice(0, MAX_ACTIONS),
  };
  packet.statistics.packetCharacters = JSON.stringify(packet).length;
  return packet;
}

function value(argv, flag, fallback) {
  const index = argv.indexOf(flag);
  return index === -1 ? fallback : argv[index + 1];
}

const argv = process.argv.slice(2);
const source = value(argv, "--source");
const output = value(argv, "--output");
if (source && output) {
  const packet = buildSessionEvidencePacket({ sourceReference: path.resolve(source), sessionId: value(argv, "--session-id", null) });
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(path.resolve(output), `${JSON.stringify(packet, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ output: path.resolve(output), statistics: packet.statistics }, null, 2));
}
