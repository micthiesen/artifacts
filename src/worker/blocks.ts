// Stable block ids for MDX entries. Each top-level block gets a `data-b`
// attribute so comments can anchor to it and "changed since your last visit"
// can mark it. Ids follow the outline (the heading's slug, then
// `<section>-<n>` for the blocks under it), so editing one section doesn't
// renumber the rest. Each block also gets a content hash for diffs.

export type BlockInfo = { id: string; hash: string; heading?: string };

type Node = {
  type: string;
  name?: string | null;
  value?: string;
  depth?: number;
  children?: Node[];
  attributes?: unknown[];
  data?: { hProperties?: Record<string, unknown> };
  position?: { start: { offset?: number }; end: { offset?: number } };
};

const SKIP = new Set(["mdxjsEsm", "yaml", "toml", "definition", "footnoteDefinition", "mdxFlowExpression"]);

/** remark plugin; `out` receives the block list in document order. */
export function remarkBlockIds(out: BlockInfo[]) {
  return () => (tree: Node, file: { value?: unknown }) => {
    const source = String(file.value ?? "");
    const used = new Set<string>();
    let section = "top";
    let n = 0;
    const unique = (base: string) => {
      let id = base || "section";
      for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
      used.add(id);
      return id;
    };
    const children = tree.children ?? [];
    for (let i = 0; i < children.length; i++) {
      const node = children[i];
      if (SKIP.has(node.type)) continue;
      let id: string;
      let heading: string | undefined;
      if (node.type === "heading") {
        heading = textOf(node).trim();
        id = unique(slugify(heading));
        section = id;
        n = 0;
      } else {
        id = unique(`${section}-${++n}`);
      }
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      const hash = fnv1a(start !== undefined && end !== undefined ? source.slice(start, end) : JSON.stringify(strip(node)));
      out.push(heading === undefined ? { id, hash } : { id, hash, heading });
      if (node.type === "mdxJsxFlowElement") {
        // Components don't all forward unknown props to the DOM, so wrap them.
        children[i] = {
          type: "mdxJsxFlowElement",
          name: "div",
          attributes: [{ type: "mdxJsxAttribute", name: "data-b", value: id }],
          children: [node],
          position: node.position,
        };
      } else {
        node.data ??= {};
        node.data.hProperties = { ...node.data.hProperties, "data-b": id };
      }
    }
  };
}

function textOf(node: Node): string {
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(textOf).join("");
}

function strip(node: Node): unknown {
  const { position: _p, data: _d, ...rest } = node;
  return { ...rest, children: node.children?.map(strip) };
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Blocks whose content is new since the earlier version, and headings that
 * were removed. Compared by content, so inserting a paragraph doesn't mark
 * every block after it (their position-based ids shift).
 */
export function diffBlocks(before: BlockInfo[], after: BlockInfo[]): { changed: string[]; removedHeadings: string[] } {
  const oldHashes = new Set(before.map((b) => b.hash));
  const headings = new Set(after.filter((b) => b.heading).map((b) => b.heading));
  return {
    changed: after.filter((b) => !oldHashes.has(b.hash)).map((b) => b.id),
    removedHeadings: before.filter((b) => b.heading && !headings.has(b.heading)).map((b) => b.heading!),
  };
}
