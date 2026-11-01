import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { artifactManifest } from "../../scripts/ci/qualify-native-artifact.mjs";

const qualifier = fileURLToPath(
  new URL("../../scripts/ci/qualify-native-artifact.mjs", import.meta.url)
);

function createFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-qualification-"));
  const runtime = path.join(directory, "dist");
  fs.mkdirSync(runtime);
  fs.mkdirSync(path.join(directory, "node_modules"));
  fs.writeFileSync(path.join(directory, "package-lock.json"), "{}");
  return { directory, runtime };
}

test("standalone manifest verification rejects file and link drift", () => {
  const { directory, runtime } = createFixture();
  try {
    fs.writeFileSync(path.join(runtime, "server.js"), "runtime");
    const manifest = path.join(directory, "_artifacts/native-artifact/manifest.json");
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    fs.writeFileSync(manifest, JSON.stringify(artifactManifest(runtime)));
    const verify = () =>
      spawnSync(process.execPath, [qualifier, runtime, "--verify"], {
        cwd: directory,
        encoding: "utf8",
      });
    const verified = verify();
    assert.equal(verified.status, 0, verified.stderr);
    fs.writeFileSync(path.join(runtime, "server.js"), "changed");
    const changedFile = verify();
    assert.notEqual(changedFile.status, 0);
    assert.match(changedFile.stderr, /Runtime changed after qualification/);
    fs.writeFileSync(path.join(runtime, "server.js"), "runtime");
    fs.symlinkSync("server.js", path.join(runtime, "entry"));
    const changedLink = verify();
    assert.notEqual(changedLink.status, 0);
    assert.match(changedLink.stderr, /Runtime changed after qualification/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("native qualification drives actual smoke lifecycle and records binary exceptions", () => {
  const { directory, runtime } = createFixture();
  try {
    const tools = path.join(directory, "tools");
    fs.mkdirSync(tools);
    // These subprocess fixtures replace only host binary-inspection commands.
    const tool = (name: string, body: string) => {
      const filename = path.join(tools, name);
      fs.writeFileSync(filename, "#!" + process.execPath + "\n" + body);
      fs.chmodSync(filename, 0o755);
    };
    tool("ip", "process.exit(0);");
    tool(
      "ldd",
      'console.log(process.argv[2].includes("keytar") ? "libsecret-1.so.0 => not found" : "statically linked");'
    );
    tool(
      "objdump",
      'console.log(process.argv[3].includes("musl") ? "NEEDED libc.so" : "NEEDED libc.so.6");'
    );
    const binary = (relative: string, machine: number) => {
      const filename = path.join(runtime, relative);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      const header = Buffer.alloc(20);
      header.write("\x7fELF");
      header[5] = 1;
      header.writeUInt16LE(machine, 18);
      fs.writeFileSync(filename, header);
    };
    assert.ok(["arm64", "x64"].includes(process.arch));
    const machine = process.arch === "arm64" ? 183 : 62;
    binary("node_modules/keytar/build/Release/keytar.node", machine);
    binary("node_modules/better-sqlite3/prebuilds/linux-" + process.arch + ".node", machine);
    binary(
      "node_modules/onnxruntime-node/bin/napi-v6/linux/" +
        process.arch +
        "/onnxruntime_binding.node",
      machine
    );
    binary("node_modules/vendor/musl.node", machine);
    binary("node_modules/vendor/foreign.node", machine === 183 ? 62 : 183);
    fs.writeFileSync(path.join(runtime, "node_modules/vendor/windows.node"), "MZ");
    fs.writeFileSync(path.join(runtime, "BUILD_SHA"), "12345678");
    const wrapper = path.join(directory, "pm2-wrapper.cjs");
    fs.writeFileSync(
      wrapper,
      'const http=require("node:http");console.log("[DB] Driver: node:sqlite");http.createServer((q,s)=>{s.writeHead(200);s.end("ok")}).listen(Number(process.env.PORT),process.env.HOSTNAME);'
    );
    const preload = path.join(directory, "os-boundaries.cjs");
    // The smoke's namespace and PM2 installation are external OS boundaries;
    // redirect them only in this child, never in the test runner or host.
    fs.writeFileSync(
      preload,
      `const fs=require("node:fs"),cp=require("node:child_process"),{syncBuiltinESMExports}=require("node:module");
const exists=fs.existsSync,link=fs.readlinkSync,spawn=cp.spawn;
process.report.getReport=()=>({header:{glibcVersionRuntime:"99.99"}});
fs.existsSync=function(p){return p==="/opt/omniroute-ci-pm2/node_modules/pm2/lib/ProcessContainerFork.js"||exists(p)};
fs.readlinkSync=function(p,...a){if(p==="/proc/self/ns/net")return "private";if(p==="/proc/1/ns/net")return "host";return link(p,...a)};
cp.spawn=function(exe,args,options){return spawn(exe,args.map(a=>a==="/opt/omniroute-ci-pm2/node_modules/pm2/lib/ProcessContainerFork.js"?${JSON.stringify(wrapper)}:a),options)};
syncBuiltinESMExports();`
    );
    const source = "1234567890abcdef1234567890abcdef12345678";
    const execute = () =>
      spawnSync(
        process.execPath,
        [
          "--require",
          preload,
          qualifier,
          runtime,
          process.arch,
          process.versions.modules,
          process.versions.node,
        ],
        {
          cwd: directory,
          env: {
            ...process.env,
            PATH: tools + path.delimiter + process.env.PATH,
            GITHUB_SHA: source,
          },
          encoding: "utf8",
          timeout: 30_000,
        }
      );
    const child = execute();
    assert.equal(child.status, 0, child.stderr);
    const receipt = JSON.parse(
      fs.readFileSync(path.join(directory, "_artifacts/native-artifact/receipt.json"), "utf8")
    );
    assert.equal(receipt.source, source);
    assert.deepEqual(receipt.smoke, { driver: "node:sqlite", consecutiveHealthy: 6 });
    assert.equal(
      receipt.nativeLibraries.filter(
        (entry: { binaryClass: string }) => entry.binaryClass === "target-glibc"
      ).length,
      3
    );
    assert.ok(
      receipt.nativeLibraries.some(
        (entry: { exception?: string }) => entry.exception === "existing-optional-keytar-libsecret"
      )
    );
    assert.ok(
      receipt.nativeLibraries.some(
        (entry: { binaryClass: string }) => entry.binaryClass === "foreign-libc"
      )
    );
    const manifest = JSON.parse(
      fs.readFileSync(path.join(directory, "_artifacts/native-artifact/manifest.json"), "utf8")
    );
    assert.deepEqual(manifest, artifactManifest(runtime));
    assert.deepEqual(fs.readdirSync(path.join(directory, "_artifacts")), ["native-artifact"]);
    fs.writeFileSync(path.join(runtime, "BUILD_SHA"), "deadbeef");
    const wrongSource = execute();
    assert.notEqual(wrongSource.status, 0);
    assert.match(wrongSource.stderr, /source\.startsWith\(marker\)/);
    fs.writeFileSync(path.join(runtime, "BUILD_SHA"), "12345678");
    fs.writeFileSync(
      wrapper,
      'const http=require("node:http");http.createServer((q,s)=>{s.writeHead(503);s.end("unready")}).listen(Number(process.env.PORT),process.env.HOSTNAME);setTimeout(()=>process.exit(0),1200);'
    );
    const failedSmoke = execute();
    assert.notEqual(failedSmoke.status, 0);
    assert.match(failedSmoke.stderr, /PM2 artifact health smoke failed/);
    assert.deepEqual(fs.readdirSync(path.join(directory, "_artifacts")), ["native-artifact"]);
    fs.writeFileSync(
      wrapper,
      'const http=require("node:http");console.log("[DB] Driver: node:sqlite");http.createServer((q,s)=>{s.writeHead(200);s.end("ok")}).listen(Number(process.env.PORT),process.env.HOSTNAME);'
    );
    const rejectionScenarios = [
      {
        name: "missing nonoptional shared library",
        change: () => tool("ldd", 'console.log("libunexpected.so => not found");'),
        message: /Missing native library/,
      },
      {
        name: "incompatible GNU runtime symbol",
        change: () => {
          tool("ldd", 'console.log("statically linked");');
          tool(
            "objdump",
            'console.log(process.argv[2] === "-p" ? "NEEDED libc.so.6" : "GLIBC_100.0");'
          );
        },
        message: /Unsupported GLIBC/,
      },
      {
        name: "incompatible C++ runtime symbol",
        change: () => {
          tool("ldd", 'console.log("libstdc++.so.6 => /fixture/libstdc++.so.6");');
          tool(
            "objdump",
            'console.log(process.argv[2] === "-p" ? "NEEDED libc.so.6" : process.argv[3].includes("onnxruntime") ? "GLIBCXX_999.0" : "GLIBCXX_1.0");'
          );
        },
        message: /Unsupported GLIBCXX/,
      },
    ];
    for (const scenario of rejectionScenarios) {
      scenario.change();
      const rejected = execute();
      assert.notEqual(rejected.status, 0, scenario.name);
      assert.match(rejected.stderr, scenario.message, scenario.name);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
