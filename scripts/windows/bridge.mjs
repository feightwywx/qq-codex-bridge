import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { QqGateway } from "../../dist/packages/adapters/qq/src/qq-gateway.js";
import { QqGatewayClient } from "../../dist/packages/adapters/qq/src/qq-gateway-client.js";
import { QqApiClient } from "../../dist/packages/adapters/qq/src/qq-api-client.js";
import { CodexAppServerDriver } from "../../dist/packages/adapters/codex-desktop/src/codex-app-server-driver.js";
import { createSqliteDatabase } from "../../dist/packages/store/src/sqlite.js";
import { runBridgeDaemon } from "../../dist/apps/bridge-daemon/src/main.js";

import { SqliteSessionStore } from "../../dist/packages/store/src/session-repo.js";

const local = (name) => fileURLToPath(new URL(name, import.meta.url));
const runtimeDirectory = local("../../runtime/windows");
const ownerFile = local("../../runtime/windows/owner.txt");
const pairingFile = local("../../runtime/windows/pairing.json");
mkdirSync(runtimeDirectory, { recursive: true });

if (process.argv[2] === "--pair") {
  const code = "pair " + randomBytes(8).toString("hex");
  writeFileSync(pairingFile, JSON.stringify({ code, expires: Date.now() + 300_000 }));
  console.log(code);
  process.exit(0);
}

