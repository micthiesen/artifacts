import { useShared, useViewer } from "../hooks.ts";

export default function App() {
  const [n] = useShared("n", 0);
  const v = useViewer();
  return <p id="out">{`n=${n} viewer=${v.email} ls=${window.localStorage.getItem("seen")}`}</p>;
}
