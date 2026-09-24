import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { onRequestPost } from "../functions/api/contact.js";

const ENDPOINT = "https://allenscarpetinc.com/api/contact";
const ENV = {
  RESEND_API_KEY: "test-api-key",
  CONTACT_FROM_EMAIL: "Allen's Carpet & Flooring <forms@allenscarpetinc.com>",
  TURNSTILE_SECRET_KEY: "test-turnstile-secret",
};

function mockDatabase() {
  const rateLimits = new Map();
  const fingerprints = new Map();

  return {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() {
              if (sql.includes("INSERT INTO contact_rate_limits")) {
                const attempts = (rateLimits.get(values[0]) || 0) + 1;
                rateLimits.set(values[0], attempts);
                return { attempts };
              }
              if (sql.includes("INSERT INTO contact_submission_fingerprints")) {
                if ((fingerprints.get(values[0]) || 0) > values[2]) return null;
                fingerprints.set(values[0], values[1]);
                return { fingerprint: values[0] };
              }
              throw new Error("Unexpected database query");
            },
            async run() {
              if (sql.includes("DELETE FROM contact_submission_fingerprints")) {
                fingerprints.delete(values[0]);
              }
              return { success: true };
            },
          };
        },
      };
    },
  };
}

function contactRequest(overrides = {}, headers = {}) {
  const fields = {
    Name: "Test Customer",
    Phone: "573-555-0100",
    "Flooring Type": "Carpet",
    "Project Details": "Two bedrooms",
    Website: "",
    "cf-turnstile-response": "valid-test-token",
    ...overrides,
  };
  const formData = new FormData();

  for (const [name, value] of Object.entries(fields)) {
    formData.set(name, value);
  }

  return new Request(ENDPOINT, {
    method: "POST",
    headers: {
      Origin: "https://allenscarpetinc.com",
      "X-Submission-ID": "submission-123",
      ...headers,
    },
    body: formData,
  });
}

function mockContext(request, emailResponse = new Response('{"id":"email-123"}'), database = mockDatabase()) {
  const calls = [];
  const turnstileCalls = [];

  return {
    calls,
    turnstileCalls,
    context: {
      request,
      env: { ...ENV, CONTACT_DB: database },
      data: {
        async turnstileFetch(url, options) {
          turnstileCalls.push({ url, options });
          return Response.json({ success: true, hostname: "allenscarpetinc.com", action: "flooring_estimate" });
        },
        async emailFetch(url, options) {
          calls.push({ url, options });
          return emailResponse;
        },
      },
    },
  };
}

