const RESEND_ENDPOINT = "https://api.resend.com/emails";
const PRIMARY_RECIPIENT = "allenscarpet@hotmail.com";
const CC_RECIPIENT = "allensfloorinc@gmail.com";
const EMAIL_SUBJECT = "New flooring estimate request";

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
  return /^[0-9+().\-\s]{7,30}$/.test(value);
}

function createMessage(formData) {
  const name = cleanSingleLine(formData.get("Name"), 100);
  const phone = cleanSingleLine(formData.get("Phone"), 30);
  const flooringType = cleanSingleLine(formData.get("Flooring Type"), 80);
  const projectDetails = cleanText(formData.get("Project Details"), 3000);
  const email = cleanSingleLine(formData.get("Email"), 254).toLowerCase();

  if (!name || !phone || !flooringType || !isValidPhone(phone)) {
    return { error: "Please complete all required fields with valid information." };
  }

  if (email && !isValidEmail(email)) {
    return { error: "Please enter a valid email address." };
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
    text: lines.join("\n"),
  };
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const requestUrl = new URL(request.url);
  const origin = request.headers.get("Origin");

  if (origin && origin !== requestUrl.origin) {
    return jsonResponse({ ok: false, error: "Invalid submission origin." }, 403);
  }

  const contentType = request.headers.get("Content-Type") || "";
  if (
    !contentType.startsWith("multipart/form-data") &&
    !contentType.startsWith("application/x-www-form-urlencoded")
  ) {
    return jsonResponse({ ok: false, error: "Unsupported form submission." }, 415);
  }

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return jsonResponse({ ok: false, error: "The form submission could not be read." }, 400);
  }

  for (const field of ["To", "CC", "BCC", "From", "Recipient"]) {
    if (formData.has(field) || formData.has(field.toLowerCase())) {
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

  if (!env?.RESEND_API_KEY || !env?.CONTACT_FROM_EMAIL) {
    console.error("Contact email service is not configured.");
    return jsonResponse(
      { ok: false, error: "Email service is temporarily unavailable. Please call the showroom." },
      503,
    );
  }

  const suppliedSubmissionId = cleanSingleLine(
    request.headers.get("X-Submission-ID"),
    128,
  ).replace(/[^A-Za-z0-9._:-]/g, "");
  const submissionId = suppliedSubmissionId || crypto.randomUUID();
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
        "Idempotency-Key": `contact-form/${submissionId}`,
      },
      body: JSON.stringify(emailPayload),
    });
  } catch (error) {
    console.error("Contact email request failed.", error);
    return jsonResponse(
      { ok: false, error: "Your request could not be sent. Please try again or call the showroom." },
      502,
    );
  }

  if (!emailResponse.ok) {
    console.error(`Contact email provider returned ${emailResponse.status}.`);
    return jsonResponse(
      { ok: false, error: "Your request could not be sent. Please try again or call the showroom." },
      502,
    );
  }

  return jsonResponse({ ok: true });
}
