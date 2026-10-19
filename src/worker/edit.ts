// Pure edit operations used by the MCP tools. Kept free of storage so they are
// unit-testable.

export type TextEdit = { oldText: string; newText: string; replaceAll?: boolean };

export class EditError extends Error {}

export function applyTextEdits(path: string, content: string, edits: TextEdit[]): string {
  let out = content;
  edits.forEach((edit, i) => {
    if (edit.oldText.length === 0) throw new EditError(`${path} edit ${i + 1}: oldText is empty`);
    const count = countOccurrences(out, edit.oldText);
    if (count === 0) {
      throw new EditError(
        `${path} edit ${i + 1}: oldText not found. Re-read the file with artifact_read or locate it with artifact_grep; whitespace must match exactly.`,
      );
    }
    if (count > 1 && !edit.replaceAll) {
      throw new EditError(
        `${path} edit ${i + 1}: oldText matches ${count} places. Include more surrounding text so it matches once, or set replaceAll.`,
      );
    }
    out = edit.replaceAll ? out.split(edit.oldText).join(edit.newText) : out.replace(edit.oldText, () => edit.newText);
  });
  return out;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) count++;
  return count;
}

// RFC 6902 JSON Patch.
export type JsonPatchOp =
  | { op: "add" | "replace" | "test"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "move" | "copy"; from: string; path: string };

export function applyJsonPatch(doc: unknown, ops: JsonPatchOp[]): unknown {
  let root = structuredClone(doc);
  ops.forEach((op, i) => {
    const where = `op ${i + 1} (${op.op} ${op.path})`;
    switch (op.op) {
      case "add":
        root = setAt(root, parsePointer(op.path), structuredClone(op.value), "add", where);
        break;
      case "replace":
        getAt(root, parsePointer(op.path), where);
        root = setAt(root, parsePointer(op.path), structuredClone(op.value), "replace", where);
        break;
      case "remove":
        root = removeAt(root, parsePointer(op.path), where);
        break;
      case "test":
        if (JSON.stringify(getAt(root, parsePointer(op.path), where)) !== JSON.stringify(op.value)) {
          throw new EditError(`${where}: test failed`);
        }
        break;
      case "copy":
      case "move": {
        const value = structuredClone(getAt(root, parsePointer(op.from), where));
        if (op.op === "move") root = removeAt(root, parsePointer(op.from), where);
        root = setAt(root, parsePointer(op.path), value, "add", where);
        break;
      }
      default:
        throw new EditError(`${where}: unknown op`);
    }
  });
  return root;
}

function parsePointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new EditError(`JSON pointer "${pointer}" must start with "/"`);
  return pointer
    .slice(1)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function getAt(root: unknown, tokens: string[], where: string): unknown {
  let cur: unknown = root;
  for (const t of tokens) {
    if (Array.isArray(cur)) {
      const idx = Number(t);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) throw new EditError(`${where}: no index ${t}`);
      cur = cur[idx];
    } else if (cur && typeof cur === "object" && Object.hasOwn(cur, t)) {
      cur = (cur as Record<string, unknown>)[t];
    } else {
      throw new EditError(`${where}: path not found at "${t}"`);
    }
  }
  return cur;
}

function setAt(root: unknown, tokens: string[], value: unknown, mode: "add" | "replace", where: string): unknown {
  if (tokens.length === 0) return value;
  const parent = getAt(root, tokens.slice(0, -1), where);
  const last = tokens[tokens.length - 1];
  if (Array.isArray(parent)) {
    if (last === "-" && mode === "add") parent.push(value);
    else {
      const idx = Number(last);
      const max = mode === "add" ? parent.length : parent.length - 1;
      if (!Number.isInteger(idx) || idx < 0 || idx > max) throw new EditError(`${where}: bad index ${last}`);
      if (mode === "add") parent.splice(idx, 0, value);
      else parent[idx] = value;
    }
  } else if (parent && typeof parent === "object") {
    (parent as Record<string, unknown>)[last] = value;
  } else {
    throw new EditError(`${where}: parent is not a container`);
  }
  return root;
}

function removeAt(root: unknown, tokens: string[], where: string): unknown {
  if (tokens.length === 0) throw new EditError(`${where}: cannot remove the document root`);
  const parent = getAt(root, tokens.slice(0, -1), where);
  const last = tokens[tokens.length - 1];
  getAt(root, tokens, where);
  if (Array.isArray(parent)) parent.splice(Number(last), 1);
  else delete (parent as Record<string, unknown>)[last];
  return root;
}

export type GrepMatch = { path: string; line: number; text: string };

export function grepFiles(files: Record<string, string>, pattern: string, onlyPath?: string, limit = 50): GrepMatch[] {
  const literal = () => new RegExp(pattern.slice(0, 500).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  let re: RegExp;
  // A pattern that could backtrack for ages (a repeated group that itself repeats, a back-reference) would stall
  // the whole workspace while it runs, so it's searched for as plain text instead.
  if (pattern.length > 200 || /\([^)]*[+*}][^)]*\)\s*[+*{]/.test(pattern) || /\\[1-9]/.test(pattern)) re = literal();
  else {
    try {
      re = new RegExp(pattern, "i");
    } catch {
      re = literal();
    }
  }
  const out: GrepMatch[] = [];
  for (const [path, content] of Object.entries(files)) {
    if (onlyPath && path !== onlyPath) continue;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length && out.length < limit; i++) {
      if (re.test(lines[i])) out.push({ path, line: i + 1, text: lines[i].length > 300 ? `${lines[i].slice(0, 300)}…` : lines[i] });
    }
  }
  return out;
}
