// Owner sign-in: /owner#<key> posts the key (kept out of server logs by living
// in the fragment) and gets a long-lived session cookie.
const status = document.getElementById("owner-status")!;
const form = document.getElementById("owner-form") as HTMLFormElement;
const input = document.getElementById("owner-key") as HTMLInputElement;

async function signIn(key: string) {
  status.textContent = "Signing in…";
  const res = await fetch("/owner", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  });
  if (res.ok) {
    history.replaceState(null, "", "/owner");
    location.replace("/");
  } else {
    status.textContent = "That key didn't work.";
    form.hidden = false;
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  void signIn(input.value.trim());
});

const key = decodeURIComponent(location.hash.slice(1));
if (key) void signIn(key);
else {
  status.textContent = "Enter the owner key.";
  form.hidden = false;
}

export {};
