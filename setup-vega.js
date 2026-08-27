import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

const root = process.cwd();
const vega = path.join(root, "vega-providers");

function run(cmd, args, cwd = root) {
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
}

console.log("=== Preparing Vega ===");

if (!fs.existsSync(path.join(vega, ".git"))) {
  if (fs.existsSync(vega)) {
    fs.rmSync(vega, { recursive: true, force: true });
  }

  run("git", [
    "clone",
    "--depth=1",
    "https://github.com/Zenda-Cross/vega-providers.git",
    "vega-providers"
  ]);
} else {
  run("git", ["fetch", "--depth=1", "origin", "main"], vega);
  run("git", ["reset", "--hard", "origin/main"], vega);
}

console.log("Installing Vega dependencies...");
run("npm", ["install", "--ignore-scripts"], vega);

console.log("Building Vega...");
run("npm", ["run", "build"], vega);

console.log("=== Vega ready ===");
