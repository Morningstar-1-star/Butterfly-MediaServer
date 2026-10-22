import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

const root = process.cwd();
const vega = path.join(root, "vega-providers");
const nuvio = path.join(root, "nuvio-providers");

function run(cmd, args, cwd = root) {
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
}

function cloneOrUpdate(repoPath, folderName, repoUrl) {
  console.log(`=== Preparing ${folderName} ===`);

  if (!fs.existsSync(path.join(repoPath, ".git"))) {
    if (fs.existsSync(repoPath)) {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }

    run("git", [
      "clone",
      "--depth=1",
      repoUrl,
      folderName
    ]);
  } else {
    run("git", ["fetch", "--depth=1", "origin", "main"], repoPath);
    run("git", ["reset", "--hard", "origin/main"], repoPath);
  }
}

// Keep the existing Vega provider setup.
cloneOrUpdate(
  vega,
  "vega-providers",
  "https://github.com/Zenda-Cross/vega-providers.git"
);

console.log("Installing Vega dependencies...");
run("npm", ["install", "--ignore-scripts"], vega);

console.log("Building Vega...");
run("npm", ["run", "build"], vega);
console.log("=== Vega ready ===");

// Add the OlaMovies Vega provider after the main Vega build so the build
// process cannot overwrite it.
const olaRepo = path.join(root, "ola-tmp");
cloneOrUpdate(
  olaRepo,
  "ola-tmp",
  "https://github.com/mickey2406/vega-olamovies.git"
);

const olaSource = path.join(olaRepo, "dist", "olamovies");
const olaDestination = path.join(vega, "dist", "olamovies");

if (!fs.existsSync(olaSource)) {
  throw new Error("OlaMovies setup failed: dist/olamovies was not found.");
}

fs.rmSync(olaDestination, { recursive: true, force: true });
fs.cpSync(olaSource, olaDestination, { recursive: true });

// Add browser-style fetch headers to the OlaMovies API search request.
// This only helps if the 403 is header-related; it cannot bypass IP blocks
// or an anti-bot challenge.
const olaPostsPath = path.join(olaDestination, "posts.js");
if (fs.existsSync(olaPostsPath)) {
  let olaPosts = fs.readFileSync(olaPostsPath, "utf8");
  const oldSearchHeader = 'Accept:"application/json"';
  const browserSearchHeaders = 'Accept:"application/json","Origin":baseUrl,"Sec-Fetch-Site":"same-origin","Sec-Fetch-Mode":"cors","Sec-Fetch-Dest":"empty","Cache-Control":"no-cache","Pragma":"no-cache"';
  if (olaPosts.includes(oldSearchHeader) && !olaPosts.includes('"Sec-Fetch-Site":"same-origin"')) {
    olaPosts = olaPosts.replace(oldSearchHeader, browserSearchHeaders);
    fs.writeFileSync(olaPostsPath, olaPosts, "utf8");
    console.log("=== OlaMovies search browser headers patched ===");
  } else {
    console.log("=== OlaMovies search header patch skipped (pattern not found or already applied) ===");
  }
} else {
  throw new Error("OlaMovies setup failed: posts.js was not found.");
}
console.log("=== OlaMovies provider added to Vega ===");

// Nuvio providers are built separately and do not replace Vega.
cloneOrUpdate(
  nuvio,
  "nuvio-providers",
  "https://github.com/phisher98/phisher-nuvio-providers.git"
);

console.log("Installing Nuvio dependencies...");
run("npm", ["install", "--ignore-scripts"], nuvio);

console.log("Building Nuvio providers...");
run("npm", ["run", "build"], nuvio);

// Some bundled Nuvio providers externalize these runtime packages.
// Install them in the Nuvio directory so require() can resolve them.
console.log("Installing Nuvio runtime dependencies...");
run(
  "npm",
  [
    "install",
    "--ignore-scripts",
    "--no-save",
    "axios",
    "crypto-js",
    "cheerio-without-node-native"
  ],
  nuvio
);

const manifestPath = path.join(nuvio, "manifest.json");
if (!fs.existsSync(manifestPath)) {
  throw new Error("Nuvio setup failed: manifest.json was not created/found.");
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (!Array.isArray(manifest.scrapers)) {
  throw new Error("Nuvio setup failed: manifest.json has no scrapers array.");
}

const providerDir = path.join(nuvio, "providers");
const builtCount = fs.existsSync(providerDir)
  ? fs.readdirSync(providerDir).filter(file => file.endsWith(".js")).length
  : 0;

console.log(`=== Nuvio ready: ${manifest.scrapers.length} manifest entries, ${builtCount} built JS files ===`);
