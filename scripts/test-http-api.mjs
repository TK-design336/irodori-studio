#!/usr/bin/env node
/**
 * Irodori Studio HTTP API smoke test (recommended on Windows).
 *
 * Usage:
 *   cd "C:\Users\elonk\Irodori Studio"
 *   set IRODORI_API_TOKEN=<token>        (cmd)
 *   $env:IRODORI_API_TOKEN="<token>"     (PowerShell)
 *   node scripts/test-http-api.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baseUrl = (process.env.IRODORI_BASE_URL || "http://127.0.0.1:18790").replace(
  /\/$/,
  "",
);
const token = process.env.IRODORI_API_TOKEN || "";
const speakerOverride = process.env.IRODORI_SPEAKER_ID || "";
const outDir = path.join(__dirname, "api-test-out");
const phrasesFile = path.join(__dirname, "test-http-api-phrases.json");
const saveBodies = process.argv.includes("--save-bodies");

function step(msg) {
  console.log(`\n== ${msg}`);
}

function ok(code) {
  console.log(`  OK (${code})`);
}

async function api(
  route,
  { method = "GET", body, outFile, auth = true } = {},
) {
  const headers = {};
  if (auth) {
    if (!token) throw new Error("IRODORI_API_TOKEN is not set");
    headers.Authorization = `Bearer ${token}`;
  }
  let payload;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json; charset=utf-8";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: payload,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${method} ${route}\n${text}`);
  }
  if (outFile) {
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(outFile, buf);
    return { status: res.status };
  }
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : null };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

if (!token) {
  console.error(
    "IRODORI_API_TOKEN is required. Copy from Studio Settings -> Local HTTP server.",
  );
  process.exit(1);
}

const phrases = JSON.parse(fs.readFileSync(phrasesFile, "utf8"));
fs.mkdirSync(outDir, { recursive: true });

console.log(`Base URL: ${baseUrl}`);
console.log(`Output:   ${outDir}`);
console.log(`Phrases:  ${phrasesFile}`);

step("GET /v1/health");
const health = await api("/v1/health");
ok(health.status);
console.log(
  `  version=${health.json.version} worker.busy=${health.json.worker.busy}`,
);

step("GET /v1/speakers");
const speakersRes = await api("/v1/speakers");
ok(speakersRes.status);
const speakers = speakersRes.json.speakers;
if (!speakers?.length) {
  throw new Error("No speakers found in Outputs. Add an embedding first.");
}
const speakerId = speakerOverride || speakers[0].id;
const styleId = speakers[0].styleId;
console.log(`  speaker: ${speakerId}`);

step("POST /v1/synthesize");
console.log(`  text: ${phrases.synthesize}`);
const synthBody = {
  text: phrases.synthesize,
  speaker: speakerId,
  format: "wav",
  split: true,
};
if (saveBodies) {
  fs.writeFileSync(
    path.join(outDir, "synthesize-body.json"),
    JSON.stringify(synthBody, null, 2),
    "utf8",
  );
}
const synthOut = path.join(outDir, "synthesize.wav");
await api("/v1/synthesize", { method: "POST", body: synthBody, outFile: synthOut });
const synthSize = fs.statSync(synthOut).size;
console.log(`  wrote ${synthOut} (${synthSize} bytes)`);

step("POST /v1/jobs + poll + line download + concat");
console.log(`  line1: ${phrases.jobLine1}`);
console.log(`  line2: ${phrases.jobLine2}`);
const jobBody = {
  lines: [
    { text: phrases.jobLine1, speaker: speakerId },
    { text: phrases.jobLine2, speaker: speakerId },
  ],
  split: false,
};
const jobRes = await api("/v1/jobs", { method: "POST", body: jobBody });
ok(jobRes.status);
const jobId = jobRes.json.jobId;
console.log(`  jobId=${jobId}`);

const deadline = Date.now() + 10 * 60 * 1000;
let job;
do {
  await sleep(2000);
  const poll = await api(`/v1/jobs/${jobId}`);
  job = poll.json;
  console.log(
    `  status=${job.status} completed=${job.completed}/${job.total}`,
  );
  if (Date.now() > deadline) throw new Error("job timeout");
} while (job.status === "queued" || job.status === "running");

if (job.status !== "completed") {
  throw new Error(`job ended with status ${job.status}: ${job.error ?? ""}`);
}

const line0 = path.join(outDir, "job-line0.wav");
await api(`/v1/jobs/${jobId}/lines/0`, { outFile: line0 });
console.log(`  wrote ${line0}`);

const jobConcat = path.join(outDir, "job-concat.wav");
await api(`/v1/jobs/${jobId}/concat`, {
  method: "POST",
  body: { format: "wav" },
  outFile: jobConcat,
});
console.log(`  wrote ${jobConcat}`);

step("POST /v1/concat");
console.log(`  line1: ${phrases.concat1}`);
console.log(`  line2: ${phrases.concat2}`);
const concatBody = {
  lines: [
    { text: phrases.concat1, speaker: speakerId },
    { text: phrases.concat2, speaker: speakerId },
  ],
  format: "wav",
  split: true,
};
if (saveBodies) {
  fs.writeFileSync(
    path.join(outDir, "concat-body.json"),
    JSON.stringify(concatBody, null, 2),
    "utf8",
  );
}
const concatOut = path.join(outDir, "concat.wav");
await api("/v1/concat", {
  method: "POST",
  body: concatBody,
  outFile: concatOut,
});
console.log(`  wrote ${concatOut}`);

step("VOICEVOX compat /speakers + /audio_query + /synthesis");
console.log(`  text: ${phrases.vvCompat}`);
const vvSpeakers = await api("/speakers", { auth: false });
ok(vvSpeakers.status);
const vvStyleId = styleId ?? vvSpeakers.json[0]?.styles?.[0]?.id;
if (!vvStyleId) throw new Error("No VOICEVOX style id");
console.log(`  styleId=${vvStyleId}`);

const q = new URLSearchParams({
  text: phrases.vvCompat,
  speaker: String(vvStyleId),
});
const queryRes = await api(`/audio_query?${q}`, { method: "POST", auth: false });
ok(queryRes.status);

const vvOut = path.join(outDir, "vv-synthesis.wav");
const synRes = await fetch(
  `${baseUrl}/synthesis?speaker=${encodeURIComponent(String(vvStyleId))}`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: queryRes.text,
  },
);
if (!synRes.ok) {
  const text = await synRes.text().catch(() => "");
  throw new Error(`HTTP ${synRes.status} POST /synthesis\n${text}`);
}
fs.writeFileSync(vvOut, Buffer.from(await synRes.arrayBuffer()));
console.log(`  wrote ${vvOut}`);

console.log("\nAll API smoke tests passed.");
console.log(`Play files under: ${outDir}`);
