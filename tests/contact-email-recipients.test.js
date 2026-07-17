import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const PRIMARY_RECIPIENT = "allenscarpet@hotmail.com";
const CC_RECIPIENT = "allensfloorinc@gmail.com";

for (const page of ["index.html", "contact.html"]) {
  test(`${page} sends one notification to the primary recipient with one CC`, async () => {
    const html = await readFile(new URL(`../${page}`, import.meta.url), "utf8");
    const formActions = [
      ...html.matchAll(/<form\b[^>]*\baction=["']([^"']+)["'][^>]*>/gi),
    ].map((match) => match[1]);

    assert.equal(formActions.length, 1);

    const action = new URL(formActions[0]);
    const recipients = [action.pathname, ...action.searchParams.getAll("cc")];

    assert.equal(action.protocol, "mailto:");
    assert.deepEqual(recipients, [PRIMARY_RECIPIENT, CC_RECIPIENT]);
    assert.equal(new Set(recipients).size, recipients.length);
    assert.doesNotMatch(
      html,
      /\bname=["'](?:to|cc|bcc|recipient)["']/i,
      "Visitors must not be able to control email recipients through form fields",
    );
  });
}
