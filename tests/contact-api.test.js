import assert from "node:assert/strict";
import test from "node:test";

import { onRequestPost } from "../functions/api/contact.js";

const ENDPOINT = "https://allenscarpetinc.com/api/contact";
const ENV = {
  RESEND_API_KEY: "test-api-key",
  CONTACT_FROM_EMAIL: "Allen's Carpet & Flooring <forms@allenscarpetinc.com>",
};

function contactRequest(overrides = {}, headers = {}) {
  const fields = {
    Name: "Test Customer",
    Phone: "573-555-0100",
    "Flooring Type": "Carpet",
    "Project Details": "Two bedrooms",
    Website: "",
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

function mockContext(request, emailResponse = new Response('{"id":"email-123"}')) {
  const calls = [];

  return {
    calls,
    context: {
      request,
      env: ENV,
      data: {
        async emailFetch(url, options) {
          calls.push({ url, options });
          return emailResponse;
        },
      },
    },
  };
}

test("one valid submission sends one email with the fixed To and CC recipients", async () => {
  const { context, calls } = mockContext(contactRequest());
  const response = await onRequestPost(context);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.resend.com/emails");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["Idempotency-Key"], "contact-form/submission-123");

  const email = JSON.parse(calls[0].options.body);
  assert.deepEqual(email.to, ["allenscarpet@hotmail.com"]);
  assert.deepEqual(email.cc, ["allensfloorinc@gmail.com"]);
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
