# Third-party notices

The frame kit (`src/kit/`, served at `/kit/v1/`) bundles or adapts the
following. Minified bundles also ship extracted license comments as
`*.LEGAL.txt` next to each file.

## Adapted code and design patterns

- **shadcn/ui** (https://github.com/shadcn-ui/ui), MIT License, Copyright (c)
  2023 shadcn. Component APIs (Button variants/sizes, Card parts, Dialog,
  Popover, Tabs, Accordion part names) and some utility-class patterns in
  `src/kit/ui/` are adapted from shadcn/ui. The `cn()` helper follows the
  shadcn convention (clsx + tailwind-merge).

No code from React Bits or Aceternity UI is used.

## Bundled packages

| Package | License |
|---|---|
| react, react-dom, scheduler | MIT, Copyright (c) Meta Platforms, Inc. and affiliates |
| @base-ui/react (and @floating-ui/*) | MIT, Copyright (c) 2025 Material-UI SAS / Floating UI contributors |
| lucide-react | ISC, Copyright (c) Lucide Contributors; portions MIT, Copyright (c) Cole Bemis (Feather) |
| recharts (and its d3-* / redux dependencies) | MIT, Copyright (c) Recharts Group; d3 modules ISC, Copyright Mike Bostock |
| pele | MIT, Copyright (c) kepano |
| clsx | MIT, Copyright (c) Luke Edwards |
| tailwind-merge | MIT, Copyright (c) Dany Castillo |
| tailwindcss (compiled CSS, preflight) | MIT, Copyright (c) Tailwind Labs, Inc. |

## Fonts

- **Inter Variable** by Rasmus Andersson, via @fontsource-variable/inter.
  SIL Open Font License 1.1; full text shipped at `/kit/v1/fonts/LICENSE-Inter.txt`.

## MIT License (shadcn/ui)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
