# Artifact kit reference

An artifact has one entry: `index.mdx` / `index.md` (a readable report) or `app.tsx` (a full-height app, `export default function App()`). Other `*.tsx` files import by relative path; `data/*.json` files load with `useData("x.json")` or a component's `data="x.json"`. Allowed imports: `react`, `@a/ui`, `@a/hooks`, `lucide-react`, `recharts`, relative files. MDX gets every `@a/ui` component and styled markdown with no imports. There is no network: no fetch, no external images or fonts (use `data:` URLs).
- `useAsset(path)` → URL of a file uploaded with artifact_asset (e.g. `"assets/logo.png"`); MDX images (`![alt](assets/logo.png)`) resolve automatically.

Style with Tailwind classes and theme tokens (the theme is dark only): `bg-background bg-card bg-muted bg-accent bg-primary text-foreground text-muted-foreground text-primary text-primary-foreground border-border text-positive text-caution text-negative bg-chart-1`…`6`, `bg-signal` (the accent gradient; use sparingly), `rounded-lg`, `font-mono`. Avoid raw colors like `bg-white` or `text-gray-500`. Readers are often on phones (about 390 px): no fixed widths over about 360 px unless behind `md:`.

## Components (`@a/ui`)

Layout and content
- `Page({title?, subtitle?, wide?})`: centered readable column. MDX is already wrapped in one.
- `Section({title, description?})`, `Grid({cols: 1-6, gap?})`, `Stack({direction?: "row"|"col", gap?, align?})`
- `Summary`: the lead answer, set large. Put it first.
- `Callout({tone?: "info"|"success"|"warning"|"danger", title?})`
- `Stat({label, value, delta?: "+12%"|number, hint?, invert?})` inside `Stats` (responsive row)
- `Steps` > `Step({title})`; `Timeline` > `TimelineItem({date?, title?, tone?})`
- `Link({href})`: external, opens a new tab. Markdown links do the same.

Data
- `Table({data: "x.json"|rows, columns?: "a b c"|string[]|{key,label?,format?,align?}[], sort?: "col"|"-col", search?, limit?, empty?})`: sortable headers. Formats numbers, booleans and URLs automatically; `format` can be `number integer percent currency currency:EUR date url bool text` or a function.
- `Chart({type?: "line"|"bar"|"area"|"pie", data, x, y: "a"|"a b"|string[], height?: 280, stacked?, legend?, title?})`
- `Sparkline({data: number[]|"x.json", y?, tone?})`

