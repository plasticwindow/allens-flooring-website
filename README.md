# allens-flooring-website
New Allen's Flooring website redesign for Cloudflare Pages

## Contact form configuration

The homepage and contact-page forms post to the Cloudflare Pages Function at
`/api/contact`. The Function sends one email through Resend to
`allenscarpet@hotmail.com`, preserving `allensfloorinc@gmail.com` as CC, with no
BCC. Recipient addresses are not embedded in the public HTML or frontend JavaScript.

Before deploying these changes, configure the following in Cloudflare:

1. Under **Turnstile**, open the widget whose site key is
   `0x4AAAAAAFCaCnAgNHYqqrj6`. Use Managed mode and allow `allenscarpetinc.com`.
   Copy its private secret key into Cloudflare's encrypted secret field below.
   Add any separate preview
   hostname only if you plan to test a preview deployment.
2. Under **Workers & Pages → D1**, create a database named
   `allens-contact-protection`. Open its **Console** and execute the SQL in
   [`migrations/0001_contact_protection.sql`](migrations/0001_contact_protection.sql).
   Then execute [`migrations/0002_contact_submissions.sql`](migrations/0002_contact_submissions.sql)
   for optional customer email and consent records. On an existing configured
   database, run only migration 0002 before deploying the updated handler.
   Both migrations are additive, SQLite-compatible, and safe to rerun.
3. Under **Workers & Pages → the Pages project → Settings → Bindings**, add a
   **D1 database** binding named exactly `CONTACT_DB`, pointing to the database
   from step 2. Configure production and preview separately if both are used.
4. Under **Workers & Pages → the Pages project → Settings → Variables and
   Secrets**, set these values for the relevant environment:

   - `TURNSTILE_SECRET_KEY`: private secret key from step 1, as an encrypted secret.
   - `RESEND_API_KEY`: encrypted secret containing the Resend API key.
   - `CONTACT_FROM_EMAIL`: a sender on a domain verified in Resend, for example
     `Allen's Carpet & Flooring <forms@allenscarpetinc.com>`.

5. In Resend, verify the sender domain and make sure the API key can send from
   `CONTACT_FROM_EMAIL`. Deploy the Pages project after the database, binding,
   and variables are ready. Test one real form submission on both pages and
   confirm it arrives in the recipient inbox.

The supplied public Turnstile site key is in `assets/contact-form.js`; no
`TURNSTILE_SITE_KEY` environment variable is required.
The secret key, Resend key, recipient addresses, spam checks,
and email delivery stay server-side. If any required binding or credential is
missing, the form returns an error and asks the visitor to call the showroom.

## Form spam protection

- Turnstile tokens are checked with Cloudflare Siteverify for every valid
  request. The verified hostname and `flooring_estimate` action must match.
- A hidden `Website` field silently absorbs basic bot submissions.
- Required fields, phone digits, allowed flooring choices, optional email
  addresses, field lengths, and same-origin submissions are checked on the server.
  Unknown/duplicate fields and uploads are rejected. The request body is capped
  at 16 KiB even without a Content-Length header. External verification/email
  requests have timeouts; raw exceptions and provider response bodies are not logged.
- Messages with multiple links, names with links, and obvious crypto, SEO,
  web-design, lead-generation, or marketing pitches are rejected.
- D1 limits each visitor to 8 eligible submission attempts per 10-minute window and
  rejects identical normalized requests for 24 hours. Resend receives a
  matching idempotency key as an additional duplicate-send safeguard.

An eligible attempt has passed field/spam validation and supplied a nonempty
token. Honeypot, malformed, missing-token, and obvious-spam requests are rejected
before database writes. Invalid nonempty tokens increment the rate counter, but
do not create a submission fingerprint or customer/consent record. D1 stores
protection state and minimal customer/consent records, with no customer names,
phone numbers, project messages, raw IP addresses, or Turnstile tokens.
Fingerprints are reserved after verification and removed on email-provider failure.
A successful API response means Resend accepted the request, not guaranteed inbox
delivery; check Resend delivery events and the recipient inbox for that.

Cloudflare's rate and duplicate checks require the `CONTACT_DB` binding and
the SQL schema above. Cloudflare Turnstile and Resend credentials are also
required before these forms can send. No API key should be committed to this
repository or to a Wrangler `vars` block.

## Optional email and marketing consent

