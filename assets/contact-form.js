function createSubmissionId() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

for (const form of document.querySelectorAll("[data-contact-form]")) {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (form.dataset.submitting === "true") return;

    const submitButton = form.querySelector('[type="submit"]');
    const status = form.querySelector("[data-form-status]");
    const submissionId = form.dataset.submissionId || createSubmissionId();

    form.dataset.submissionId = submissionId;
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
          "X-Submission-ID": submissionId,
        },
        body: new FormData(form),
        credentials: "same-origin",
      });
      const result = await response.json().catch(() => ({}));

      if (!response.ok || result.ok !== true) {
        throw new Error(result.error || "Your request could not be sent.");
      }

      form.reset();
      delete form.dataset.submissionId;
      status.dataset.state = "success";
      status.textContent = "Thank you. Your request has been sent.";
    } catch (error) {
      status.dataset.state = "error";
      status.textContent =
        error.message || "Your request could not be sent. Please try again or call the showroom.";
    } finally {
      form.dataset.submitting = "false";
      submitButton.disabled = false;
    }
  });
}