test("one valid submission sends to the fixed customer destination and preserved CC", async () => {
  const { context, calls } = mockContext(contactRequest());
  const response = await onRequestPost(context);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.resend.com/emails");
  assert.equal(calls[0].options.method, "POST");
  assert.match(calls[0].options.headers["Idempotency-Key"], /^contact-form\/[a-f0-9]{64}$/);

  const email = JSON.parse(calls[0].options.body);
  assert.deepEqual(email.to, ["allenscarpet@hotmail.com"]);
  assert.deepEqual(email.cc, ["allensfloorinc@gmail.com"]);
  assert.equal(email.bcc, undefined);
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${ENV.RESEND_API_KEY}`);
  assert.equal(email.from, ENV.CONTACT_FROM_EMAIL);
  assert.equal(email.reply_to, undefined);
});

test("a supplied visitor email becomes Reply-To, never From", async () => {
  const { context, calls } = mockContext(
    contactRequest({ Email: "customer@example.com" }),
  );
  const response = await onRequestPost(context);
  const email = JSON.parse(calls[0].options.body);

  assert.equal(response.status, 200);
  assert.equal(email.reply_to, "customer@example.com");
  assert.equal(email.from, ENV.CONTACT_FROM_EMAIL);
});

test("submitted text is normalized before it is added to the email", async () => {
  const { context, calls } = mockContext(
    contactRequest({
      Name: "Test\r\nCustomer\u0000",
      "Project Details": "First line\r\nSecond line\u0007",
    }),
  );
  const response = await onRequestPost(context);
  const email = JSON.parse(calls[0].options.body);

  assert.equal(response.status, 200);
  assert.match(email.text, /^Name: Test Customer$/m);
  assert.match(email.text, /First line\nSecond line/);
  assert.doesNotMatch(email.text, /[\u0000\u0007\r]/);
});

test("recipient fields supplied by a visitor are rejected before email delivery", async () => {
  const { context, calls } = mockContext(
    contactRequest({ To: "attacker@example.com" }),
  );
  const response = await onRequestPost(context);

  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);
});

test("invalid required fields are rejected before email delivery", async () => {
  const { context, calls } = mockContext(contactRequest({ Phone: "invalid" }));
  const response = await onRequestPost(context);

  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);
});

test("cross-origin submissions are rejected", async () => {
  const { context, calls } = mockContext(
    contactRequest({}, { Origin: "https://example.com" }),
  );
  const response = await onRequestPost(context);

  assert.equal(response.status, 403);
  assert.equal(calls.length, 0);
});

test("an email-provider failure is reported as a failed submission", async () => {
  const { context, calls } = mockContext(
    contactRequest(),
    new Response('{"message":"provider error"}', { status: 500 }),
  );
  const response = await onRequestPost(context);
  const result = await response.json();

  assert.equal(response.status, 502);
  assert.equal(result.ok, false);
  assert.equal(calls.length, 1);
});

test("missing server-side email configuration never reports success", async () => {
  const { context, calls } = mockContext(contactRequest());
  context.env = {};
  const response = await onRequestPost(context);
  const result = await response.json();

  assert.equal(response.status, 503);
  assert.equal(result.ok, false);
  assert.equal(calls.length, 0);
});

test("the honeypot absorbs automated submissions without sending email", async () => {
  const { context, calls } = mockContext(
    contactRequest({ Website: "https://spam.example" }),
  );
  const response = await onRequestPost(context);

  assert.equal(response.status, 200);
  assert.equal(calls.length, 0);
});

test("a missing or invalid Turnstile token cannot send email", async () => {
  const missing = mockContext(contactRequest({ "cf-turnstile-response": "" }));
  assert.equal((await onRequestPost(missing.context)).status, 400);
  assert.equal(missing.calls.length, 0);

  const invalid = mockContext(contactRequest());
  invalid.context.data.turnstileFetch = async () => Response.json({ success: false });
  assert.equal((await onRequestPost(invalid.context)).status, 403);
  assert.equal(invalid.calls.length, 0);
});

test("Turnstile verification checks the action and hostname", async () => {
  const { context, calls, turnstileCalls } = mockContext(contactRequest());
  context.data.turnstileFetch = async (url, options) => {
    turnstileCalls.push({ url, options });
    return Response.json({ success: true, hostname: "other.example", action: "flooring_estimate" });
  };

  assert.equal((await onRequestPost(context)).status, 403);
  assert.equal(turnstileCalls[0].url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
  assert.equal(turnstileCalls[0].options.body.get("secret"), ENV.TURNSTILE_SECRET_KEY);
  assert.equal(calls.length, 0);
});

test("links in names, multiple URLs, and solicitation text are rejected", async () => {
  for (const fields of [
    { Name: "https://spam.example" },
    { "Project Details": "See https://one.example and https://two.example" },
    { "Project Details": "We offer SEO and lead generation services" },
    { "Project Details": "We offer web-design services" },
    { "Project Details": "We can boost your marketing results" },
    { "Project Details": "Invest in crypto today" },
  ]) {
    const { context, calls } = mockContext(contactRequest(fields));
    assert.equal((await onRequestPost(context)).status, 400);
    assert.equal(calls.length, 0);
  }
});

test("ordinary flooring requests with one product link still send", async () => {
  const { context, calls } = mockContext(contactRequest({
    "Project Details": "I need carpet for a marketing office. A sample I like is https://example.com/carpet",
  }));

  assert.equal((await onRequestPost(context)).status, 200);
  assert.equal(calls.length, 1);
});

test("a repeated identical request is rejected without another email", async () => {
  const database = mockDatabase();
  const first = mockContext(contactRequest(), undefined, database);
  const second = mockContext(contactRequest(), undefined, database);

  assert.equal((await onRequestPost(first.context)).status, 200);
  assert.equal((await onRequestPost(second.context)).status, 409);
  assert.equal(first.calls.length, 1);
  assert.equal(second.calls.length, 0);
});

test("repeated requests are rate limited before email delivery", async () => {
  const database = mockDatabase();
  const statuses = [];
  let sent = 0;

  for (let index = 0; index < 9; index += 1) {
    const { context, calls } = mockContext(
      contactRequest({ "Project Details": `Bedroom ${index}` }),
      undefined,
      database,
    );
    statuses.push((await onRequestPost(context)).status);
    sent += calls.length;
  }

  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200, 200, 200, 429]);
  assert.equal(sent, 8);
});

test("failed email delivery releases the duplicate reservation for a retry", async () => {
  const database = mockDatabase();
  const failed = mockContext(
    contactRequest(),
    new Response("provider error", { status: 500 }),
    database,
  );
  const retry = mockContext(contactRequest(), undefined, database);

  assert.equal((await onRequestPost(failed.context)).status, 502);
  assert.equal((await onRequestPost(retry.context)).status, 200);
  assert.equal(retry.calls.length, 1);
});

test("a missing D1 binding prevents form delivery", async () => {
  const { context, calls } = mockContext(contactRequest());
  delete context.env.CONTACT_DB;

  assert.equal((await onRequestPost(context)).status, 503);
  assert.equal(calls.length, 0);
});

test("invalid phone digits and unsupported flooring choices cannot send", async () => {
  for (const fields of [{ Phone: "-------" }, { "Flooring Type": "SEO services" }]) {
    const { context, calls } = mockContext(contactRequest(fields));
    assert.equal((await onRequestPost(context)).status, 400);
    assert.equal(calls.length, 0);
  }
});

test("oversized requests are rejected even without Content-Length", async () => {
  const { context, calls } = mockContext(new Request(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ "Project Details": "x".repeat(20000) }).toString(),
  }));
  assert.equal(context.request.headers.has("Content-Length"), false);
  assert.equal((await onRequestPost(context)).status, 413);
  assert.equal(calls.length, 0);
});

test("duplicate, unexpected, and uploaded fields cannot send", async () => {
  for (const kind of ["duplicate", "unexpected", "upload"]) {
    const original = contactRequest();
    const data = await original.formData();
    if (kind === "duplicate") data.append("Name", "Another name");
    if (kind === "unexpected") data.append("cC", "other@example.com");
    if (kind === "upload") data.set("Website", new Blob(["bot"]), "bot.txt");
    const { context, calls } = mockContext(new Request(ENDPOINT, { method: "POST", body: data }));
    assert.equal((await onRequestPost(context)).status, 400);
    assert.equal(calls.length, 0);
  }
});

test("wrong Turnstile action and unavailable verification fail closed", async () => {
  for (const verify of [
    async () => Response.json({ success: true, hostname: "allenscarpetinc.com", action: "wrong" }),
    async () => { throw new Error("network failure"); },
    async () => new Response("unavailable", { status: 503 }),
  ]) {
    const { context, calls } = mockContext(contactRequest());
    context.data.turnstileFetch = verify;
    assert.equal((await onRequestPost(context)).status, 403);
    assert.equal(calls.length, 0);
  }
});

test("missing secrets fail closed individually", async () => {
  for (const key of ["TURNSTILE_SECRET_KEY", "RESEND_API_KEY", "CONTACT_FROM_EMAIL"]) {
    const { context, calls } = mockContext(contactRequest());
    delete context.env[key];
    assert.equal((await onRequestPost(context)).status, 503);
    assert.equal(calls.length, 0);
  }
});

test("real SQLite migration supports handler writes, duplicates, failures, and rate limits", async () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    const migration = readFileSync(new URL("../migrations/0001_contact_protection.sql", import.meta.url), "utf8");
    sqlite.exec(migration);
    sqlite.exec(migration); // Safe to run again.
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'index' AND name LIKE '%_expiry'").get().n, 2);
    const db = {
      prepare(sql) {
        return { bind(...values) {
          return {
            async first() { return sqlite.prepare(sql).get(...values) ?? null; },
            async run() { sqlite.prepare(sql).run(...values); return { success: true }; },
          };
        } };
      },
    };
    const count = (table) => sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
    const first = mockContext(contactRequest(), undefined, db);
    assert.equal((await onRequestPost(first.context)).status, 200);
    assert.equal(count("contact_rate_limits"), 1);
    assert.equal(count("contact_submission_fingerprints"), 1);
    const rate = sqlite.prepare("SELECT * FROM contact_rate_limits").get();
    assert.match(rate.key, /^[a-f0-9]{64}:\d+$/);
    assert.equal(rate.attempts, 1);
    assert.ok(rate.expires_at > Date.now() / 1000);

    const duplicate = mockContext(contactRequest(), undefined, db);
    assert.equal((await onRequestPost(duplicate.context)).status, 409);
    assert.equal(duplicate.calls.length, 0);
    assert.equal(count("contact_submission_fingerprints"), 1);

    const failure = mockContext(contactRequest({ "Project Details": "A different project" }), new Response("error", { status: 500 }), db);
    assert.equal((await onRequestPost(failure.context)).status, 502);
    assert.equal(count("contact_submission_fingerprints"), 1);

    for (let n = 4; n <= 9; n++) {
      const invalid = mockContext(contactRequest(), undefined, db);
      invalid.context.data.turnstileFetch = async () => Response.json({ success: false });
      assert.equal((await onRequestPost(invalid.context)).status, n <= 8 ? 403 : 429);
      assert.equal(invalid.calls.length, 0);
    }
    assert.equal(sqlite.prepare("SELECT attempts FROM contact_rate_limits").get().attempts, 9);
    assert.equal(count("contact_submission_fingerprints"), 1);
  } finally {
    sqlite.close();
  }
});
