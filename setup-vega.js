import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

const root = process.cwd();
const vega = path.join(root, "vega-providers");

function run(cmd, args, cwd = root) {
  execFileSync(cmd, args, {
    cwd,
    stdio: "inherit"
  });
}

if (!fs.existsSync(path.join(vega, "build-bundled.js"))) {
  fs.rmSync(vega, { recursive: true, force: true });

  run("git", [
    "clone",
    "--depth", "1",
    "https://github.com/Zenda-Cross/vega-providers.git",
    "vega-providers"
  ]);
} else {
  run("git", ["fetch", "origin", "main"], vega);
  run("git", ["reset", "--hard", "origin/main"], vega);
}

console.log("Installing Vega dependencies...");
run("npm", ["install", "--omit=dev"], vega);

console.log("Building latest Vega providers...");
run("npm", ["run", "build"], vega);

console.log("Vega providers ready.");
