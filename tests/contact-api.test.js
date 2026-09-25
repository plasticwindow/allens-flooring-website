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
  const submissions = [];

  return {
    submissions,
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
              if (sql.includes("INSERT INTO contact_submissions")) {
                const [id, email, marketing_consent, consent_at, submitted_at, form_source] = values;
                submissions.push({ id, email, marketing_consent, consent_at, submitted_at, form_source });
              }
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
    "Form Source": "/",
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
  assert.match(email.text, /^Email: customer@example.com$/m);
});

test("missing, empty, and whitespace-only optional email and unchecked consent still submit", async () => {
  for (const fields of [{}, { Email: "" }, { Email: "   " }]) {
    const db = mockDatabase();
    const { context, calls } = mockContext(contactRequest(fields), undefined, db);
    assert.equal((await onRequestPost(context)).status, 200);
    assert.equal(db.submissions.length, 1);
    assert.equal(db.submissions[0].email, null);
    assert.equal(db.submissions[0].marketing_consent, 0);
    assert.equal(db.submissions[0].consent_at, null);
    const email = JSON.parse(calls[0].options.body);
    assert.equal(email.reply_to, undefined);
    assert.match(email.text, /^Marketing consent: No$/m);
  }
});

test("only the checkbox's explicit yes value records consent, with or without email", async () => {
  for (const email of ["", " Customer+Flooring@Example.com "]) {
    for (const consent of ["yes", "", "false", "true", "0", "1", "on", "YES"]) {
      const db = mockDatabase();
      const before = Math.floor(Date.now() / 1000);
      const { context, calls } = mockContext(contactRequest({
        Email: email, "Marketing Consent": consent, "Form Source": "/contact",
      }), undefined, db);
      assert.equal((await onRequestPost(context)).status, 200);
      const record = db.submissions[0];
      assert.equal(record.email, email.trim().toLowerCase() || null);
      assert.equal(record.marketing_consent, consent === "yes" ? 1 : 0);
      assert.equal(record.consent_at, consent === "yes" ? record.submitted_at : null);
      assert.ok(record.submitted_at >= before && record.submitted_at <= Date.now() / 1000);
      assert.equal(record.form_source, "/contact");
      const notification = JSON.parse(calls[0].options.body);
      assert.match(notification.text, /Form source: \/contact/);
      if (consent === "yes") {
        assert.match(notification.text, /Marketing consent: Yes \(explicitly checked\)/);
      } else {
        assert.match(notification.text, /Marketing consent: No/);
        assert.doesNotMatch(notification.text, /Consent recorded at:/);
      }
    }
  }
});

test("invalid optional addresses are rejected without storing or sending", async () => {
  for (const Email of ["invalid", "a@@example.com", "a b@example.com", "a@-example.com",
    "a@example..com", "a\u0000@example.com", "a\r\n@example.com", ".a@example.com", "a..b@example.com", "a".repeat(255)]) {
    const db = mockDatabase();
    const { context, calls } = mockContext(contactRequest({ Email }), undefined, db);
    assert.equal((await onRequestPost(context)).status, 400, Email);
    assert.equal(calls.length, 0);
    assert.equal(db.submissions.length, 0);
  }
});

test("source metadata is bounded and legacy submissions are marked unknown", async () => {
  const request = contactRequest();
  const fields = await request.formData();
  fields.delete("Form Source");
  const db = mockDatabase();
  const legacy = mockContext(new Request(ENDPOINT, { method: "POST", body: fields }), undefined, db);
  assert.equal((await onRequestPost(legacy.context)).status, 200);
  assert.equal(db.submissions[0].form_source, "unknown");
  for (const source of ["https://example.com", "/contact?private=secret", "/other"]) {
    const { context, calls } = mockContext(contactRequest({ "Form Source": source }));
    assert.equal((await onRequestPost(context)).status, 400);
    assert.equal(calls.length, 0);
  }
});

