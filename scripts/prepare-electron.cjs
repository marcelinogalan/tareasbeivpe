const { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } = require("fs");
const path = require("path");

const root = process.cwd();
const nextStandaloneDir = path.join(root, ".next", "standalone");
const nextStaticDir = path.join(root, ".next", "static");
const publicDir = path.join(root, "public");
const envLocalFile = path.join(root, ".env.local");

const outputDir = path.join(root, "dist-electron", "app");

if (!existsSync(nextStandaloneDir)) {
  throw new Error("Missing .next/standalone. Run 'npm run build' first.");
}

rmSync(outputDir, { force: true, recursive: true });
mkdirSync(outputDir, { recursive: true });

copyRecursive(nextStandaloneDir, outputDir);

if (existsSync(nextStaticDir)) {
  mkdirSync(path.join(outputDir, ".next"), { recursive: true });
  copyRecursive(nextStaticDir, path.join(outputDir, ".next", "static"));
}

if (existsSync(publicDir)) {
  copyRecursive(publicDir, path.join(outputDir, "public"));
}

if (existsSync(envLocalFile)) {
  copyFileSync(envLocalFile, path.join(outputDir, ".env.local"));
}

console.log(`Electron bundle prepared at ${outputDir}`);

function copyRecursive(source, target) {
  const sourceStat = statSync(source);

  if (sourceStat.isDirectory()) {
    mkdirSync(target, { recursive: true });
    const entries = readdirSync(source);
    for (const entry of entries) {
      copyRecursive(path.join(source, entry), path.join(target, entry));
    }
    return;
  }

  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(source, target);
}
