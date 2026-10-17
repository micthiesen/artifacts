// "Changed since you last looked": a quiet bar under the title when the
// artifact has new versions (or comments) since this viewer's last visit.
import type { ShellBoot } from "../shared/protocol.ts";
import { relative } from "./threads.ts";

export function showSince(
  boot: ShellBoot,
  actions: { openComments: () => void; unread: () => number; setMarks: (on: boolean) => void },
) {
  const bar = document.getElementById("since");
  const since = boot.since;
  if (!bar || !since || !since.versions.length) return;
  const count = since.versions.length;
  const marked = since.changedBlocks.length;
  let marks = true;
  let expanded = false;

  const render = () => {
    bar.replaceChildren();
    const line = document.createElement("div");
    line.className = "since-line";
    const text = document.createElement("span");
    text.className = "since-text";
    const latest = since.versions[0];
    text.innerHTML = "";
    const strong = document.createElement("strong");
    strong.textContent = count === 1 ? "Updated" : `Updated ${count} times`;
    text.append(strong, ` since you last looked ${relative(since.at)}`);
    if (count === 1 && latest.note) text.append(`: ${latest.note}`);
    line.append(text);

    if (count > 1 || since.removedHeadings.length) {
      line.append(
        action(expanded ? "Hide details" : "What changed", () => {
          expanded = !expanded;
          render();
        }),
      );
    }
    if (marked) {
      line.append(
        action(marks ? "Hide marks" : `Show ${marked} changed ${marked === 1 ? "part" : "parts"}`, () => {
          marks = !marks;
          actions.setMarks(marks);
          render();
        }),
      );
    }
    const unread = actions.unread();
    if (unread) line.append(action(`${unread} new ${unread === 1 ? "comment" : "comments"}`, actions.openComments));
    const close = action("✕", () => {
      bar.hidden = true;
      actions.setMarks(false);
    });
    close.classList.add("since-close");
    close.setAttribute("aria-label", "Dismiss");
    line.append(close);
    bar.append(line);

    if (expanded) {
      const list = document.createElement("ul");
      list.className = "since-list";
      for (const v of since.versions) {
        const li = document.createElement("li");
        const ver = document.createElement("span");
        ver.className = "since-ver";
        ver.textContent = `v${v.version}`;
        li.append(ver, ` ${v.note || "Updated"}`);
        const when = document.createElement("span");
        when.className = "since-when";
        when.textContent = relative(v.at);
        li.append(when);
        list.append(li);
      }
      for (const h of since.removedHeadings) {
        const li = document.createElement("li");
        li.className = "removed";
        li.textContent = `Removed section “${h}”`;
        list.append(li);
      }
      bar.append(list);
    }
  };
  bar.hidden = false;
  render();
  // The unread count arrives with the socket's thread list.
  setTimeout(render, 1500);
}

function action(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "since-action";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}
