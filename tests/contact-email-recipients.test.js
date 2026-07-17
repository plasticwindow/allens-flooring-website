import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pages = ["index.html", "contact.html"];
const [clientScript, ...pageHtml] = await Promise.all([
  readFile(new URL("../assets/contact-form.js", import.meta.url), "utf8"),
  ...pages.map((page) => readFile(new URL(`../${page}`, import.meta.url), "utf8")),
]);

for (const [index, page] of pages.entries()) {
  test(`${page} posts its contact form to the secure same-origin endpoint`, () => {
    const html = pageHtml[index];
    const forms = [
      ...html.matchAll(/<form\b([^>]*)\baction=["']([^"']+)["']([^>]*)>/gi),
    ];

    assert.equal(forms.length, 1);
    assert.equal(forms[0][2], "/api/contact");
    assert.match(`${forms[0][1]} ${forms[0][3]}`, /\bmethod=["']post["']/i);
    assert.match(`${forms[0][1]} ${forms[0][3]}`, /\bdata-contact-form\b/i);
    assert.doesNotMatch(html, /mailto:|allenscarpet@hotmail\.com|allensfloorinc@gmail\.com/i);
    assert.doesNotMatch(
      html,
      /\bname=["'](?:to|cc|bcc|from|recipient)["']/i,
      "Visitors must not be able to control email headers through form fields",
    );
    assert.match(html, /<script\b[^>]*\bsrc=["']assets\/contact-form\.js["']/i);
  });
}

test("the contact form client submits only to each form's configured same-origin action", () => {
  assert.match(clientScript, /fetch\(form\.action,/);
  assert.doesNotMatch(clientScript, /https?:\/\//i);
  assert.doesNotMatch(clientScript, /allenscarpet@hotmail\.com|allensfloorinc@gmail\.com/i);
});
