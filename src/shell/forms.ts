// Server-rendered POST forms (sign-in, create workspace, help, report, inbox) submit once: a second click while
// the next page loads would send the request again (a second workspace create, another sign-in code). The
// pressed button is marked aria-busy, not disabled: a disabled submitter drops out of the form data, and
// Safari can cancel the navigation.
document.addEventListener("submit", (e) => {
  const form = e.target;
  if (!(form instanceof HTMLFormElement) || e.defaultPrevented || form.method !== "post") return;
  if (form.target && form.target !== "_self") return;
  if (form.dataset.busy) {
    e.preventDefault();
    return;
  }
  form.dataset.busy = "1";
  const button = (e as SubmitEvent).submitter ?? form.querySelector("button:not([type=button]), input[type=submit]");
  button?.setAttribute("aria-busy", "true");
  // A submit that never leaves the page (Stop pressed, the network failed) mustn't leave the form dead.
  setTimeout(() => release(form), 10_000);
});

function release(form: HTMLFormElement) {
  delete form.dataset.busy;
  for (const b of form.querySelectorAll("[aria-busy]")) b.removeAttribute("aria-busy");
}

// Back/forward cache restores the page as it was left, mid-submit: let it submit again.
addEventListener("pageshow", (e) => {
  if (e.persisted) for (const form of document.querySelectorAll<HTMLFormElement>("form[data-busy]")) release(form);
});
