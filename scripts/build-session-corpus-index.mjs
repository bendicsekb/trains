#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function value(argv, flag, fallback) {
  const index = argv.indexOf(flag);
  return index === -1 ? fallback : argv[index + 1];
}

function values(argv, flag) {
  return argv.flatMap((item, index) => item === flag && argv[index + 1] ? [argv[index + 1]] : []);
}

async function walk(root) {
  const result = [];
  const pending = [path.resolve(root)];
  while (pending.length > 0) {
    const current = pending.pop();
    const entries = await fs.promises.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) result.push(full);
    }
  }
  return result.sort();
}

function sessionIds(file) {
  const ids = file.match(UUID) ?? [];
  return { sessionId: ids.at(-1) ?? null, rootSessionId: ids[0] ?? null };
}

function increment(map, key) {
  if (typeof key !== "string" || key.length === 0) return;
  map[key] = (map[key] ?? 0) + 1;
}

async function summarize(file, root, threadNames) {
  const stats = await fs.promises.stat(file);
  const hash = crypto.createHash("sha256");
  const eventTypes = {};
  const messageRoles = {};
  const toolNames = {};
  const errorTypes = {};
  let lineCount = 0;
  let invalidJsonLines = 0;
  let firstTimestamp = null;
  let lastTimestamp = null;
  let cwd = null;

  const input = fs.createReadStream(file);
  input.on("data", (chunk) => hash.update(chunk));
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    lineCount += 1;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      invalidJsonLines += 1;
      continue;
    }
    if (!firstTimestamp && record.timestamp) firstTimestamp = record.timestamp;
    if (record.timestamp) lastTimestamp = record.timestamp;
    increment(eventTypes, record.type);

    const payload = record.payload ?? {};
    if (record.type === "message") increment(messageRoles, record.role ?? payload.role);
    if (record.type === "response_item" && payload.type === "message") increment(messageRoles, payload.role);
    if (record.type === "response_item" && payload.type === "function_call") increment(toolNames, payload.name);
    if (record.type === "event_msg" && payload.type === "user_message") increment(messageRoles, "user");
    if (record.type === "event_msg" && payload.type === "tool_call") increment(toolNames, payload.name ?? payload.tool_name);
    if (record.type === "turn_context" && !cwd) cwd = payload.cwd ?? payload.environment_context?.cwd ?? null;
    if (String(record.type).toLowerCase().includes("error") || String(payload.type).toLowerCase().includes("error")) {
      increment(errorTypes, payload.type ?? record.type);
    }
  }

  const ids = sessionIds(path.basename(file));
  return {
    id: ids.sessionId ?? crypto.createHash("sha256").update(file).digest("hex").slice(0, 16),
    root_session_id: ids.rootSessionId,
    source: path.relative(root, file).startsWith("archived_sessions/") ? "archived" : "current",
    path: file,
    bytes: stats.size,
    modified_at: stats.mtime.toISOString(),
    sha256: hash.digest("hex"),
    first_timestamp: firstTimestamp,
    last_timestamp: lastTimestamp,
    line_count: lineCount,
    invalid_json_lines: invalidJsonLines,
    cwd,
    thread_name: ids.rootSessionId ? (threadNames.get(ids.rootSessionId) ?? null) : null,
    event_types: eventTypes,
    message_roles: messageRoles,
    tool_names: toolNames,
    error_types: errorTypes,
    raw_transcript_copied: false,
  };
}

const argv = process.argv.slice(2);
const roots = values(argv, "--root");
const output = value(argv, "--output");
const sessionIndexPath = value(argv, "--session-index");
const progress = argv.includes("--progress");
if (roots.length === 0 || !output) {
  console.error("Usage: build-session-corpus-index.mjs --root <dir> --root <dir> --output <file>");
  process.exit(2);
}

const absoluteRoots = roots.map((root) => path.resolve(root));
const rootAnchor = path.dirname(absoluteRoots[0]);
const threadNames = new Map();
if (sessionIndexPath) {
  const indexLines = await fs.promises.readFile(path.resolve(sessionIndexPath), "utf8");
  for (const line of indexLines.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.id && entry.thread_name) threadNames.set(entry.id, entry.thread_name);
    } catch {
      // The index is advisory; the session file inventory remains authoritative.
    }
  }
}
const files = (await Promise.all(absoluteRoots.map(walk))).flat().sort();
const sessions = [];
for (const file of files) {
  if (progress) process.stderr.write(`indexing ${file}\n`);
  sessions.push(await summarize(file, rootAnchor, threadNames));
}

const index = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  roots: absoluteRoots,
  session_count: sessions.length,
  total_bytes: sessions.reduce((sum, session) => sum + session.bytes, 0),
  invalid_json_lines: sessions.reduce((sum, session) => sum + session.invalid_json_lines, 0),
  privacy: {
    raw_transcript_copied: false,
    content_text_included: false,
    note: "Structural metadata only; inspect source paths under the workflow's replay boundary when needed.",
  },
  sessions,
};

await fs.promises.mkdir(path.dirname(path.resolve(output)), { recursive: true });
await fs.promises.writeFile(path.resolve(output), `${JSON.stringify(index, null, 2)}\n`);
console.log(JSON.stringify({ output: path.resolve(output), session_count: index.session_count, total_bytes: index.total_bytes, invalid_json_lines: index.invalid_json_lines }, null, 2));
