import { spawn } from "node:child_process";
import { mkdirSync, createWriteStream, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import https from "node:https";
import { createHash } from "node:crypto";
mkdirSync("test-artifacts", { recursive: true });
let dir = mkdtempSync(tmpdir() + "/gugu-workerd-");
let log = createWriteStream("test-artifacts/workerd.log");
const code = "test-only-activation-code-not-a-deployment-secret";
let child = spawn(
  process.execPath,
  [
    "node_modules/wrangler/bin/wrangler.js",
    "dev",
    "--local",
    "--ip",
    "0.0.0.0",
    "--port",
    "8787",
    "--local-protocol",
    "https",
    "--persist-to",
    dir,
    "--var",
    "SETUP_KEY_HASH:" + createHash("sha256").update(code).digest("hex"),
  ],
  {
    detached: true,
    env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
child.stdout.pipe(log);
child.stderr.pipe(log);
const health = () =>
  new Promise((resolve) => {
    let r = https.get(
      "https://localhost:8787/api/health",
      { rejectUnauthorized: false },
      (r) => {
        let b = "";
        r.on("data", (c) => (b += c));
        r.on("end", () => resolve(r.statusCode === 200));
      },
    );
    r.setTimeout(2000, () => r.destroy());
    r.on("error", () => resolve(false));
  });
try {
  let ready = false;
  for (let i = 0; i < 90; i++) {
    if (await health()) {
      ready = true;
      break;
    }
    if (child.exitCode !== null)
      throw Error("Wrangler failed, inspect workerd.log");
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!ready) throw Error("Wrangler readiness timeout");
  let run = spawn("python", ["tests/browser.py"], {
    env: { ...process.env, TEST_BASE: "https://localhost:8787" },
    stdio: "inherit",
  });
  let exit = await new Promise((r) => run.on("exit", r));
  if (exit !== 0) throw Error("Browser verification failed");
} finally {
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  log.end();
  setTimeout(() => rmSync(dir, { recursive: true, force: true }), 1500).unref();
}
