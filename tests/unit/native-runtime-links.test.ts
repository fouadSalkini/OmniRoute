import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { relinkRuntimeBins } from "../../scripts/build/relink-runtime-bins.mjs";
import { artifactManifest, nativeBinaryClass } from "../../scripts/ci/qualify-native-artifact.mjs";

test("internal bin links become relative while unrelated escaping links remain rejected", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-runtime-links-"));
  try {
    const runtime = path.join(directory, "runtime");
    const source = path.join(directory, "source");
    fs.mkdirSync(path.join(runtime, ".bin"), { recursive: true });
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(runtime, "entry.js"), "entry");
    fs.symlinkSync(path.join(runtime, "entry.js"), path.join(runtime, ".bin", "entry"));
    assert.equal(relinkRuntimeBins(runtime, source), 1);
    assert.equal(fs.readlinkSync(path.join(runtime, ".bin", "entry")), "../entry.js");
    assert.equal(relinkRuntimeBins(runtime, source), 0);
    artifactManifest(runtime);
    const outside = path.join(directory, "outside.js");
    fs.writeFileSync(outside, "outside");
    fs.symlinkSync(outside, path.join(runtime, ".bin", "outside"));
    assert.throws(() => relinkRuntimeBins(runtime, source), /outside build dependencies/);
    fs.unlinkSync(path.join(runtime, ".bin", "outside"));
    fs.symlinkSync(outside, path.join(runtime, "unrelated-link"));
    assert.equal(relinkRuntimeBins(runtime, source), 0);
    assert.throws(() => artifactManifest(runtime), /Absolute artifact symlink/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("bin links into any listed copy source are repointed at the bundled copy", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-runtime-links-"));
  try {
    const runtime = path.join(directory, "runtime");
    const source = path.join(directory, "source");
    const standalone = path.join(directory, "standalone");
    const nested = path.join("global-agent", "node_modules", "semver", "bin");
    for (const root of [runtime, standalone]) {
      fs.mkdirSync(path.join(root, nested), { recursive: true });
      fs.writeFileSync(path.join(root, nested, "semver.js"), "semver");
    }
    fs.mkdirSync(source);
    const bin = path.join(runtime, "global-agent", "node_modules", ".bin");
    fs.mkdirSync(bin);
    fs.symlinkSync(path.join(standalone, nested, "semver.js"), path.join(bin, "semver"));
    assert.throws(() => relinkRuntimeBins(runtime, source), /outside build dependencies/);
    assert.equal(relinkRuntimeBins(runtime, [source, standalone]), 1);
    assert.equal(fs.readlinkSync(path.join(bin, "semver")), "../semver/bin/semver.js");
    artifactManifest(runtime);
    assert.equal(
      relinkRuntimeBins(runtime, [source, path.join(directory, "missing")]),
      0,
      "a missing optional source is skipped"
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("ELF validation rejects truncated headers and accepts big-endian target headers", () => {
  const malformed = Buffer.from("7f454c46", "hex");
  assert.throws(() => nativeBinaryClass(malformed, "x64"), /Malformed ELF header/);
  for (const [architecture, machine] of [
    ["x64", 62],
    ["arm64", 183],
  ] as const) {
    const header = Buffer.alloc(20);
    malformed.copy(header);
    header[5] = 2;
    header.writeUInt16BE(machine, 18);
    assert.equal(nativeBinaryClass(header, architecture), "target-elf");
    header[5] = 0;
    assert.throws(() => nativeBinaryClass(header, architecture), /Malformed ELF header/);
  }
});
