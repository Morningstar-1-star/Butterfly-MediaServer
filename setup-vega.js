import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

const root = process.cwd();
const vega = path.join(root, "vega-providers");
const nuvio = path.join(root, "nuvio-providers");

// yt-dlp standalone binary (no Python needed). Failure only warns: the rest of
// the server works without it and /ytdlp/health will report "unavailable".
async function installYtDlp() {
  if (process.platform !== "linux") {
    console.warn("=== yt-dlp skipped: standalone download is Linux-only (Render is Linux) ===");
    return;
  }
  const asset = process.arch === "arm64" ? "yt-dlp_linux_aarch64" : "yt-dlp_linux";
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;
  const dest = path.join(root, "bin", "yt-dlp");
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    fs.chmodSync(dest, 0o755);
    console.log("=== yt-dlp installed: " + execFileSync(dest, ["--version"]).toString().trim() + " ===");
  } catch (err) {
    console.warn("=== yt-dlp setup skipped: " + (err?.message || err) + " ===");
  }
}

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

await installYtDlp();

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
// process cannot overwrite it. A failure here must not break the whole
// deploy, so it only warns. Requests are proxied at runtime by server.js.
try {
  const olaRepo = path.join(root, "ola-tmp");
  cloneOrUpdate(
    olaRepo,
    "ola-tmp",
    "https://github.com/mickey2406/vega-olamovies.git"
  );

  const olaSource = path.join(olaRepo, "dist", "olamovies");
  const olaDestination = path.join(vega, "dist", "olamovies");

  if (!fs.existsSync(path.join(olaSource, "posts.js"))) {
    throw new Error("dist/olamovies/posts.js was not found.");
  }

  fs.rmSync(olaDestination, { recursive: true, force: true });
  fs.cpSync(olaSource, olaDestination, { recursive: true });
  console.log("=== OlaMovies provider added to Vega ===");
} catch (err) {
  console.warn("=== OlaMovies setup skipped: " + (err?.message || err) + " ===");
}

// Nuvio providers are built separately and do not replace Vega.
// NON-FATAL: if the repo is gone/private the deploy still succeeds (Vega, TMDB,
// yt-dlp, addons keep working). Point NUVIO_REPO on Render at a fork/new URL.
try {
cloneOrUpdate(
  nuvio,
  "nuvio-providers",
  (process.env.NUVIO_REPO || "https://github.com/phisher98/phisher-nuvio-providers.git")
);

// Some repos ship prebuilt providers/*.js and have no package.json: skip build then.
if (fs.existsSync(path.join(nuvio, "package.json"))) {
  console.log("Installing Nuvio dependencies...");
  run("npm", ["install", "--ignore-scripts"], nuvio);

  console.log("Building Nuvio providers...");
  run("npm", ["run", "build"], nuvio);
} else {
  console.log("No package.json in Nuvio repo - using prebuilt providers.");
  // Without this, Node treats the .js files as ESM (our package.json has "type":"module")
  // and none of them export getStreams.
  fs.writeFileSync(path.join(nuvio, "package.json"), JSON.stringify({ private: true, type: "commonjs" }));
}

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

} catch (err) {
  console.warn("=== Nuvio setup skipped: " + (err?.message || err) + " ===");
  console.warn("=== Set NUVIO_REPO to a working repo URL to enable /nuvio/* ===");
}
