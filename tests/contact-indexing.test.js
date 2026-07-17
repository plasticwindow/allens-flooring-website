import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { onRequest } from "../functions/_middleware.js";

const ORIGIN = "https://allenscarpetinc.com";
const CONTACT_URL = `${ORIGIN}/contact`;
const LEGACY_CONTACT_URL = `${ORIGIN}/Contact_Us.html`;

const [contactHtml, homepageHtml, robotsTxt, sitemapXml, headersConfig] =
  await Promise.all([
    readFile(new URL("../contact.html", import.meta.url), "utf8"),
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../robots.txt", import.meta.url), "utf8"),
    readFile(new URL("../sitemap.xml", import.meta.url), "utf8"),
    readFile(new URL("../_headers", import.meta.url), "utf8"),
  ]);

async function request(url) {
  return onRequest({
    request: new Request(url),
    next() {
      const pathname = new URL(url).pathname;

      if (pathname === "/contact") {
        return new Response(contactHtml, {
          status: 200,
          headers: { "content-type": "text/html; charset=UTF-8" },
        });
      }

      return new Response("Not Found", { status: 404 });
    },
  });
}

test("/contact returns 200 with static, indexable HTML", async () => {
  const response = await request(CONTACT_URL);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/html\b/);
  assert.equal(response.headers.get("x-robots-tag"), null);
  assert.equal(response.headers.get("www-authenticate"), null);
  assert.match(html, /<h1\b[^>]*>[^<]+<\/h1>/i);
  assert.match(html, /573-221-0107/);
  assert.match(html, /<script\b[^>]*\bsrc=["']assets\/contact-form\.js["']/i);
  assert.doesNotMatch(
    html,
    /<meta\b(?=[^>]*\bname=["']robots["'])[^>]*\bcontent=["'][^"']*noindex/i,
  );
});

test("/contact has exactly the required canonical URL", () => {
  const canonicals = [
    ...contactHtml.matchAll(
      /<link\b(?=[^>]*\brel=["']canonical["'])[^>]*\bhref=["']([^"']+)["'][^>]*>/gi,
    ),
  ];

  assert.equal(canonicals.length, 1);
  assert.equal(canonicals[0][1], CONTACT_URL);
});

test("/contact is allowed by robots and has no X-Robots-Tag block", () => {
  assert.match(robotsTxt, /^User-agent:\s*\*$/im);
  assert.match(robotsTxt, /^Allow:\s*\/$/im);
  assert.doesNotMatch(robotsTxt, /^Disallow:\s*\/contact\/?$/im);
  assert.match(headersConfig, /^\/contact\s*\n\s*! X-Robots-Tag$/m);
});

test("legacy contact URL returns a direct 301 to /contact", async () => {
  const response = await request(LEGACY_CONTACT_URL);

  assert.equal(response.status, 301);
  assert.equal(response.headers.get("location"), CONTACT_URL);
});

test("legacy contact redirect reaches a 200 page in one hop", async () => {
  const firstResponse = await request(LEGACY_CONTACT_URL);
  const destination = firstResponse.headers.get("location");
  const finalResponse = await request(destination);

  assert.equal(firstResponse.status, 301);
  assert.equal(destination, CONTACT_URL);
  assert.equal(finalResponse.status, 200);
  assert.equal(finalResponse.headers.get("location"), null);
});

test("sitemap contains /contact and excludes the obsolete URL", () => {
  const locations = [
    ...sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g),
  ].map((match) => match[1]);

  assert.ok(locations.includes(CONTACT_URL));
  assert.ok(!locations.includes(LEGACY_CONTACT_URL));
});

test("all internal links labeled Contact use /contact", () => {
  const contactLinks = [homepageHtml, contactHtml].flatMap((html) =>
    [
      ...html.matchAll(
        /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>\s*Contact\s*<\/a>/gi,
      ),
    ].map((match) => match[1]),
  );

  assert.ok(contactLinks.length > 0);
  assert.deepEqual([...new Set(contactLinks)], ["/contact"]);
});
