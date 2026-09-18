// Task-scoped survivor extension: uses the existing real channel fixture and mock provider.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readPluginInstallRecords } from "../plugin-index-sqlite.mjs";
const artifacts = process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT;
const root = process.env.OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT;
const configPath = process.env.OPENCLAW_CONFIG_PATH;
assert(artifacts && root && configPath, "Missing isolated survivor paths");
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const write = (name, value) =>
  fs.writeFileSync(path.join(artifacts, name), JSON.stringify(value, null, 2) + "\n");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function projection() {
  const config = read(configPath);
  const install = readPluginInstallRecords().clickclack;
  assert(install?.installPath, "Missing installed ClickClack identity");
  const pluginRoot = install.installPath;
  return {
    stateDir: process.env.OPENCLAW_STATE_DIR,
    configPath,
    channel: config.channels?.clickclack,
    plugin: config.plugins?.entries?.clickclack,
    allow: config.plugins?.allow,
    load: config.plugins?.load,
    installPath: install.installPath,
    sourcePath: install.sourcePath,
    agentModels: config.agents?.defaults?.models,
    models: config.models,
    agentModel: config.agents?.defaults?.model,
    files: Object.fromEntries(
      ["package.json", "openclaw.plugin.json", "index.mjs"].map((name) => [
        name,
        digest(fs.readFileSync(path.join(pluginRoot, name))),
      ]),
    ),
  };
}
async function request(pathname, options) {
  const response = await fetch(`http://127.0.0.1:44211${pathname}`, {
    ...options,
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  return { status: response.status, body: await response.json() };
}
const [mode, stage] = process.argv.slice(2);
if (mode === "snapshot") {
  const config = read(configPath);
  config.plugins.allow = [...new Set([...(config.plugins.allow ?? []), "clickclack"])];
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  write("channel-before.json", projection());
} else if (mode === "preserved") {
  const before = read(path.join(artifacts, "channel-before.json"));
  const after = projection();
  assert.deepEqual(
    after,
    before,
    "Channel/model config, state paths or original plugin source changed",
  );
  write("channel-after.json", after);
} else if (mode === "complete") {
  const baseline = read(path.join(artifacts, "baseline-package-identity.json"));
  const candidate = read(path.join(artifacts, "candidate-package-identity.json"));
  const installed = read(path.join(artifacts, "installed-package-identity.json"));
  write("channel-proof.json", {
    status: "passed",
    baseline: {
      sha256: baseline.sha256,
      integrity: baseline.integrity,
      buildInfo: baseline.buildInfo,
    },
    candidate: { sha256: candidate.sha256, buildInfo: candidate.buildInfo },
    installed: { buildInfo: installed.buildInfo },
    preservedConfigSha256: digest(JSON.stringify(projection())),
    baselineReceipt: read(path.join(artifacts, "channel-baseline-receipt.json")),
    candidateReceipt: read(path.join(artifacts, "channel-candidate-receipt.json")),
    update: {
      exit: Number(process.env.CHANNEL_UPDATE_EXIT),
      outcome: process.env.CHANNEL_UPDATE_OUTCOME,
      repair: false,
    },
    lifecycle:
      "native published update --no-restart; explicit owned stop/start; fixture children joined",
  });
} else if (mode === "turn") {
  assert(["baseline", "candidate"].includes(stage));
  const nonce = `OPENCLAW_E2E_CHANNEL_${stage.toUpperCase()}_${randomBytes(16).toString("hex").toUpperCase()}`;
  const sessionsResult = spawnSync("openclaw", ["sessions", "--json"], {
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(sessionsResult.status, 0, sessionsResult.stderr);
  const sessionsBefore = JSON.parse(sessionsResult.stdout);
  const before = (await request("/fixture/state")).body;
  assert(before.socketCount > 0, "No real channel worker socket");
  if (stage === "candidate") {
    const baseline = read(path.join(artifacts, "channel-baseline-receipt.json"));
    assert(
      before.socketGeneration > baseline.socketGeneration,
      "No new candidate channel connection",
    );
    assert(
      before.threadReplies.some((reply) => reply.id === baseline.reply.id),
      "Baseline transport state was not retained",
    );
    const retained = sessionsBefore.sessions.find(
      (session) =>
        session.sessionId === baseline.session.sessionId && session.key === baseline.session.key,
    );
    assert(retained, "Baseline native session identity was not retained");
    const history = spawnSync(
      "openclaw",
      [
        "gateway",
        "call",
        "chat.history",
        "--json",
        "--params",
        JSON.stringify({ sessionKey: retained.key, limit: 20 }),
      ],
      { encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
    );
    assert.equal(history.status, 0, history.stderr);
    assert(
      history.stdout.includes(baseline.nonce),
      "Baseline conversation missing from native Gateway history",
    );
  }
  const transport = await request("/fixture/inbound", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body: `Return marker ${nonce}` }),
  });
  const inbound = transport.body.message;
  assert(inbound?.id && inbound.body.includes(nonce));
  const deadline = Date.now() + 45000;
  let state, reply;
  while (Date.now() < deadline) {
    state = (await request("/fixture/state")).body;
    reply = state.threadReplies.find(
      (item) =>
        item.thread_root_id === inbound.id &&
        item.author?.kind === "bot" &&
        item.body.includes(nonce),
    );
    if (reply) {
      break;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
  }
  assert(reply, "No nonce-bound channel reply for this inbound message");
  const modelRequests = fs.readFileSync(process.env.MOCK_REQUEST_LOG, "utf8");
  assert(modelRequests.includes(nonce), "Nonce did not traverse the mock model");
  const sessionsAfter = spawnSync("openclaw", ["sessions", "--json"], {
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(sessionsAfter.status, 0, sessionsAfter.stderr);
  const sessions = JSON.parse(sessionsAfter.stdout).sessions.filter(
    (session) => session.key === "agent:main:clickclack:channel:channel:ch_general",
  );
  assert.equal(sessions.length, 1, "Expected the exact native ClickClack channel route");
  const session = sessions[0];
  assert(typeof session.sessionId === "string" && session.sessionId.length > 0);
  const expectedNonces = [nonce];
  if (stage === "candidate") {
    const baseline = read(path.join(artifacts, "channel-baseline-receipt.json"));
    assert.deepEqual({ key: session.key, sessionId: session.sessionId }, baseline.session);
    expectedNonces.push(baseline.nonce);
  }
  const history = spawnSync(
    "openclaw",
    [
      "gateway",
      "call",
      "chat.history",
      "--json",
      "--params",
      JSON.stringify({ sessionKey: session.key, limit: 20 }),
    ],
    { encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
  );
  assert.equal(history.status, 0, history.stderr);
  for (const expected of expectedNonces) {
    assert(history.stdout.includes(expected), "Native session history lost a channel turn");
  }
  write(`channel-${stage}-receipt.json`, {
    stage,
    nonce,
    session: { key: session.key, sessionId: session.sessionId },
    gatewayPid: Number(process.env.CHANNEL_GATEWAY_PID),
    transportStatus: transport.status,
    inbound,
    reply,
    socketGeneration: state.socketGeneration,
    modelRequestSha256: digest(modelRequests),
    at: new Date().toISOString(),
  });
} else {
  throw new Error("Expected snapshot, preserved, or turn");
}
