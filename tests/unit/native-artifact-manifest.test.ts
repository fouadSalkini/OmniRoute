import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { artifactManifest, nativeBinaryClass } from "../../scripts/ci/qualify-native-artifact.mjs";

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
    assert.throws(() => artifactManifest(runtime), /symlink escapes runtime/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
