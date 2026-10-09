// Test-only HTTPS host for the unmodified Worker and a transactional SQLite D1 adapter.
import https from "node:https";
import { readFileSync, existsSync } from "node:fs";
import { resolve, extname } from "node:path";
import worker, { hash } from "../src/worker.mjs";
import { LocalD1 } from "./adapter.mjs";
const root = resolve("public"),
  DB = new LocalD1(process.env.TEST_DB || ":memory:");
let env = {
  DB,
  SETUP_KEY_HASH: await hash(
    "test-only-activation-code-not-a-deployment-secret",
  ),
  ASSETS: {
    fetch: async (req) => {
      let p = resolve(root, "." + new URL(req.url).pathname);
      if (!p.startsWith(root + "/")) p = root + "/index.html";
      if (!existsSync(p) || !extname(p)) p = root + "/index.html";
      return new Response(readFileSync(p), {
        headers: {
          "content-type":
            {
              ".html": "text/html",
              ".js": "text/javascript",
              ".css": "text/css",
              ".svg": "image/svg+xml",
              ".webp": "image/webp",
            }[extname(p)] || "application/octet-stream",
        },
      });
    },
  },
};
https
  .createServer(
    {
      cert: readFileSync(process.env.TEST_CERT),
      key: readFileSync(process.env.TEST_KEY),
    },
    async (req, res) => {
      try {
        let chunks = [];
        for await (const c of req) chunks.push(c);
        let url = "https://localhost:" + process.env.TEST_PORT + req.url,
          body = Buffer.concat(chunks),
          r = await worker.fetch(
            new Request(url, {
              method: req.method,
              headers: req.headers,
              ...(["GET", "HEAD"].includes(req.method) ? {} : { body }),
            }),
            env,
            {},
          );
        res.writeHead(r.status, Object.fromEntries(r.headers));
        res.end(Buffer.from(await r.arrayBuffer()));
      } catch {
        res.writeHead(500);
        res.end("Test host error");
      }
    },
  )
  .listen(Number(process.env.TEST_PORT), "0.0.0.0", () =>
    console.log("Test host ready"),
  );
