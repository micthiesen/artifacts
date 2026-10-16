// Writes src/worker/kit-exports.json: the names artifacts may import from each
// allowed module, and the components MDX gets without imports. The Worker uses
// it to reject unknown names at write time instead of at render time.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
const ui = await import("../src/kit/ui/index.ts");
const hooks = await import("../src/kit/hooks.ts");
const react = await import("react");
const lucide = await import("lucide-react");
const recharts = await import("recharts");
const mdx = Object.keys((ui as { useMDXComponents: () => Record<string, unknown> }).useMDXComponents());
const names = (m: object) => Object.keys(m).filter((k) => k !== "default").sort();
const out = {
  modules: {
    "@a/ui": names(ui),
    "@a/hooks": names(hooks),
    react: names(react),
    "react/jsx-runtime": ["Fragment", "jsx", "jsxs"],
    "lucide-react": names(lucide),
    recharts: names(recharts),
  },
  mdxComponents: mdx.filter((k) => /^[A-Z]/.test(k)).sort(),
};
await Bun.write("src/worker/kit-exports.json", `${JSON.stringify(out)}\n`);
await GlobalRegistrator.unregister();
console.log(Object.fromEntries(Object.entries(out.modules).map(([k, v]) => [k, v.length])), "mdx", out.mdxComponents.length);