test("changing consent or source cannot bypass duplicates or change stored consent", async () => {
  const db = mockDatabase();
  const first = mockContext(contactRequest({ Email: "customer@example.com" }), undefined, db);
  assert.equal((await onRequestPost(first.context)).status, 200);
  const duplicate = mockContext(contactRequest({ Email: "customer@example.com",
    "Marketing Consent": "yes", "Form Source": "/contact" }), undefined, db);
  assert.equal((await onRequestPost(duplicate.context)).status, 409);
  assert.equal(duplicate.calls.length, 0);
  assert.equal(db.submissions.length, 1);
  assert.equal(db.submissions[0].marketing_consent, 0);
});

test("storage failure prevents delivery and releases the reservation for retry", async () => {
  const db = mockDatabase();
  const failingDb = { prepare(sql) {
    if (sql.includes("INSERT INTO contact_submissions")) {
      return { bind() { return { async run() { throw new Error("storage failed"); } }; } };
    }
    return db.prepare(sql);
  } };
  const failed = mockContext(contactRequest(), undefined, failingDb);
  assert.equal((await onRequestPost(failed.context)).status, 503);
  assert.equal(failed.calls.length, 0);
  assert.equal(db.submissions.length, 0);
  const retry = mockContext(contactRequest(), undefined, db);
  assert.equal((await onRequestPost(retry.context)).status, 200);
  assert.equal(db.submissions.length, 1);
});

test("honeypot, spam, and failed verification never store customer email or consent", async () => {
  for (const fields of [{ Website: "bot" }, { "Project Details": "Buy bitcoin" },
    { "cf-turnstile-response": "" }, { "cf-turnstile-response": "invalid" }]) {
    const db = mockDatabase();
    const { context, calls } = mockContext(contactRequest({
      Email: "customer@example.com", "Marketing Consent": "yes", ...fields,
    }), undefined, db);
    context.data.turnstileFetch = async () => Response.json({ success: false });
    await onRequestPost(context);
    assert.equal(calls.length, 0);
    assert.equal(db.submissions.length, 0);
  }
});

test("email payload and idempotency key remain stable across a delayed retry", async (t) => {
  const db = mockDatabase();
  const fields = { Email: "customer@example.com", "Marketing Consent": "yes" };
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  const failed = mockContext(contactRequest(fields), new Response("error", { status: 500 }), db);
  assert.equal((await onRequestPost(failed.context)).status, 502);
  t.mock.method(Date, "now", () => now + 30000);
  const retry = mockContext(contactRequest(fields), undefined, db);
  assert.equal((await onRequestPost(retry.context)).status, 200);
  assert.equal(failed.calls[0].options.body, retry.calls[0].options.body);
  assert.equal(failed.calls[0].options.headers["Idempotency-Key"], retry.calls[0].options.headers["Idempotency-Key"]);
});

test("Siteverify diagnostics contain only approved fields and verify exactly once", async (t) => {
  const logs = [];
  t.mock.method(console, "info", (...args) => logs.push(args));
  const { context, calls, turnstileCalls } = mockContext(contactRequest());
  context.data.turnstileFetch = async (url, options) => {
    turnstileCalls.push({ url, options });
    return Response.json({ success: false, "error-codes": ["invalid-input-secret"],
      hostname: "allenscarpetinc.com", action: "flooring_estimate",
      secret: ENV.TURNSTILE_SECRET_KEY, token: "valid-test-token", customer: "Test Customer" });
  };
  assert.equal((await onRequestPost(context)).status, 403);
  assert.equal(calls.length, 0);
  assert.equal(turnstileCalls.length, 1);
  assert.equal(turnstileCalls[0].options.body.get("response"), "valid-test-token");
  assert.equal(turnstileCalls[0].options.body.get("secret"), ENV.TURNSTILE_SECRET_KEY);
  assert.deepEqual(logs, [["Turnstile Siteverify diagnostic", {
    success: false, "error-codes": ["invalid-input-secret"],
    hostname: "allenscarpetinc.com", action: "flooring_estimate",
    expectedHostname: "allenscarpetinc.com", expectedAction: "flooring_estimate",
  }]]);
});

