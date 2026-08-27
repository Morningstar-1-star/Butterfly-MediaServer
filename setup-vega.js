import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

const root = process.cwd();
const vega = path.join(root, "vega-providers");
const repo = "https://github.com/Zenda-Cross/vega-providers.git";

function run(cmd, args, cwd = root) {
  execFileSync(cmd, args, {
    cwd,
    stdio: "inherit"
  });
}

console.log("=== Vega setup ===");

if (fs.existsSync(path.join(vega, ".git"))) {
  console.log("Existing Vega repository found. Updating...");
  run("git", ["fetch", "--depth", "1", "origin", "main"], vega);
  run("git", ["reset", "--hard", "origin/main"], vega);
} else {
  if (fs.existsSync(vega)) {
    console.log("Removing incomplete Vega directory...");
    fs.rmSync(vega, { recursive: true, force: true });
  }

  console.log("Cloning latest Vega...");
  run("git", [
    "clone",
    "--depth", "1",
    repo,
    "vega-providers"
  ]);
}

console.log("Installing Vega dependencies...");
run("npm", ["install", "--ignore-scripts"], vega);

console.log("Building Vega providers...");
run("npm", ["run", "build"], vega);

console.log("=== Vega ready ===");
