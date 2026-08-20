import { chmod, mkdir, rename, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = process.cwd();
const source = resolve(root, "native/mouse-monitor.swift");
const outputDir = resolve(root, "native/bin");
const output = resolve(outputDir, "pawpal-mouse-monitor");

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${command} exited with code ${code ?? "unknown"}`));
    });
  });
}

if (process.platform !== "darwin") {
  console.log("Skipping the macOS mouse monitor on this platform.");
  process.exit(0);
}

await mkdir(outputDir, { recursive: true });
const architectures = ["arm64", "x86_64"];
const binaries = [];

try {
  for (const architecture of architectures) {
    const binary = `${output}.${architecture}`;
    binaries.push(binary);
    await run("xcrun", [
      "swiftc",
      "-O",
      "-target",
      `${architecture}-apple-macos13.0`,
      source,
      "-o",
      binary,
    ]);
  }
  await run("lipo", ["-create", ...binaries, "-output", `${output}.next`]);
  await rm(output, { force: true });
  await rename(`${output}.next`, output);
  await chmod(output, 0o755);
  console.log(`Built universal macOS mouse monitor: ${output}`);
} finally {
  await Promise.all(binaries.map((binary) => rm(binary, { force: true })));
  await rm(`${output}.next`, { force: true });
}
