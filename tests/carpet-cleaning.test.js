import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const [page, homepage, contact] = await Promise.all([
  readFile(new URL("../carpet-cleaning.html", import.meta.url), "utf8"),
  readFile(new URL("../index.html", import.meta.url), "utf8"),
  readFile(new URL("../contact.html", import.meta.url), "utf8"),
]);

test("carpet cleaning has a dedicated indexable page and canonical URL", () => {
  assert.match(page, /<title>[^<]*Carpet Cleaning[^<]*<\/title>/i);
  assert.match(page, /<h1>[^<]+<\/h1>/i);
  assert.match(page, /<link rel="canonical" href="https:\/\/allenscarpetinc\.com\/carpet-cleaning"/);
  assert.doesNotMatch(page, /noindex/i);
  assert.match(page, /"@type": "Service"/);
});

test("carpet cleaning page includes three accessible before-and-after comparisons", async () => {
  const imageMatches = [...page.matchAll(/<img\b[^>]*src="(assets\/carpet-cleaning-[^"]+\.jpg)"[^>]*alt="([^"]+)"[^>]*>/gi)];
  assert.equal(imageMatches.length, 3);
  for (const [, source, alt] of imageMatches) {
    assert.match(alt, /before.*after|before cleaning.*after cleaning/i);
    await access(new URL(`../${source}`, import.meta.url));
  }
  assert.equal((page.match(/>Before</g) || []).length, 3);
  assert.equal((page.match(/>After</g) || []).length, 3);
});

test("homepage and contact page expose carpet cleaning in navigation and estimate choices", () => {
  for (const html of [homepage, contact]) {
    assert.match(html, /href="\/carpet-cleaning"[^>]*>Carpet Cleaning<\/a>/i);
    assert.match(html, /<option>Carpet Cleaning<\/option>/i);
  }
  assert.match(homepage, /Explore Carpet Cleaning/);
});

test("carpet cleaning page keeps clear call and request-service actions", () => {
  assert.match(page, /href="tel:5732210107"/);
  assert.match(page, /href="\/contact#estimateForm"/);
  assert.match(page, /Results vary by carpet fiber, age, wear, stain type, and prior treatments/);
});
