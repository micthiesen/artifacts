// Comment drawer: lists the artifact's threads in page order, starts new ones
// from a selection in the frame, and handles replies, resolve and delete. The
// frame only reports anchors and clicks; everything here runs in the trusted
// shell, so artifact code can't read or forge comments.
import type { Anchor, AnchorStatus, Person, SyncClientMessage, Thread } from "../shared/protocol.ts";

export type DrawerOptions = {
  me: string | null;
  canComment: boolean;
  /** Editors and owners may resolve anyone's thread; viewers only their own. */
  canResolveAny: boolean;
  isOwner: boolean;
  readSeq: number;
  send: (msg: SyncClientMessage) => void;
  /** Ask the frame to scroll to and flash a thread's anchor. */
  focus: (threadId: string) => void;
  /** Threads changed: the frame redraws highlights. */
  onThreads: (threads: Thread[]) => void;
  onRead: (seq: number) => void;
};

type Filter = "open" | "resolved";

export function createDrawer(panel: HTMLElement, toggle: HTMLButtonElement, opts: DrawerOptions) {
  let threads = new Map<string, Thread>();
  let people: Person[] = [];
  let order: { id: string; status: AnchorStatus }[] = [];
  let filter: Filter = "open";
  let draft: { anchor: Anchor | null; text?: string } | null = null;
  let readSeq = opts.readSeq;
  let activeId: string | null = null;
  const replyDrafts = new Map<string, string>();
  let pendingFocus: string | null = null;

  const nameOf = (email: string) => {
    if (email === "agent") return "Agent";
    if (email === opts.me) return "You";
    return people.find((p) => p.email === email)?.name ?? email.split("@")[0];
  };

  function isOpen() {
    return !panel.hidden;
  }

  function setOpen(open: boolean) {
    panel.hidden = !open;
    document.body.classList.toggle("threads-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    if (open) {
      render();
      markRead();
    } else {
      draft = null;
      activeId = null;
      opts.onThreads(visibleThreads());
    }
  }

  toggle.addEventListener("click", () => setOpen(!isOpen()));

  function visibleThreads(): Thread[] {
    return [...threads.values()].filter((t) => !t.resolved && t.comments.length);
  }

  function statusOf(id: string): AnchorStatus | undefined {
    return order.find((o) => o.id === id)?.status;
  }

  function sorted(list: Thread[]): Thread[] {
    const pos = new Map(order.map((o, i) => [o.id, i]));
    return [...list].sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9) || a.at.localeCompare(b.at));
  }

  function unreadCount(): number {
    let n = 0;
    for (const t of threads.values()) for (const c of t.comments) if (c.seq > readSeq && c.by !== opts.me) n++;
    return n;
  }

  function markRead() {
    let max = readSeq;
    for (const t of threads.values()) for (const c of t.comments) max = Math.max(max, c.seq);
    if (max > readSeq) {
      // Keep "new" markers on screen until the drawer re-renders on its own.
      readSeq = max;
      opts.onRead(max);
    }
    updateToggle();
  }

  function updateToggle() {
    const open = visibleThreads().length;
    const unread = unreadCount();
    toggle.querySelector(".count")!.textContent = open ? String(open) : "";
    toggle.classList.toggle("has-unread", unread > 0);
    toggle.title = unread ? `${unread} new ${unread === 1 ? "comment" : "comments"}` : "Comments";
  }

  // ---- rendering ---------------------------------------------------------------

  function render() {
    updateToggle();
    if (!isOpen()) return;
    const focusKey = (document.activeElement as HTMLElement | null)?.dataset?.key;
    const all = [...threads.values()].filter((t) => t.comments.length);
    const open = all.filter((t) => !t.resolved);
    const resolved = all.filter((t) => t.resolved);
    const list = filter === "open" ? open : resolved;

    const head = el("div", "threads-head");
    const tabs = el("div", "threads-tabs");
    for (const f of ["open", "resolved"] as const) {
      const b = button(`${f === "open" ? "Open" : "Resolved"} ${f === "open" ? open.length : resolved.length}`, "tab", () => {
        filter = f;
        render();
      });
      b.setAttribute("aria-pressed", String(filter === f));
      tabs.append(b);
    }
    const close = button("✕", "icon", () => setOpen(false));
    close.setAttribute("aria-label", "Close comments");
    head.append(tabs, close);

    const body = el("div", "threads-body");
    if (draft) body.append(composer(draft.anchor));
    if (opts.canComment && !draft && filter === "open") {
      const add = button("Comment on the whole page", "ghost add-page", () => {
        draft = { anchor: null };
        render();
      });
      body.append(add);
      const hint = el("p", "threads-hint");
      hint.textContent = "Or select text on the page, or hover a block and press +.";
      body.append(hint);
    }
    if (!opts.canComment && opts.me === null) {
      const hint = el("p", "threads-hint");
      hint.textContent = "Sign in to comment.";
      body.append(hint);
    }
    const placed = sorted(list);
    const groups: [string, Thread[]][] =
      filter === "open"
        ? [
            ["", placed.filter((t) => !t.anchor || statusOf(t.id) !== "orphaned")],
            ["No longer on the page", placed.filter((t) => t.anchor && statusOf(t.id) === "orphaned")],
          ]
        : [["", placed]];
    for (const [title, items] of groups) {
      if (!items.length) continue;
      if (title) {
        const h = el("h3", "threads-group");
        h.textContent = title;
        body.append(h);
      }
      for (const t of items) body.append(card(t));
    }
    if (!list.length && !draft) {
      const empty = el("p", "threads-empty");
      empty.textContent = filter === "open" ? "No open comments." : "Nothing resolved yet.";
      body.append(empty);
    }
    panel.replaceChildren(head, body);
    if (focusKey) panel.querySelector<HTMLElement>(`[data-key="${focusKey}"]`)?.focus();
    if (pendingFocus) {
      const target = panel.querySelector(`[data-thread="${CSS.escape(pendingFocus)}"]`);
      target?.scrollIntoView({ block: "nearest" });
      pendingFocus = null;
    }
  }

  function anchorView(anchor: Anchor | null, status: AnchorStatus | undefined, onClick?: () => void): HTMLElement | null {
    if (!anchor) return null;
    const q = el(onClick ? "button" : "div", `thread-anchor${status === "outdated" || status === "orphaned" ? " is-stale" : ""}`);
    if (onClick) {
      (q as HTMLButtonElement).type = "button";
      q.addEventListener("click", onClick);
    }
    const text = anchor.quote?.exact ?? anchor.label ?? (anchor.row ? `Row ${anchor.row}` : "This block");
    q.textContent = text.length > 160 ? `${text.slice(0, 159)}…` : text;
    return q;
  }

  function card(t: Thread): HTMLElement {
    const status = statusOf(t.id);
    const c = el("article", `thread${t.id === activeId ? " is-active" : ""}`);
    c.dataset.thread = t.id;
    const chips = el("div", "thread-chips");
    if (t.addressedIn) chips.append(chip(`Addressed in v${t.addressedIn}`, "positive"));
    else if (t.resolved) chips.append(chip(`Resolved by ${nameOf(t.resolved.by)}`, "muted"));
    if (!t.resolved && status === "outdated") chips.append(chip(`Text changed since v${t.version}`, "caution"));
    if (chips.childElementCount) c.append(chips);
    const anchor = anchorView(t.anchor, status, status === "orphaned" ? undefined : () => select(t.id));
    if (anchor) c.append(anchor);
    for (const cm of t.comments) {
      const row = el("div", `comment${cm.seq > readSeq && cm.by !== opts.me ? " is-new" : ""}`);
      const meta = el("div", "comment-meta");
      const av = el("span", `avatar small${cm.by === "agent" ? " agent" : ""}`);
      av.textContent = cm.by === "agent" ? "✦" : cm.by.slice(0, 1).toUpperCase();
      const who = el("span", "comment-who");
      who.textContent = nameOf(cm.by);
      // Display names are self-chosen; the address is always one hover away.
      if (cm.by.includes("@")) who.title = cm.by;
      if (cm.by === "agent") who.append(chip("agent", "muted"));
      const when = el("time", "comment-when");
      when.dateTime = cm.at;
      when.title = new Date(cm.at).toLocaleString();
      when.textContent = relative(cm.at);
      meta.append(av, who, when);
      if (opts.me && (cm.by === opts.me || opts.isOwner)) {
        const del = button("Delete", "link danger", () => {
          if (confirm("Delete this comment?")) opts.send({ t: "comment:delete", cid: cid(), comment: cm.id });
        });
        meta.append(del);
      }
      const text = el("p", "comment-text");
      renderText(text, cm.text);
      row.append(meta, text);
      c.append(row);
    }
    const actions = el("div", "thread-actions");
    if (opts.canComment) {
      const reply = textarea(`Reply…`, replyDrafts.get(t.id) ?? "", `reply-${t.id}`);
      reply.addEventListener("input", () => replyDrafts.set(t.id, reply.value));
      const send = () => {
        const text = reply.value.trim();
        if (!text) return;
        opts.send({ t: "comment", cid: cid(), thread: t.id, text });
        replyDrafts.delete(t.id);
        reply.value = "";
      };
      reply.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          send();
        }
      });
      attachMentions(reply);
      c.append(reply);
      actions.append(button("Reply", "primary small", send));
    }
    const mayResolve = opts.me && (opts.canResolveAny || t.by === opts.me);
    if (mayResolve) {
      actions.append(
        button(t.resolved ? "Reopen" : "Resolve", "ghost small", () =>
          opts.send({ t: "resolve", cid: cid(), thread: t.id, resolved: !t.resolved }),
        ),
      );
    }
    if (actions.childElementCount) c.append(actions);
    c.addEventListener("click", (e) => {
      if ((e.target as Element).closest("button, textarea, a")) return;
      select(t.id);
    });
    return c;
  }

  function composer(anchor: Anchor | null): HTMLElement {
    const c = el("article", "thread is-draft");
    const a = anchorView(anchor, undefined);
    if (a) c.append(a);
    const input = textarea(anchor ? "Comment on this…" : "Comment on the page…", draft?.text ?? "", "draft");
    input.addEventListener("input", () => {
      if (draft) draft.text = input.value;
    });
    const submit = () => {
      const text = input.value.trim();
      if (!text) return;
      opts.send({ t: "comment", cid: cid(), anchor, text });
      draft = null;
      render();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submit();
      }
      if (e.key === "Escape") {
        draft = null;
        render();
      }
    });
    attachMentions(input);
    const actions = el("div", "thread-actions");
    actions.append(
      button("Cancel", "ghost small", () => {
        draft = null;
        render();
      }),
      button("Comment", "primary small", submit),
    );
    const hint = el("span", "threads-hint inline");
    hint.textContent = "⌘/Ctrl + Enter";
    actions.prepend(hint);
    c.append(input, actions);
    queueMicrotask(() => input.focus());
    return c;
  }

  function select(id: string) {
    activeId = id;
    opts.focus(id);
    render();
  }

  // ---- mentions --------------------------------------------------------------------

  function attachMentions(input: HTMLTextAreaElement) {
    let list: HTMLElement | null = null;
    let matches: Person[] = [];
    let index = 0;
    const close = () => {
      list?.remove();
      list = null;
    };
    const query = () => {
      const upto = input.value.slice(0, input.selectionStart ?? input.value.length);
      return /(?:^|\s)@([^\s@]*)$/.exec(upto)?.[1] ?? null;
    };
    const pick = (p: Person) => {
      const pos = input.selectionStart ?? input.value.length;
      const before = input.value.slice(0, pos).replace(/@([^\s@]*)$/, `@${p.email} `);
      input.value = before + input.value.slice(pos);
      input.setSelectionRange(before.length, before.length);
      input.dispatchEvent(new Event("input"));
      close();
      input.focus();
    };
    input.addEventListener("input", () => {
      const q = query();
      if (q === null) return close();
      matches = people
        .filter((p) => p.email !== opts.me && `${p.name ?? ""} ${p.email}`.toLowerCase().includes(q.toLowerCase()))
        .slice(0, 6);
      if (!matches.length) return close();
      index = 0;
      list ??= el("div", "mentions");
      list.setAttribute("role", "listbox");
      list.replaceChildren(
        ...matches.map((p, i) => {
          const b = button(`${p.name ? `${p.name} · ` : ""}${p.email}`, `mention${i === index ? " is-active" : ""}`, () => pick(p));
          b.setAttribute("role", "option");
          b.addEventListener("pointerdown", (e) => e.preventDefault());
          return b;
        }),
      );
      input.after(list);
    });
    input.addEventListener("keydown", (e) => {
      if (!list) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        index = (index + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length;
        list.querySelectorAll(".mention").forEach((b, i) => b.classList.toggle("is-active", i === index));
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        e.stopImmediatePropagation();
        pick(matches[index]);
      } else if (e.key === "Escape") {
        e.stopImmediatePropagation();
        close();
      }
    });
    input.addEventListener("blur", () => setTimeout(close, 150));
  }

  function renderText(target: HTMLElement, text: string) {
    const parts = text.split(/(@[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/gi);
    for (const part of parts) {
      if (/^@.+@/.test(part)) {
        const m = el("span", "mention-text");
        m.textContent = `@${nameOf(part.slice(1).toLowerCase())}`;
        m.title = part.slice(1);
        target.append(m);
      } else target.append(document.createTextNode(part));
    }
  }

  // ---- public API ---------------------------------------------------------------------

  return {
    setAll(list: Thread[], ppl: Person[]) {
      threads = new Map(list.map((t) => [t.id, t]));
      people = ppl;
      opts.onThreads(visibleThreads());
      render();
      if (isOpen()) markRead();
    },
    upsert(t: Thread) {
      if (!t.comments.length) threads.delete(t.id);
      else threads.set(t.id, t);
      for (const c of t.comments) {
        if (c.by.includes("@") && !people.some((p) => p.email === c.by)) people = [...people, { email: c.by, name: null }];
      }
      opts.onThreads(visibleThreads());
      render();
      if (isOpen()) markRead();
    },
    setPlacement(placed: { id: string; status: AnchorStatus }[]) {
      order = placed;
      render();
    },
    compose(anchor: Anchor) {
      if (!opts.canComment) return;
      draft = { anchor };
      filter = "open";
      setOpen(true);
    },
    open(threadId: string) {
      const t = threads.get(threadId);
      if (!t) {
        setOpen(true);
        return;
      }
      filter = t.resolved ? "resolved" : "open";
      activeId = threadId;
      pendingFocus = threadId;
      setOpen(true);
      if (!t.resolved) opts.focus(threadId);
    },
    show() {
      setOpen(true);
    },
    unread: unreadCount,
  };
}

// ---- small DOM helpers ------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

function button(label: string, variant: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", `tbtn ${variant}`);
  b.type = "button";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function chip(text: string, tone: string): HTMLElement {
  const c = el("span", `chip ${tone}`);
  c.textContent = text;
  return c;
}

function textarea(placeholder: string, value: string, key: string): HTMLTextAreaElement {
  const t = el("textarea", "thread-input");
  t.placeholder = placeholder;
  t.value = value;
  t.rows = 2;
  t.dataset.key = key;
  return t;
}

function cid() {
  return crypto.randomUUID();
}

export function relative(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
