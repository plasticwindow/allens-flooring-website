const RESEND_ENDPOINT = "https://api.resend.com/emails";
const PRIMARY_RECIPIENT = "allenscarpet@hotmail.com";
const CC_RECIPIENT = "allensfloorinc@gmail.com";
const EMAIL_SUBJECT = "New flooring estimate request";
const TURNSTILE_ENDPOINT = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const RATE_WINDOW_SECONDS = 600;
const MAX_REQUESTS_PER_WINDOW = 8;
const DUPLICATE_WINDOW_SECONDS = 86400;
const MAX_BODY_BYTES = 16384;
const FLOORING_TYPES = new Set(["Carpet", "Luxury Vinyl Plank", "Hardwood", "Laminate", "Not sure yet"]);
const URL_PATTERN = /(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|net|org|io|co|biz|info|xyz)\b/gi;
const SOLICITATION_PATTERN = /\b(?:crypto(?:currency)?|bitcoin|blockchain|forex|nfts?|seo|search engine optimization|web(?:site)?[\s-]*design|web(?:site)?[\s-]*development|lead[\s-]*generation|digital[\s-]*marketing|social[\s-]*media[\s-]*marketing|marketing[\s-]*services|marketing[\s-]*agency)\b/i;
const MARKETING_PITCH_PATTERN = /\b(?:offer|provide|sell|boost|increase|promote|help your business)\b.{0,80}\b(?:marketing|advertising|promotion)\b/i;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=UTF-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function cleanText(value, maximumLength) {
  if (typeof value !== "string") return "";

  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, maximumLength);
}

