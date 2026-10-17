// The bar under the top bar on an archived artifact. Owners can unarchive
// from it; everyone else just sees that it was archived.

const ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>';

export async function setArchived(id: string, archived: boolean): Promise<string | null> {
  const res = await fetch(`/api/a/${id}/artifact_update`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ archived }),
  });
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; text?: string; error?: string; data?: { archivedAt?: string | null } };
  if (!res.ok || json.ok === false) throw new Error(json.text ?? json.error ?? `Request failed (${res.status}).`);
  return json.data?.archivedAt ?? null;
}

export type ArchiveBar = { set(archivedAt: string | null): void };

export function mountArchiveBar(artifactId: string, archivedAt: string | null, owner: boolean, onChange?: (archivedAt: string | null) => void): ArchiveBar {
  const bar = document.createElement("div");
  bar.className = "archived-bar";
  bar.setAttribute("role", "status");
  const top = document.querySelector(".shell > .bar");
  if (top) top.after(bar);
  else document.body.prepend(bar);

  const set = (at: string | null) => {
    bar.hidden = !at;
    if (!at) return;
    const date = new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
    bar.innerHTML = `<span>${ICON}Archived ${date}. Hidden from the artifact list.</span>`;
    if (!owner) return;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Unarchive";
    button.addEventListener("click", () => {
      button.disabled = true;
      setArchived(artifactId, false).then(
        () => {
          set(null);
          onChange?.(null);
        },
        (err: Error) => {
          button.disabled = false;
          button.textContent = `Unarchive (failed: ${err.message})`;
        },
      );
    });
    bar.append(button);
  };
  set(archivedAt);
  return { set };
}
