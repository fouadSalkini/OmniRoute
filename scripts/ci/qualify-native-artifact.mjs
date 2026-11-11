import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { relinkRuntimeBins } from "../build/relink-runtime-bins.mjs";

export function artifactManifest(directory) {
  const root = fs.realpathSync(directory);
  const files = {};
  const symlinks = {};
  function visit(parent) {
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      const filename = path.join(parent, entry.name);
      const relative = path.relative(root, filename);
      if (entry.isSymbolicLink()) {
        assert.ok(
          !path.isAbsolute(fs.readlinkSync(filename)),
          `Absolute artifact symlink: ${relative}`
        );
        const resolved = fs.realpathSync(filename);
        assert.ok(
          resolved === root || resolved.startsWith(root + path.sep),
          `Artifact symlink escapes runtime: ${relative}`
        );
        symlinks[relative] = fs.readlinkSync(filename);
      } else if (entry.isDirectory()) {
        visit(filename);
      } else if (entry.isFile()) {
        files[relative] = createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
      }
    }
  }
  visit(root);
  return { files, symlinks };
}

function command(executable, args) {
  const completed = spawnSync(executable, args, {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(completed.status, 0, `${executable} qualification failed`);
  return completed.stdout;
}

export function nativeBinaryClass(header, architecture) {
  if (header.subarray(0, 4).toString("hex") !== "7f454c46") return "foreign-format";
  assert.ok(header.length >= 20 && [1, 2].includes(header[5]), "Malformed ELF header");
  const machine = header[5] === 1 ? header.readUInt16LE(18) : header.readUInt16BE(18);
  return machine === (architecture === "arm64" ? 183 : 62) ? "target-elf" : "foreign-arch";
}

function verifySymbolVersions(libraries, requiredVersions) {
  const glibc = process.report.getReport().header.glibcVersionRuntime.split(".").map(Number);
  for (const version of requiredVersions.filter((entry) => entry.startsWith("GLIBC_"))) {
    const required = version.slice(6).split(".").map(Number);
    assert.ok(
      required[0] < glibc[0] || (required[0] === glibc[0] && (required[1] ?? 0) <= glibc[1]),
      `Unsupported ${version}`
    );
  }
  const stdcpp = /libstdc\+\+\.so\.6 => (\S+)/.exec(libraries)?.[1];
  const requiredCpp = requiredVersions.filter((entry) => entry.startsWith("GLIBCXX_"));
  if (requiredCpp.length) {
    assert.ok(stdcpp, "Missing C++ runtime");
    const available = command("objdump", ["-T", stdcpp]);
    for (const version of requiredCpp)
      assert.ok(available.includes(version), `Unsupported ${version}`);
  }
}

export function verifyNativeLibraries(directory, manifest) {
  const classified = Object.keys(manifest.files)
    .filter((relative) => relative.endsWith(".node"))
    .map((relative) => {
      const filename = path.join(directory, relative);
      const binaryClass = nativeBinaryClass(
        fs.readFileSync(filename).subarray(0, 20),
        process.arch
      );
      if (binaryClass !== "target-elf") return { file: relative, binaryClass };
      const dynamic = command("objdump", ["-p", filename]);
      if (/NEEDED\s+(?:libc\.musl-\S+|libc\.so\s*$)/m.test(dynamic)) {
        return { file: relative, binaryClass: "foreign-libc" };
      }
      const libraries = command("ldd", [filename]);
      const missing = [...libraries.matchAll(/^\s*(\S+) => not found/gm)].map((match) => match[1]);
      const optionalKeytar =
        relative === "node_modules/keytar/build/Release/keytar.node" &&
        missing.length === 1 &&
        missing[0] === "libsecret-1.so.0";
      assert.ok(missing.length === 0 || optionalKeytar, `Missing native library: ${relative}`);
      const symbols = command("objdump", ["-T", filename]);
      const requiredVersions = [...new Set(symbols.match(/GLIBC(?:XX)?_[\d.]+/g) ?? [])].sort();
      verifySymbolVersions(libraries, requiredVersions);
      return {
        file: relative,
        binaryClass: "target-glibc",
        requiredVersions,
        missing,
        ...(optionalKeytar ? { exception: "existing-optional-keytar-libsecret" } : {}),
      };
    });
  const target = classified.filter((entry) => entry.binaryClass === "target-glibc");
  for (const expected of [
    "node_modules/keytar/build/Release/keytar.node",
    `node_modules/better-sqlite3/prebuilds/linux-${process.arch}.node`,
    `node_modules/onnxruntime-node/bin/napi-v6/linux/${process.arch}/onnxruntime_binding.node`,
  ]) {
    assert.ok(
      target.some((entry) => entry.file === expected),
      `Missing target native addon: ${expected}`
    );
  }
  return classified;
}

async function smokePm2(directory, scratch) {
  assert.notEqual(fs.readlinkSync("/proc/self/ns/net"), fs.readlinkSync("/proc/1/ns/net"));
  command("ip", ["link", "set", "lo", "up"]);
  // Keep PM2 outside the checkout: optional-driver resolution uses its argv[1].
  const wrapper = "/opt/omniroute-ci-pm2/node_modules/pm2/lib/ProcessContainerFork.js";
  assert.ok(fs.existsSync(wrapper));
  let output = "";
  const child = spawn(process.execPath, [wrapper], {
    cwd: scratch,
    detached: true,
    env: {
      PATH: process.env.PATH,
      HOME: scratch,
      DATA_DIR: scratch,
      PORT: "21938",
      HOSTNAME: "127.0.0.1",
      NODE_ENV: "production",
      pm_exec_path: path.join(directory, "server.js"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let exitCode;
  child.once("error", () => {
    exitCode = 125;
  });
  const exited = new Promise((resolve) =>
    child.once("exit", (code) => {
      exitCode = code;
      resolve();
    })
  );
  const collect = (chunk) => {
    output = (output + chunk.toString()).slice(-262_144);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  let good = 0;
  try {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline && good < 6 && exitCode === undefined) {
      try {
        const response = await fetch("http://127.0.0.1:21938/healthz", {
          signal: AbortSignal.timeout(2000),
        });
        await response.arrayBuffer();
        good = response.status === 200 ? good + 1 : 0;
      } catch {
        good = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.equal(good, 6, "PM2 artifact health smoke failed");
    assert.match(
      output,
      /\[DB\] Driver:\s*node:sqlite\b/,
      "Actual PM2 entrypoint must use node:sqlite"
    );
    return { driver: "node:sqlite", consecutiveHealthy: good };
  } finally {
    if (child.pid && exitCode === undefined) {
      process.kill(-child.pid, "SIGTERM");
      const timer = setTimeout(() => {
        if (exitCode === undefined) process.kill(-child.pid, "SIGKILL");
      }, 5000);
      await exited;
      clearTimeout(timer);
    }
  }
}

async function main() {
  if (process.argv[3] === "--verify") {
    const saved = JSON.parse(fs.readFileSync("_artifacts/native-artifact/manifest.json", "utf8"));
    assert.deepEqual(
      artifactManifest(process.argv[2]),
      saved,
      "Runtime changed after qualification"
    );
    return;
  }
  const [expectedArch, expectedAbi, expectedNode] = process.argv.slice(3);
  assert.ok(
    expectedArch && expectedAbi && expectedNode,
    "Expected architecture, ABI and Node version arguments required"
  );
  assert.equal(process.arch, expectedArch);
  assert.equal(process.versions.modules, expectedAbi);
  assert.equal(process.versions.node, expectedNode);
  const directory = fs.realpathSync(process.argv[2]);
  const nextDistDir = process.env.NEXT_DIST_DIR || ".build/next";
  const repairedBinLinks = relinkRuntimeBins(path.join(directory, "node_modules"), [
    path.resolve("node_modules"),
    path.resolve(nextDistDir, "standalone", "node_modules"),
  ]);
  const source = process.env.GITHUB_SHA;
  assert.match(source, /^[a-f0-9]{40}$/);
  const marker = fs.readFileSync(path.join(directory, "BUILD_SHA"), "utf8").trim();
  assert.match(marker, /^[a-f0-9]{8,40}$/);
  assert.ok(source.startsWith(marker));
  fs.mkdirSync(path.resolve("_artifacts"), { recursive: true });
  const scratch = fs.mkdtempSync(path.resolve("_artifacts/native-smoke-"));
  let smoke;
  try {
    smoke = await smokePm2(directory, scratch);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  const manifest = artifactManifest(directory);
  const libraries = verifyNativeLibraries(directory, manifest);
  assert.ok(libraries.length > 0, "Native artifact contains no addons");
  const receipt = {
    source,
    repairedBinLinks,
    node: process.versions.node,
    abi: process.versions.modules,
    arch: process.arch,
    glibc: process.report.getReport().header.glibcVersionRuntime,
    lockfileSha256: createHash("sha256").update(fs.readFileSync("package-lock.json")).digest("hex"),
    nativeLibraries: libraries,
    smoke,
    files: Object.keys(manifest.files).length,
  };
  const output = path.resolve("_artifacts/native-artifact");
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  fs.writeFileSync(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(
    JSON.stringify({ source, arch: receipt.arch, abi: receipt.abi, files: receipt.files, smoke })
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Native qualification failed");
    process.exitCode = 1;
  });
}