Both forms accept a blank email and an unchecked marketing checkbox. Email
addresses, when supplied, are trimmed, lowercased, validated server-side, stored
in D1, included in the notification, and used as Reply-To. The primary recipient
remains `allenscarpet@hotmail.com` and CC remains `allensfloorinc@gmail.com`.

The checkbox starts unchecked, is never required, and displays this exact copy:

> Yes, send me occasional flooring specials, promotions, and home-improvement updates from Allen’s Carpet & Flooring. I can unsubscribe anytime.

`contact_submissions` stores one record for each verified, rate-allowed,
non-duplicate submission attempt, before sending through Resend:

- `id`: a generated UUID.
- `email`: the normalized optional address, or NULL.
- `marketing_consent`: 1 only when `Marketing Consent=yes` is explicitly sent
  by the checkbox; otherwise 0. Supplying email alone never grants consent.
- `consent_at`: server UTC Unix seconds when consent was recorded, or NULL
  without consent. Database checks enforce that relationship.
- `submitted_at`: server UTC Unix seconds for the submission.
- `form_source`: `/` for the homepage estimate form or `/contact` for the contact
  form; older requests without this field use `unknown`. This is client-declared
  page metadata, not proof of origin. Full URLs and query strings are not stored.

Consent may be checked even without email; the estimate still submits, but there
is no email address to market to. Records capture consent at submission time;
they are not a mailing-list subscription system or proof of address ownership.
No marketing email is sent or subscription created by this change. Any future
marketing use must require both a non-NULL email and explicit consent and honor
subsequent unsubscribes; these historical records alone are not a current subscriber list.

Storage failure prevents delivery and releases the duplicate reservation for a
retry. If Resend fails after storage, the valid submission/consent record remains
and the existing retry behavior is preserved; a retry can add a second record.
These records are not a delivery log. Consent and source are excluded from the
existing duplicate fingerprint and Resend idempotency key, so changing them does
not bypass duplicate protection. Rejected duplicates do not update prior consent.
The existing protection cleanup does not delete consent records.

After applying migration 0002, inspect recent records with:

```sql
SELECT email, marketing_consent,
       datetime(consent_at, 'unixepoch') AS consent_utc,
       datetime(submitted_at, 'unixepoch') AS submitted_utc, form_source
FROM contact_submissions ORDER BY submitted_at DESC LIMIT 10;
```

## Verification after manual deployment

1. On both `/` and `/contact`, complete the verification and submit a normal,
   distinct estimate request. Confirm success and delivery in the inbox.
2. To test the server independently of the browser, send a POST to `/api/contact`
   with valid `Name`, `Phone`, `Flooring Type`, and `Project Details` fields, an
   empty `Website`, and no `cf-turnstile-response`. Expect HTTP 400 and no email.
3. Repeat with `cf-turnstile-response=invalid-token`. Expect HTTP 403 and no
   email. A 503 indicates missing configuration and does not prove token checks
   are working. An HTTP 429 means the rate limit was reached; wait 10 minutes.
4. In browser developer tools, replay a previously successful submission with
   its original token. Cloudflare should reject the used token (HTTP 403);
   tokens expire after five minutes and can be validated only once.
5. Fill the hidden `Website` field and submit. The honeypot deliberately returns
   an apparent success but sends no email. Check Resend delivery logs to verify.
6. Check the widget's Turnstile analytics for successful and failed server token
   validations. No real secret or live email credential is needed by the local
   automated tests; those use mocked services and are not a live delivery test.
7. In the D1 Console, inspect protection state before and after a valid submission:

   ```sql
   SELECT key, attempts, datetime(expires_at, 'unixepoch') AS expires_utc
   FROM contact_rate_limits ORDER BY expires_at DESC LIMIT 10;
   SELECT fingerprint, datetime(expires_at, 'unixepoch') AS expires_utc
   FROM contact_submission_fingerprints ORDER BY expires_at DESC LIMIT 10;
   ```

   The counter should increase and a new unique submission should add a fingerprint.
   With a fresh Turnstile token, submitting identical details again should return
   409 without another email. A nonempty invalid token returns 403 and increases
   the counter; the ninth eligible attempt from the same IP within the same
   fixed 10-minute window returns 429. Use invalid tokens for the rate-limit
   test to avoid sending eight test emails. Earlier requests count toward the limit.

## Local checks

With Node.js 22.13+ available, run `node --test tests/*.test.js`. Tests use fake
credentials and mocked external services; the schema integration test runs the
real migration and handler SQL against an in-memory SQLite database.