test("verification transport and JSON failures log no exception details", async (t) => {
  const logs = [];
  t.mock.method(console, "info", (...args) => logs.push(args));
  for (const verify of [
    async () => { throw new Error(ENV.TURNSTILE_SECRET_KEY); },
    async () => new Response("not JSON"),
  ]) {
    const { context, calls } = mockContext(contactRequest());
    context.data.turnstileFetch = verify;
    assert.equal((await onRequestPost(context)).status, 403);
    assert.equal(calls.length, 0);
  }
  assert.equal(logs.length, 2);
  for (const [, fields] of logs) {
    assert.deepEqual(fields, { success: null, "error-codes": [], hostname: null,
      action: null, expectedHostname: "allenscarpetinc.com", expectedAction: "flooring_estimate" });
  }
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
  assert.equal(database.submissions.length, 8);
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
  for (const kind of ["duplicate", "duplicate-email", "duplicate-consent", "duplicate-source", "unexpected", "upload"]) {
    const original = contactRequest();
    const data = await original.formData();
    if (kind === "duplicate") data.append("Name", "Another name");
    if (kind === "duplicate-email") { data.append("Email", "one@example.com"); data.append("Email", "two@example.com"); }
    if (kind === "duplicate-consent") { data.append("Marketing Consent", "yes"); data.append("Marketing Consent", "false"); }
    if (kind === "duplicate-source") data.append("Form Source", "/contact");
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

test("consent migration is additive and preserves existing protection and consent data on rerun", () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec(readFileSync(new URL("../migrations/0001_contact_protection.sql", import.meta.url), "utf8"));
    sqlite.exec("INSERT INTO contact_rate_limits VALUES ('existing-key', 123456, 7)");
    sqlite.exec("INSERT INTO contact_submission_fingerprints VALUES ('existing-fingerprint', 123456)");
    const migration = readFileSync(new URL("../migrations/0002_contact_submissions.sql", import.meta.url), "utf8");
    sqlite.exec(migration);
    sqlite.exec("INSERT INTO contact_submissions VALUES ('existing-record', 'customer@example.com', 1, 123, 123, '/')");
    sqlite.exec(migration);
    assert.equal(sqlite.prepare("SELECT attempts FROM contact_rate_limits").get().attempts, 7);
    assert.equal(sqlite.prepare("SELECT fingerprint FROM contact_submission_fingerprints").get().fingerprint, "existing-fingerprint");
    assert.equal(sqlite.prepare("SELECT consent_at FROM contact_submissions").get().consent_at, 123);
  } finally {
    sqlite.close();
  }
});

test("real SQLite migration supports handler writes, duplicates, failures, and rate limits", async () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    const migration = readFileSync(new URL("../migrations/0001_contact_protection.sql", import.meta.url), "utf8");
    sqlite.exec(migration);
    sqlite.exec(migration); // Safe to run again.
    const consentMigration = readFileSync(new URL("../migrations/0002_contact_submissions.sql", import.meta.url), "utf8");
    sqlite.exec(consentMigration);
    sqlite.exec(consentMigration); // Safe to run again; existing protection tables remain intact.
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
    assert.equal(count("contact_submissions"), 1);
    const stored = sqlite.prepare("SELECT * FROM contact_submissions").get();
    assert.equal(stored.email, null);
    assert.equal(stored.marketing_consent, 0);
    assert.equal(stored.consent_at, null);
    assert.equal(stored.form_source, "/");
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

    const failure = mockContext(contactRequest({ "Project Details": "A different project", Email: "customer@example.com", "Marketing Consent": "yes", "Form Source": "/contact" }), new Response("error", { status: 500 }), db);
    assert.equal((await onRequestPost(failure.context)).status, 502);
    const optedIn = sqlite.prepare("SELECT * FROM contact_submissions WHERE marketing_consent = 1").get();
    assert.equal(optedIn.email, "customer@example.com");
    assert.equal(optedIn.consent_at, optedIn.submitted_at);
    assert.equal(optedIn.form_source, "/contact");
    assert.equal(count("contact_submissions"), 2); // Valid consent survives provider failure.
    assert.throws(() => sqlite.exec("UPDATE contact_submissions SET marketing_consent = 1, consent_at = NULL"), /CHECK constraint/);
    assert.throws(() => sqlite.exec("UPDATE contact_submissions SET marketing_consent = 0, consent_at = 123"), /CHECK constraint/);
    assert.throws(() => sqlite.exec("UPDATE contact_submissions SET marketing_consent = 2"), /CHECK constraint/);
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
