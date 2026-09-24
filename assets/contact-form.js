const forms = [...document.querySelectorAll("[data-contact-form]")];
const TURNSTILE_SITE_KEY = "0x4AAAAAAFCaCnAgNHYqqrj6";

async function initializeTurnstile() {
  if (forms.length === 0) return;

  try {
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.onload = () => {
      try {
        for (const form of forms) {
          const widget = form.querySelector("[data-turnstile-widget]");
          form.dataset.turnstileId = window.turnstile.render(widget, {
            sitekey: TURNSTILE_SITE_KEY,
            action: "flooring_estimate",
            theme: "light",
            size: window.matchMedia("(max-width: 480px)").matches ? "compact" : "flexible",
          });
        }
      } catch {
        showVerificationError();
      }
    };
    script.onerror = () => showVerificationError();
    document.head.append(script);
  } catch {
    showVerificationError();
  }
}

function showVerificationError() {
  for (const form of forms) {
    const status = form.querySelector("[data-form-status]");
    status.hidden = false;
    status.dataset.state = "error";
    status.textContent = "Form verification is unavailable. Please call the showroom.";
  }
}

for (const form of forms) {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (form.dataset.submitting === "true") return;

    const submitButton = form.querySelector('[type="submit"]');
    const status = form.querySelector("[data-form-status]");
    const widgetId = form.dataset.turnstileId;
    if (!window.turnstile || widgetId === undefined || !window.turnstile.getResponse(widgetId)) {
      status.hidden = false;
      status.dataset.state = "error";
      status.textContent = "Please complete the verification before sending your request.";
      return;
    }

    form.dataset.submitting = "true";
    submitButton.disabled = true;
    status.hidden = false;
    status.dataset.state = "pending";
    status.textContent = "Sending your request…";

    try {
      const response = await fetch(form.action, {
        method: "POST",
        headers: {
          Accept: "application/json",
        },
        body: new FormData(form),
        credentials: "same-origin",
      });
      const result = await response.json().catch(() => ({}));

      if (!response.ok || result.ok !== true) {
        throw new Error(result.error || "Your request could not be sent.");
      }

      form.reset();
      status.dataset.state = "success";
      status.textContent = "Thank you. Your request has been sent.";
    } catch (error) {
      status.dataset.state = "error";
      status.textContent =
        error.message || "Your request could not be sent. Please try again or call the showroom.";
    } finally {
      window.turnstile.reset(widgetId);
      form.dataset.submitting = "false";
      submitButton.disabled = false;
    }
  });
}

initializeTurnstile();