const owners = new Set();
try {
  for (const owner of readFileSync(ownerFile, "utf8").split(/\s+/).filter(Boolean)) owners.add(owner);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const { QQBOT_APP_ID: appId, QQBOT_CLIENT_SECRET: secret } = process.env;
if (!appId?.trim() || !secret?.trim()) throw new Error("Missing QQ credentials");
if (!process.env.CODEX_BINARY_PATH) throw new Error("Start through scripts/windows/start.ps1");

for (const key of Object.keys(process.env)) {
  if (/^(?:QQBOTS_JSON|QQBOT_ACCOUNTS_JSON|QQBOT_ACCOUNT_IDS|WEIXIN_ACCOUNTS_JSON|WEIXIN_ACCOUNT_IDS|CODEX_APP_SERVER_URL|CODEX_DESKTOP_TRANSPORT|CODEX_APP_SERVER_FORWARD_UI_EVENTS)$/.test(key)) {
    delete process.env[key];
  }
}
const databasePath = local("../../runtime/windows/bridge.sqlite");
Object.assign(process.env, {
  QQ_CODEX_DATABASE_PATH: databasePath,
  QQ_CODEX_LISTEN_HOST: "127.0.0.1",
  QQ_CODEX_LISTEN_PORT: "38124",
  WEIXIN_ENABLED: "false",
  BRIDGE_CONVERSATION_PROVIDER: "codex-desktop",
});

const reply = new QqApiClient(appId, secret);
const dispatch = QqGateway.prototype.dispatchPayload;
QqGateway.prototype.dispatchPayload = async function (event) {
  if (event.t !== "C2C_MESSAGE_CREATE") return;
  const sender = event.d?.author?.user_openid;
  if (!sender) return;
  if (!owners.has(sender)) {
    let pairing;
    try { pairing = JSON.parse(readFileSync(pairingFile, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (Date.now() >= pairing.expires || event.d.content?.trim() !== pairing.code) return;
    writeFileSync(ownerFile, [...owners, sender].join("\n") + "\n");
    owners.add(sender);
    unlinkSync(pairingFile);
    console.info("Additional QQ private account paired");
    await reply.sendC2CMessage(sender, "配对成功。发 /threads 查看对话。", event.d.id);
    return;
  }
  await dispatch.call(this, event);
};
const handleDispatch = QqGatewayClient.prototype.handleDispatch;
QqGatewayClient.prototype.handleDispatch = async function (event) {
  await handleDispatch.call(this, event);
  if (event.t === "READY" || event.t === "RESUMED") console.info("QQ gateway authenticated:", event.t);
};

const db = createSqliteDatabase(databasePath);
const binding = db.prepare("SELECT codex_thread_ref FROM bridge_sessions WHERE session_key = ? AND status = 'active'");
SqliteSessionStore.prototype.updateBinding = async function (sessionKey, threadRef) {
  this.db.prepare(`
    UPDATE bridge_sessions
    SET codex_thread_ref = ?, status = 'active', last_error = NULL
    WHERE session_key = ?
  `).run(threadRef, sessionKey);
};

const updateSessionStatus = SqliteSessionStore.prototype.updateSessionStatus;
SqliteSessionStore.prototype.updateSessionStatus = async function (sessionKey, status, error) {
  if (status === "needs_rebind" && error?.includes("already has an active writer")) {
    status = "active";
  }
  await updateSessionStatus.call(this, sessionKey, status, error);
};

const inboundThreads = new AsyncLocalStorage();
const threadUsers = new Map();
const request = CodexAppServerDriver.prototype.request;
CodexAppServerDriver.prototype.request = async function (method, params) {
  const context = inboundThreads.getStore();
  const threads = context?.threads;
  const track = (threadId) => {
    if (!threadId || threads.has(threadId)) return;
    threads.set(threadId, this);
    threadUsers.set(threadId, (threadUsers.get(threadId) ?? 0) + 1);
  };
  if (threads && method === "thread/resume") track(params.threadId);
  if (method === "turn/start" && context?.resumeErrors.has(params.threadId)) {
    throw context.resumeErrors.get(params.threadId);
  }
  let result;
  try {
    result = await request.call(this, method, params);
  } catch (error) {
    if (context && method === "thread/resume") context.resumeErrors.set(params.threadId, error);
    throw error;
  }
  if (threads && (method === "thread/start" || method === "thread/fork")) track(result.thread?.id);
  return result;
};
const onMessage = QqGatewayClient.prototype.onMessage;
QqGatewayClient.prototype.onMessage = function (handler) {
  return onMessage.call(this, async (message) => {
    if (!message.text.trim().startsWith("/") && !binding.get(message.sessionKey)?.codex_thread_ref) {
      await reply.sendC2CMessage(message.senderId, "请先发 /threads 并用 /thread use 序号绑定对话，或用 /thread new 标题新建对话。", message.messageId);
      return;
    }
    const threads = new Map();
    try {
      await inboundThreads.run({ threads, resumeErrors: new Map() }, () => handler(message));
    } finally {
      for (const [threadId, client] of threads) {
        const remaining = threadUsers.get(threadId) - 1;
        if (remaining > 0) {
          threadUsers.set(threadId, remaining);
          continue;
        }
        threadUsers.delete(threadId);
        try {
          const { status } = await request.call(client, "thread/unsubscribe", { threadId });
          console.info("Codex thread subscription released:", status);
        } catch (error) {
          console.error("Codex thread release failed:", error.message);
        }
      }
    }
  });
};

const appServerUrl = "ws://127.0.0.1:38125";
const driver = new CodexAppServerDriver({ appServerUrl });
const appServer = spawn(process.env.CODEX_BINARY_PATH, [
  "app-server", "--listen", appServerUrl,
  "-c", "analytics.enabled=false",
  "-c", "thread_unload_delay_secs=2",
], { stdio: ["ignore", "ignore", "inherit"], windowsHide: true });
let runtime;
let stopping = false;
async function stop(code) {
  if (stopping) return;
  stopping = true;
  try { await runtime?.shutdown(); }
  finally {
    db.close();
    driver.socket?.close();
    appServer.kill();
    process.exit(code);
  }
}
appServer.once("error", (error) => { console.error(error.message); void stop(1); });
appServer.once("exit", () => void stop(1));
process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));
try {
  await driver.ensureAppReady();
  process.env.CODEX_APP_SERVER_URL = appServerUrl;

  runtime = await runBridgeDaemon();
} catch (error) {
  console.error("Bridge startup failed:", error.message);
  await stop(1);
}
