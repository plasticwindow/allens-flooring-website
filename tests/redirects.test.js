import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { onRequest } from "../functions/_middleware.js";

const CANONICAL_HOMEPAGE = "https://allenscarpetinc.com/";
const homepageHtml = await readFile(
  new URL("../index.html", import.meta.url),
  "utf8",
);

async function request(url) {
  let continued = false;
  const response = await onRequest({
    request: new Request(url),
    next() {
      continued = true;
      return new Response("homepage", { status: 200 });
    },
  });

  return { continued, response };
}

for (const url of [
  "https://allenscarpetinc.com/allens-flooring",
  "https://allenscarpetinc.com/allens-flooring/",
  "https://allenscarpetinc.com/home",
  "https://allenscarpetinc.com/home/",
  "https://allenscarpetinc.com/?publisher=localcom_rbl&placement=octane360",
]) {
  test(`${url} permanently redirects to the canonical homepage`, async () => {
    const { continued, response } = await request(url);

    assert.equal(response.status, 301);
    assert.equal(response.headers.get("location"), CANONICAL_HOMEPAGE);
    assert.equal(continued, false);
  });
}

test("HTTP permanently redirects to the equivalent HTTPS URL", async () => {
  const { continued, response } = await request(
    "http://allenscarpetinc.com/assets/favicon.png?size=32",
  );

  assert.equal(response.status, 301);
  assert.equal(
    response.headers.get("location"),
    "https://allenscarpetinc.com/assets/favicon.png?size=32",
  );
  assert.equal(continued, false);
});

test("an HTTP legacy URL redirects directly to the canonical homepage", async () => {
  const { continued, response } = await request(
    "http://allenscarpetinc.com/home?publisher=localcom_rbl&placement=octane360",
  );

  assert.equal(response.status, 301);
  assert.equal(response.headers.get("location"), CANONICAL_HOMEPAGE);
  assert.equal(continued, false);
});

test("the clean HTTPS homepage continues to the static asset", async () => {
  const { continued, response } = await request(CANONICAL_HOMEPAGE);

  assert.equal(response.status, 200);
  assert.equal(continued, true);
});

test("the homepage canonical is exactly the canonical homepage URL", () => {
  const canonicalLinks = [
    ...homepageHtml.matchAll(
      /<link\b(?=[^>]*\brel=["']canonical["'])[^>]*\bhref=["']([^"']+)["'][^>]*>/gi,
    ),
  ];

  assert.equal(canonicalLinks.length, 1);
  assert.equal(canonicalLinks[0][1], CANONICAL_HOMEPAGE);
});

test("no internal links point to a legacy path", () => {
  const legacyInternalLinks = [
    ...homepageHtml.matchAll(/\b(?:href|action)=["']([^"']+)["']/gi),
  ]
    .map((match) => new URL(match[1], CANONICAL_HOMEPAGE))
    .filter(
      (url) =>
        url.hostname === "allenscarpetinc.com" &&
        LEGACY_PATHS_FOR_AUDIT.has(normalizedPathForAudit(url.pathname)),
    );

  assert.deepEqual(legacyInternalLinks, []);
});

test("the homepage has no client-side redirect", () => {
  assert.doesNotMatch(homepageHtml, /http-equiv=["']refresh["']/i);
  assert.doesNotMatch(homepageHtml, /location\.(?:href|replace)\s*[=(]/i);
});

const LEGACY_PATHS_FOR_AUDIT = new Set(["/allens-flooring", "/home"]);

function normalizedPathForAudit(pathname) {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}
