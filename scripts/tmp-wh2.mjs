import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import pg from "pg";

const env = {};
for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const e = t.indexOf("=");
  if (e > 0) env[t.slice(0, e).trim()] = t.slice(e + 1).trim();
}

const TAG = `zz${Date.now()}`;
const mock = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://mock");
  console.log("MOCK HIT:", req.method, url.pathname);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ id: "lg-x", field_data: [{ name: "full_name", values: ["Zed"] }] }));
});
await new Promise((resolve) => mock.listen(8101, "127.0.0.1", resolve));
console.log("mock listening");

const BASE = "http://127.0.0.1:4000";
async function post(path, body, cookie, ip) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
    redirect: "manual",
  });
  const json = await res.json().catch(() => null);
  const sc = res.headers.get("set-cookie") ?? "";
  const m = sc.match(/lf_session=([^;]*)/);
  return { status: res.status, json, cookie: m ? `lf_session=${m[1]}` : cookie };
}

const email = `${TAG}@example.invalid`;
await post("/api/auth/register", { email, password: "correct horse battery staple 12" }, undefined, "10.76.1.1");
const login = await post("/api/auth/login", { email, password: "correct horse battery staple 12" }, undefined, "10.76.1.2");
const cookie = login.cookie;
const biz = (await post("/api/businesses", { name: `${TAG}-biz` }, cookie, "10.76.1.3")).json.business;

const { encryptToken } = await import("../src/lib/integrations/meta/crypto.ts");
const { randomUUID } = await import("node:crypto");
const c = new pg.Client({ connectionString: env.DATABASE_URL });
await c.connect();
const ct = await encryptToken("EAA-x", env.META_TOKEN_KEY);
await c.query(
  `INSERT INTO "MetaConnection" ("id","businessId","metaUserId","metaUserName","accessTokenEncrypted","scopes","status","updatedAt")
   VALUES ($1,$2,'mu','MU',$3,'x','ACTIVE',NOW())`,
  [randomUUID(), biz.id, ct]
);
await c.query(
  `INSERT INTO "MetaPage" ("id","businessId","metaPageId","name","pageTokenEncrypted","tasks","selectedAt","updatedAt")
   VALUES ($1,$2,$3,'P',$4,'ADVERTISE',NOW(),NOW())`,
  [randomUUID(), biz.id, `page-${TAG}`, ct]
);
await c.query(
  `INSERT INTO "MetaForm" ("id","businessId","metaPageId","metaFormId","name","status","connectedAt","updatedAt")
   VALUES ($1,$2,$3,$4,'F','ACTIVE',NOW(),NOW())`,
  [randomUUID(), biz.id, `page-${TAG}`, `form-${TAG}`]
);

const payload = {
  object: "page",
  entry: [{ id: `page-${TAG}`, time: 1, changes: [{ field: "leadgen", value: { leadgen_id: `lg-${TAG}`, page_id: `page-${TAG}`, form_id: `form-${TAG}` } }] }],
};
const raw = JSON.stringify(payload);
const sig = `sha256=${crypto.createHmac("sha256", env.META_APP_SECRET).update(raw, "utf8").digest("hex")}`;
const res = await fetch(`${BASE}/api/webhooks/meta`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-hub-signature-256": sig },
  body: raw,
  redirect: "manual",
});
console.log("webhook", res.status, JSON.stringify(await res.json()));
console.log("events", JSON.stringify((await c.query(`SELECT "status","attempts","lastError" FROM "MetaLeadEvent" WHERE "businessId" = $1`, [biz.id])).rows));

// cleanup
const u = await c.query(`SELECT id FROM "User" WHERE email = $1`, [email]);
const ids = u.rows.map((r) => r.id);
for (const t of ["MetaLeadEvent", "LeadActivity", "Lead", "MetaForm", "MetaPage", "MetaConnection", "BusinessMember"]) {
  await c.query(`DELETE FROM "${t}" WHERE "businessId" = $1`, [biz.id]);
}
await c.query(`DELETE FROM "Business" WHERE id = $1`, [biz.id]);
await c.query(`DELETE FROM "PasswordResetToken" WHERE "userId" = ANY($1)`, [ids]);
await c.query(`DELETE FROM "Session" WHERE "userId" = ANY($1)`, [ids]);
await c.query(`DELETE FROM "BusinessMember" WHERE "userId" = ANY($1)`, [ids]);
await c.query(`DELETE FROM "User" WHERE id = ANY($1)`, [ids]);
await c.end();
mock.close();
