import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const homepage = await readFile(new URL("../index.html", import.meta.url), "utf8");

test("the homepage promotes take-home flooring samples near the product gallery", () => {
  const productSection = homepage.indexOf('<section class="products"');
  const sampleSection = homepage.indexOf('<section class="sample-preview"');
  const processSection = homepage.indexOf('<section class="process"');

  assert.ok(productSection >= 0);
  assert.ok(sampleSection > productSection);
  assert.ok(processSection > sampleSection);
  assert.match(homepage, /See It in Your Home Before You Decide/);
  assert.match(homepage, /thousands of flooring samples/);
  assert.match(homepage, /Borrow your favorites and take them home/);
});

test("the showroom call to action uses the secure internal contact page", () => {
  assert.match(
    homepage,
    /<a\b[^>]*\bclass=["'][^"']*btn[^"']*["'][^>]*\bhref=["']\/contact["'][^>]*>Visit Our Showroom<\/a>/i,
  );
});
