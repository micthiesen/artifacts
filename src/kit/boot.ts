// Side-effect entry: `<script type="module" src="/kit/v1/boot.js">` boots the
// frame without an inline script (keeps the frame CSP free of script hashes
// beyond the import map).
import { boot } from "./runtime.tsx";

void boot();