function cleanSingleLine(value, maximumLength) {
  return cleanText(value, maximumLength).replace(/[\r\n]+/g, " ");
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isValidPhone(value) {
  const digits = value.replace(/\D/g, "");
  return /^[0-9+().\-\s]{7,30}$/.test(value) && digits.length >= 7 && digits.length <= 15;
}

function createMessage(formData) {
  for (const [field, maximumLength] of [
    ["Name", 100], ["Phone", 30], ["Flooring Type", 80],
    ["Project Details", 3000], ["Email", 254],
  ]) {
    const value = formData.get(field);
    if (field === "Email" && value === null) continue;
    if (typeof value !== "string" || value.length > maximumLength) {
      return { error: "Please check the form fields and try again." };
    }
  }

  const name = cleanSingleLine(formData.get("Name"), 100);
  const phone = cleanSingleLine(formData.get("Phone"), 30);
  const flooringType = cleanSingleLine(formData.get("Flooring Type"), 80);
  const projectDetails = cleanText(formData.get("Project Details"), 3000);
  const email = cleanSingleLine(formData.get("Email"), 254).toLowerCase();

  if (!name || !isValidPhone(phone) || !FLOORING_TYPES.has(flooringType)) {
    return { error: "Please complete all required fields with valid information." };
  }

  if (email && !isValidEmail(email)) {
    return { error: "Please enter a valid email address." };
  }

  if ([...name.matchAll(URL_PATTERN)].length > 0) {
    return { error: "Please enter your name without a link." };
  }

  if ([...projectDetails.matchAll(URL_PATTERN)].length > 1 ||
      SOLICITATION_PATTERN.test(`${name}\n${projectDetails}`) ||
      MARKETING_PITCH_PATTERN.test(projectDetails)) {
    return { error: "Please send only flooring project inquiries through this form." };
  }

  const lines = [
    `Name: ${name}`,
    `Phone: ${phone}`,
    email ? `Email: ${email}` : null,
    `Flooring type: ${flooringType}`,
    "",
    "Project details:",
    projectDetails || "Not provided",
  ].filter((line) => line !== null);

  return {
    email,
    phone,
    text: lines.join("\n"),
  };
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function verifyTurnstile(context, token, hostname, remoteIp) {
  const expectedAction = "flooring_estimate";
  let result = null;
  const verifyFetch = context.data?.turnstileFetch || fetch;
  const body = new URLSearchParams({
    secret: context.env.TURNSTILE_SECRET_KEY,
    response: token,
  });
  if (remoteIp) body.set("remoteip", remoteIp);

  try {
    const response = await verifyFetch(TURNSTILE_ENDPOINT, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(10000),
    });
    result = await response.json();
    return response.ok && result?.success === true &&
      result.hostname === hostname &&
      result.action === expectedAction;
  } catch {
    return false;
  } finally {
    // Temporary diagnostics: never log requests, credentials, tokens, or raw responses.
    console.info("Turnstile Siteverify diagnostic", {
      success: typeof result?.success === "boolean" ? result.success : null,
      "error-codes": Array.isArray(result?.["error-codes"])
        ? result["error-codes"].filter(code => typeof code === "string") : [],
      hostname: typeof result?.hostname === "string" ? result.hostname : null,
      action: typeof result?.action === "string" ? result.action : null,
      expectedHostname: hostname,
      expectedAction,
    });
  }
}

async function checkRateLimit(db, key, now) {
  const windowStart = Math.floor(now / RATE_WINDOW_SECONDS) * RATE_WINDOW_SECONDS;
  const result = await db.prepare(`
    INSERT INTO contact_rate_limits (key, expires_at, attempts)
    VALUES (?, ?, 1)
    ON CONFLICT(key) DO UPDATE SET attempts = attempts + 1
    RETURNING attempts
  `).bind(`${key}:${windowStart}`, windowStart + RATE_WINDOW_SECONDS).first();

  return result.attempts <= MAX_REQUESTS_PER_WINDOW;
}

async function reserveSubmission(db, fingerprint, now) {
  const result = await db.prepare(`
    INSERT INTO contact_submission_fingerprints (fingerprint, expires_at)
    VALUES (?, ?)
    ON CONFLICT(fingerprint) DO UPDATE SET expires_at = excluded.expires_at
    WHERE contact_submission_fingerprints.expires_at <= ?
    RETURNING fingerprint
  `).bind(fingerprint, now + DUPLICATE_WINDOW_SECONDS, now).first();

  return result !== null;
}

async function releaseSubmission(db, fingerprint) {
  await db.prepare("DELETE FROM contact_submission_fingerprints WHERE fingerprint = ?")
    .bind(fingerprint).run();
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const requestUrl = new URL(request.url);
  const origin = request.headers.get("Origin");

  if (origin && origin !== requestUrl.origin) {
    return jsonResponse({ ok: false, error: "Invalid submission origin." }, 403);
  }

  const contentType = request.headers.get("Content-Type") || "";
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > MAX_BODY_BYTES) {
    return jsonResponse({ ok: false, error: "The request is too large." }, 413);
  }
  if (
    !contentType.startsWith("multipart/form-data") &&
    !contentType.startsWith("application/x-www-form-urlencoded")
  ) {
    return jsonResponse({ ok: false, error: "Unsupported form submission." }, 415);
  }

  let formData;
  try {
    // Enforce the limit even when Content-Length is absent or inaccurate.
    const reader = request.body?.getReader();
    const chunks = [];
    let size = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) {
          await reader.cancel();
          return jsonResponse({ ok: false, error: "The request is too large." }, 413);
        }
        chunks.push(value);
      }
    }
    formData = await new Response(new Blob(chunks), { headers: { "Content-Type": contentType } }).formData();
  } catch {
    return jsonResponse({ ok: false, error: "The form submission could not be read." }, 400);
  }

  const allowedFields = new Set(["Name", "Phone", "Flooring Type", "Project Details", "Email", "Website", "cf-turnstile-response"]);
  for (const [field, value] of formData) {
    if (!allowedFields.has(field) || typeof value !== "string" || formData.getAll(field).length !== 1) {
      return jsonResponse({ ok: false, error: "Invalid form fields." }, 400);
    }
  }

  // A filled hidden website field identifies an automated submission.
  if (cleanText(formData.get("Website"), 200)) {
    return jsonResponse({ ok: true });
  }

  const message = createMessage(formData);
  if (message.error) {
    return jsonResponse({ ok: false, error: message.error }, 400);
  }

  if (!env?.RESEND_API_KEY || !env?.CONTACT_FROM_EMAIL ||
      !env?.TURNSTILE_SECRET_KEY || !env?.CONTACT_DB) {
    console.error("Contact form service is not configured.");
    return jsonResponse(
      { ok: false, error: "The form is temporarily unavailable. Please call the showroom." },
      503,
    );
  }

  const token = cleanSingleLine(formData.get("cf-turnstile-response"), 2049);
  if (!token || token.length > 2048) {
    return jsonResponse({ ok: false, error: "Please complete the verification." }, 400);
  }

  const remoteIp = request.headers.get("CF-Connecting-IP") || "";
  const rateKey = await sha256(`${env.TURNSTILE_SECRET_KEY}:${remoteIp || message.phone}`);
  const now = Math.floor(Date.now() / 1000);
  try {
    const withinLimit = await checkRateLimit(env.CONTACT_DB, rateKey, now);
    if (context.waitUntil && Math.random() < 0.02) {
      context.waitUntil(Promise.all([
        env.CONTACT_DB.prepare("DELETE FROM contact_rate_limits WHERE expires_at < ?").bind(now).run(),
        env.CONTACT_DB.prepare("DELETE FROM contact_submission_fingerprints WHERE expires_at < ?").bind(now).run(),
      ]).catch(() => console.error("Contact protection cleanup failed.")));
    }
    if (!withinLimit) {
      return jsonResponse({ ok: false, error: "Too many requests. Please try again later or call the showroom." }, 429);
    }
  } catch (error) {
    console.error("Contact rate limit check failed.");
    return jsonResponse({ ok: false, error: "The form is temporarily unavailable. Please call the showroom." }, 503);
  }

  if (!await verifyTurnstile(context, token, requestUrl.hostname, remoteIp)) {
    return jsonResponse({ ok: false, error: "Verification failed. Please try again." }, 403);
  }

  const fingerprint = await sha256(message.text.toLowerCase().replace(/\s+/g, " ").trim());
  try {
    if (!await reserveSubmission(env.CONTACT_DB, fingerprint, now)) {
      return jsonResponse({ ok: false, error: "This request was already sent. Please call the showroom if you need to add information." }, 409);
    }
  } catch (error) {
    console.error("Contact duplicate check failed.");
    return jsonResponse({ ok: false, error: "The form is temporarily unavailable. Please call the showroom." }, 503);
  }

  const emailPayload = {
    from: env.CONTACT_FROM_EMAIL,
    to: [PRIMARY_RECIPIENT],
    cc: [CC_RECIPIENT],
    subject: EMAIL_SUBJECT,
    text: message.text,
  };

  if (message.email) {
    emailPayload.reply_to = message.email;
  }

  const emailFetch = context.data?.emailFetch || fetch;
  let emailResponse;

  try {
    emailResponse = await emailFetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `contact-form/${fingerprint}`,
      },
      body: JSON.stringify(emailPayload),
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    try {
      await releaseSubmission(env.CONTACT_DB, fingerprint);
    } catch (releaseError) {
      console.error("Could not release failed contact submission.");
    }
    console.error("Contact email request failed.");
    return jsonResponse(
      { ok: false, error: "Your request could not be sent. Please try again or call the showroom." },
      502,
    );
  }

  if (!emailResponse.ok) {
    try {
      await releaseSubmission(env.CONTACT_DB, fingerprint);
    } catch (error) {
      console.error("Could not release failed contact submission.");
    }
    console.error(`Contact email provider returned ${emailResponse.status}.`);
    return jsonResponse(
      { ok: false, error: "Your request could not be sent. Please try again or call the showroom." },
      502,
    );
  }

  return jsonResponse({ ok: true });
}
