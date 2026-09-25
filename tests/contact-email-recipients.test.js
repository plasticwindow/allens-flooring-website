import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pages = ["index.html", "contact.html"];
const [clientScript, ...pageHtml] = await Promise.all([
  readFile(new URL("../assets/contact-form.js", import.meta.url), "utf8"),
  ...pages.map((page) => readFile(new URL(`../${page}`, import.meta.url), "utf8")),
]);

for (const [index, page] of pages.entries()) {
  test(`${page} collects optional email and separate unchecked optional marketing consent`, () => {
    const form = pageHtml[index].match(/<form\b[^>]*data-contact-form[^>]*>([\s\S]*?)<\/form>/i)[1];
    const emails = [...form.matchAll(/<input\b[^>]*name="Email"[^>]*>/g)];
    assert.equal(emails.length, 1);
    assert.match(emails[0][0], /type="email"/);
    assert.match(emails[0][0], /autocomplete="email"/);
    assert.match(emails[0][0], /maxlength="254"/);
    assert.doesNotMatch(emails[0][0], /\brequired\b/);
    assert.match(form, /Email \(optional\)/);
    const checkboxes = [...form.matchAll(/<input\b[^>]*name="Marketing Consent"[^>]*>/g)];
    assert.equal(checkboxes.length, 1);
    assert.match(checkboxes[0][0], /type="checkbox"/);
    assert.match(checkboxes[0][0], /value="yes"/);
    assert.doesNotMatch(checkboxes[0][0], /\b(?:checked|required)\b/);
    const label = form.match(/<label class="marketing-consent">([\s\S]*?)<\/label>/)[1];
    assert.ok(label.includes(checkboxes[0][0]));
    assert.equal(label.match(/<span>(.*?)<\/span>/)[1].replaceAll("&amp;", "&"),
      "Yes, send me occasional flooring specials, promotions, and home-improvement updates from Allen’s Carpet & Flooring. I can unsubscribe anytime.");
    assert.ok(form.indexOf('name="Project Details"') < form.indexOf('name="Marketing Consent"'));
    assert.ok(form.indexOf('name="Marketing Consent"') < form.indexOf('type="submit"'));
    const source = form.match(/<input\b[^>]*name="Form Source"[^>]*>/)[0];
    assert.match(source, /type="hidden"/);
    assert.ok(source.includes(`value="${page === "index.html" ? "/" : "/contact"}"`));
  });

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
    assert.match(html, /<div\b[^>]*\bdata-turnstile-widget\b/i);
    assert.match(html, /\bname=["']Website["']/i);
  });
}

test("the contact form client submits only to each form's configured same-origin action", () => {
  assert.match(clientScript, /fetch\(form\.action,/);
  assert.match(clientScript, /0x4AAAAAAFCaCnAgNHYqqrj6/);
  assert.doesNotMatch(clientScript, /TURNSTILE_SECRET_KEY|RESEND_API_KEY/);
  assert.match(clientScript, /turnstile\.render\(/);
  assert.match(clientScript, /turnstile\.reset\(/);
  assert.doesNotMatch(clientScript, /fetch\(["']https?:\/\//i);
  assert.doesNotMatch(clientScript, /allenscarpet@hotmail\.com|allensfloorinc@gmail\.com/i);
});