Diagrams (Mermaid, rendered by Pele; the only way to draw anything that isn't a `Chart`)
- In MDX/Markdown, write a ```` ```mermaid ```` fenced block; it becomes a themed, responsive, zoomable SVG card. In TSX use `Diagram({code: string, title?})` (or the source as children). Fences are syntax-checked on write.
- Pick the type by what you're showing (first line of the source):
  - Process or decision flow: `flowchart TD` (`LR` for short chains); agent or LLM pipeline: `agentflow-beta TB`; handoffs between teams: `swimlane-beta LR`
  - Who calls whom, in order: `sequenceDiagram`; lifecycle: `stateDiagram-v2`; user steps with sentiment: `journey`
  - Data model: `erDiagram`; types and code structure: `classDiagram`; requirements traceability: `requirementDiagram`
  - Systems and services: `architecture-beta`, `C4Context`/`C4Container`/`C4Component`, `block`; network packet or binary layout: `packet`
  - Plans and status: `gantt` (dated schedule), `timeline` (milestones), `kanban` (work by column), `gitGraph` (branches and releases)
  - Ideas and hierarchy: `mindmap`, `treeView-beta` (file trees), `ishikawa-beta` (root causes), `cynefin-beta`, `wardley-beta`
  - Quantities Chart can't show: `quadrantChart` (2x2 prioritization), `sankey` (flows between stages), `radar-beta` (multi-axis comparison), `treemap-beta` (part of whole, nested), `venn-beta` (overlap)
  - Grammar: `railroad-ebnf-beta`; actors and use cases: `usecase-beta`
- `Chart` vs Mermaid: line, bar, area and pie charts of numbers always use `Chart` with a data file (Mermaid `pie` and `xychart` are rejected). Everything above uses Mermaid.
- Keep labels short (2-4 words) and diagrams under ~25 nodes; split bigger ones by section. Let the theme supply colors: no `style`, `classDef` colors, `%%{init}%%` or `theme:` config. Never hand-draw with SVG, positioned divs or ASCII art.

Primitives
- `Button({variant?: default|secondary|outline|ghost|destructive|link, size?: sm|default|lg|icon|icon-sm})`
- `Badge({tone?: neutral|primary|positive|caution|negative|outline})`
- `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter`
- `Input`, `Textarea`, `Label`, `Select({options: (string|{value,label})[], value?, defaultValue?, onValueChange?, placeholder?})`
- `Checkbox` and `Switch({checked?, defaultChecked?, onCheckedChange?, label?})`; `Slider({value?, defaultValue?, min?, max?, step?, onValueChange?})`
- `Tabs({defaultValue})` > `TabsList` > `TabsTrigger({value})`, then `TabsContent({value})`
- `Accordion` > `AccordionItem({value})` > `AccordionTrigger` + `AccordionContent`
- `Dialog` > `DialogTrigger` (`render={<Button/>}` to restyle) + `DialogContent` > `DialogHeader` > `DialogTitle`, `DialogDescription`, then `DialogFooter`, `DialogClose`
- `Popover` > `PopoverTrigger` + `PopoverContent({side?, align?})`; `Tooltip({content, side?})` wraps one element
- `Progress({value, max?, label?})`, `Separator`, `Avatar({email?|name?, src?, size?})`, `AvatarGroup({emails})`, `Kbd`, `Skeleton`, `ScrollArea`

Live and shared (they work without extra code; view-only and anonymous viewers see results read-only)
- `Poll({id, options, multiple?, question?})`: shows counts and who voted.
- `Checklist({id, items: string[], allowAdd?})`: shows who checked each item.
- `Comments({id?: "main", title?})`: newest last, with author and time.
- `Notes({id, placeholder?, rows?})`: a shared textarea that saves as you type and shows who last edited it.
- `Approval({id, title?, description?, approvers?: string[]})`: sign-off. Each person approves or requests changes, with an optional note; with `approvers` (emails) it reads "Approved" once all of them approve and lists who it's waiting on. Decisions are at `approve/<id>/<email>` as `{decision: "approve"|"changes", note?, by, at, version}`, where `version` is the one the person was looking at. A decision made on an earlier version than the page shows as needing a new look and doesn't count until they decide again.
- `Form({id, fields, title?, description?, submitLabel?, showResponses?: true})`: collects one response per person, which they can edit. `fields` is `{name, label?, type?: "text"|"textarea"|"number"|"email"|"date"|"select"|"checkbox", options?, required?, placeholder?, hint?}[]`. Field values are text, numbers or true/false. Responses are at `form/<id>/<email>` as `{values, by, at, version}`, and everyone who can open the artifact can read them (`showResponses={false}` only hides the table).
- `Approval` and `Form` ids use letters, digits, `-`, `_` and `.`. Only people make decisions and responses, in the page; agents read them with artifact_state.
- Use `Poll` to pick between options, `Approval` for a go/no-go on the whole artifact, and `Form` when you need specific facts back from each person. Share with `edit` access the people who should take part; `view` is read-only.

## Hooks (`@a/hooks`)

- `useShared(key, default)` returns `[value, set]`. Shared live with everyone. `set(v | prev => v)` updates instantly. `null` deletes. The last write per key wins.
- `useSharedMap<T>(prefix)` returns `{entries: [key, T][], get, set, delete}` over keys `prefix/<key>`. Use it for lists.
- `useLocal(key, default)` returns `[value, set]`. Private to this viewer and persists across visits. `localStorage` works too.
- `useViewer()` returns `{email: string|null, role: "owner"|"edit"|"view", canWrite}`.
- `usePresence()` returns the emails viewing now. `useTheme()` returns `"dark"` (the kit is dark only).
- `useData<T>(path)` returns the parsed `data/*.json` contents and throws if the file is missing.

Shared-state rules: store one key per list item (`todo/<id>`), never a whole array under one key, or concurrent edits get lost. Values are JSON, at most 64 KB each. Writes from `view` or anonymous viewers are ignored, so check `canWrite` to disable controls. Forms cannot navigate: handle Enter and clicks yourself, or call `e.preventDefault()` in `onSubmit`.

## Example: `index.mdx` with `data/tools.json`

````mdx
# Picking a CI provider

<Summary>Use **Buildkite**: fastest on our monorepo and cheapest at our scale.</Summary>

<Stats>
  <Stat label="Median build" value="6m 10s" delta="-38%" invert />
  <Stat label="Cost / month" value="$420" />
</Stats>

## Options

<Table data="tools.json" columns="name minutes price selfHosted" sort="minutes" />

<Callout tone="warning">Self-hosted agents need one more runner box.</Callout>

## How it ships

```mermaid
flowchart LR
  PR[Pull request] --> CI{Buildkite}
  CI -- green --> Stage[Staging] --> Prod[Production]
  CI -- red --> PR
```

## Decide

<Poll id="ci" options={["Buildkite", "GitHub Actions", "CircleCI"]} />
<Checklist id="next" items={["Trial on the monorepo", "Get a quote"]} allowAdd />
<Comments />
````

## Example: `app.tsx`

```tsx
import { useState } from "react";
import { Button, Card, CardContent, CardHeader, CardTitle, Checkbox, Input } from "@a/ui";
import { useShared, useSharedMap, useViewer } from "@a/hooks";

type Item = { text: string; done: boolean };

export default function App() {
  const { canWrite } = useViewer();
  const [title, setTitle] = useShared("title", "Launch list");
  const items = useSharedMap<Item>("item");
  const [draft, setDraft] = useState("");
  const add = () => { if (draft) items.set(crypto.randomUUID(), { text: draft, done: false }); setDraft(""); };
  return (
    <div className="mx-auto max-w-xl p-6">
      <Card>
        <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3">
          {items.entries.map(([id, it]) => (
            <Checkbox key={id} label={it.text} checked={it.done} disabled={!canWrite}
              onCheckedChange={(done) => items.set(id, { ...it, done })} />
          ))}
          <div className="flex gap-2">
            <Input value={draft} onChange={(e) => setDraft(e.target.value)} disabled={!canWrite}
              onKeyDown={(e) => e.key === "Enter" && add()} />
            <Button onClick={add} disabled={!canWrite || !draft}>Add</Button>
          </div>
          <Button variant="ghost" onClick={() => setTitle("Launch list (final)")}>Rename</Button>
        </CardContent>
      </Card>
    </div>
  );
}
```
