// Pin an artifact to the top of your own list, from the list or the artifact's menu.

export async function setPinned(id: string, pinned: boolean): Promise<{ pinned: boolean; pinnedAt: string | null }> {
  const res = await fetch("/api/me/pin", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, pinned }),
  });
  const json = (await res.json().catch(() => ({}))) as { pinned?: boolean; pinnedAt?: string | null; error?: string };
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status}).`);
  return { pinned: Boolean(json.pinned), pinnedAt: json.pinnedAt ?? null };
}
