// LeadFlow BD infrastructure smoke tests (Node built-in test runner, no extra deps).
// Run: npm test
// Requires: Docker services up (`docker compose up -d`) and a local `.env` file.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { Client } from "pg";

const ROOT = path.join(import.meta.dirname, "..");

function readFile(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

/** Minimal .env parser: ignores comments/blank lines, strips surrounding quotes. */
function loadDotEnv(rel) {
  const out = {};
  for (const line of readFile(rel).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

describe("project structure", () => {
  it("required config files exist", () => {
    for (const f of [
      "package.json",
      "tsconfig.json",
      "eslint.config.mjs",
      "next.config.ts",
      "postcss.config.mjs",
      "docker-compose.yml",
      ".env.example",
      "prisma.config.ts",
      "src/prisma/contract.ts",
      "src/prisma/contract.json",
      "src/lib/env.ts",
      "app/layout.tsx",
      "app/globals.css",
    ]) {
      assert.ok(fs.existsSync(path.join(ROOT, f)), `missing file: ${f}`);
    }
  });

  it("docs are present", () => {
    for (const f of [
      "docs/PRODUCT_SPEC.md",
      "docs/ARCHITECTURE.md",
      "docs/DATABASE.md",
      "docs/DEVELOPMENT.md",
      "README.md",
    ]) {
      assert.ok(fs.existsSync(path.join(ROOT, f)), `missing doc: ${f}`);
    }
  });
});

describe("environment structure", () => {
  it(".env.example documents infra vars without real secrets", () => {
    const example = readFile(".env.example");
    for (const key of ["DATABASE_URL", "REDIS_URL", "POSTGRES_PASSWORD", "NEXTAUTH_SECRET"]) {
      assert.ok(example.includes(key), `.env.example missing ${key}`);
    }
    assert.ok(example.includes("change-me"), ".env.example should use placeholder secrets");
    assert.ok(
      !example.includes("leadflow_password"),
      ".env.example must not contain real-looking credentials"
    );
  });

  it("local .env points at local Docker services", () => {
    assert.ok(fs.existsSync(path.join(ROOT, ".env")), "missing local .env (copy .env.example)");
    const env = loadDotEnv(".env");
    assert.ok(env.DATABASE_URL, "DATABASE_URL missing in .env");
    assert.ok(env.REDIS_URL, "REDIS_URL missing in .env");
    assert.ok(
      env.DATABASE_URL.includes("@localhost:"),
      "DATABASE_URL should target local Docker PostgreSQL"
    );
    assert.ok(
      env.REDIS_URL.includes("localhost:"),
      "REDIS_URL should target local Docker Redis"
    );
  });
});

describe("docker services", { timeout: 15000 }, () => {
  it("postgresql accepts connections and answers SELECT 1", async () => {
    const env = loadDotEnv(".env");
    const pg = new Client({ connectionString: env.DATABASE_URL });
    await pg.connect();
    try {
      const res = await pg.query("SELECT 1 AS ok");
      assert.deepEqual(res.rows, [{ ok: 1 }]);
    } finally {
      await pg.end();
    }
  });

  it("redis answers PING with PONG", async () => {
    const env = loadDotEnv(".env");
    const url = new URL(env.REDIS_URL);
    const reply = await new Promise((resolve, reject) => {
      const socket = net.createConnection(
        { host: url.hostname, port: Number(url.port || 6379) },
        () => socket.write("PING\r\n")
      );
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("redis timeout"));
      }, 5000);
      socket.on("data", (chunk) => {
        clearTimeout(timer);
        socket.end();
        resolve(chunk.toString().trim());
      });
      socket.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    assert.equal(reply, "+PONG");
  });
});
