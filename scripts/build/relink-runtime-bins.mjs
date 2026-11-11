import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * fs.cp can turn npm's relative bin links into absolute links to the builder.
 * `sourceDirectories` lists every tree the runtime was copied from (the installed
 * node_modules and the Next standalone node_modules); missing ones are skipped.
 */
export function relinkRuntimeBins(runtimeDirectory, sourceDirectories) {
  const runtime = fs.realpathSync(runtimeDirectory);
  const sources = [sourceDirectories]
    .flat()
    .filter((directory) => fs.existsSync(directory))
    .map((directory) => fs.realpathSync(directory));
  let repaired = 0;
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(filename);
      if (!entry.isSymbolicLink() || path.basename(directory) !== ".bin") continue;
      const target = fs.realpathSync(filename);
      if (target.startsWith(runtime + path.sep)) {
        if (path.isAbsolute(fs.readlinkSync(filename))) {
          fs.unlinkSync(filename);
          fs.symlinkSync(path.relative(directory, target), filename);
          repaired++;
        }
        continue;
      }
      const source = sources.find((candidate) => target.startsWith(candidate + path.sep));
      assert.ok(source, "Executable link points outside build dependencies");
      const bundled = path.join(runtime, path.relative(source, target));
      assert.ok(
        fs.realpathSync(bundled).startsWith(runtime + path.sep),
        "Bundled executable is missing"
      );
      assert.ok(fs.statSync(bundled).isFile(), "Bundled executable must be a file");
      assert.ok(
        fs.readFileSync(target).equals(fs.readFileSync(bundled)),
        "Bundled executable differs"
      );
      fs.unlinkSync(filename);
      fs.symlinkSync(path.relative(directory, bundled), filename);
      repaired++;
    }
  }
  visit(runtime);
  return repaired;
}
