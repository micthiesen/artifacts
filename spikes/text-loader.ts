import { plugin } from "bun";
plugin({ name: "css-text", setup(b) { b.onLoad({ filter: /\.css$/ }, async (a) => ({ contents: `export default ${JSON.stringify(await Bun.file(a.path).text())}`, loader: "js" })); } });
