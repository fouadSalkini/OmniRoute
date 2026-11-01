import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { artifactManifest, nativeBinaryClass } from "../../scripts/ci/qualify-native-artifact.mjs";
import { relinkRuntimeBins } from "../../scripts/build/relink-runtime-bins.mjs";

test("copied nested npm bin links are relocated only to identical runtime bytes", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-bin-relink-"));
  try {
    const source = path.join(temporary, "source");
    const runtime = path.join(temporary, "dist");
    const relative = path.join("global-agent", "node_modules");
    fs.mkdirSync(path.join(source, relative, ".bin"), { recursive: true });
    fs.mkdirSync(path.join(source, relative, "semver", "bin"), { recursive: true });
    fs.writeFileSync(path.join(source, relative, "semver", "bin", "semver.js"), "executable");
    fs.symlinkSync("../semver/bin/semver.js", path.join(source, relative, ".bin", "semver"));
    fs.cpSync(source, runtime, { recursive: true });
    assert.throws(() => artifactManifest(runtime), /(?:symlink escapes runtime|Absolute artifact symlink)/);
    assert.equal(relinkRuntimeBins(runtime, source), 1);
    assert.equal(fs.realpathSync(path.join(runtime, relative, ".bin", "semver")), fs.realpathSync(path.join(runtime, relative, "semver", "bin", "semver.js")));
    artifactManifest(runtime);
    fs.unlinkSync(path.join(runtime, relative, ".bin", "semver"));
    fs.symlinkSync(path.join(source, relative, "semver", "bin", "semver.js"), path.join(runtime, relative, ".bin", "semver"));
    fs.writeFileSync(path.join(runtime, relative, "semver", "bin", "semver.js"), "different");
    assert.throws(() => relinkRuntimeBins(runtime, source), /differs/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("native addon headers distinguish vendored foreign binaries from the target", () => {
  for (const [machine, target, expected] of [
    [183, "arm64", "target-elf"],
    [62, "x64", "target-elf"],
    [62, "arm64", "foreign-arch"],
    [183, "x64", "foreign-arch"],
  ] as const) {
    const header = Buffer.alloc(20);
    header.write("\u007fELF", 0);
    header[5] = 1;
    header.writeUInt16LE(machine, 18);
    assert.equal(nativeBinaryClass(header, target), expected);
  }
  assert.equal(nativeBinaryClass(Buffer.from("MZ-windows"), "x64"), "foreign-format");
});

test("native runtime manifest hashes nested files and rejects escaping symlinks", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-native-manifest-"));
  try {
    const runtime = path.join(temporary, "dist");
    fs.mkdirSync(path.join(runtime, "nested"), { recursive: true });
    fs.writeFileSync(path.join(runtime, "nested", "server.js"), "runtime bytes");
    fs.symlinkSync("nested/server.js", path.join(runtime, "entry.js"));
    assert.deepEqual(artifactManifest(runtime), {
      files: {
        [path.join("nested", "server.js")]: createHash("sha256")
          .update("runtime bytes")
          .digest("hex"),
      },
      symlinks: { "entry.js": "nested/server.js" },
    });
    fs.writeFileSync(path.join(temporary, "outside"), "not runtime");
    fs.symlinkSync("../outside", path.join(runtime, "escape"));
    assert.throws(() => artifactManifest(runtime), /(?:symlink escapes runtime|Absolute artifact symlink)/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
