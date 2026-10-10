#!/usr/bin/env node
// Test stub for the rclone CLI: implements just enough of
// lsjson/mkdir/deletefile/purge/moveto/copyto/cat/rcat over a fixture dir.
// RCLONE_BIN in tests points here. Remote paths look like `stub:/a/b`.
import fs from "node:fs";
import path from "node:path";

const root = process.env.STUB_ROOT ?? "/tmp/stub-remote";

function toLocal(remotePath) {
  const p = remotePath.includes(":") ? remotePath.slice(remotePath.indexOf(":") + 1) : remotePath;
  const norm = path.posix.normalize("/" + p).replace(/^\/+/, "");
  const full = path.join(root, norm);
  if (!full.startsWith(root)) {
    console.error("escape refused");
    process.exit(1);
  }
  return full;
}

function entry(full, rel) {
  const st = fs.statSync(full);
  return {
    Name: path.basename(full),
    Path: rel,
    Size: st.isDirectory() ? 0 : st.size,
    IsDir: st.isDirectory(),
    ModTime: st.mtime.toISOString(),
  };
}

const [cmd, ...args] = process.argv.slice(2);
try {
  if (cmd === "lsjson") {
    const target = args.filter((a) => !a.startsWith("-")).pop();
    const full = toLocal(target);
    const st = fs.statSync(full);
    if (!st.isDirectory()) {
      console.log(JSON.stringify([entry(full, target.split(":").slice(1).join(":"))]));
    } else {
      const rec = args.includes("-R");
      const out = [];
      const walk = (dir, prefix) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const fp = path.join(dir, e.name);
          const rel = prefix ? `${prefix}/${e.name}` : e.name;
          out.push({ ...entry(fp, rel), Path: rel });
          if (e.isDirectory() && rec) walk(fp, rel);
        }
      };
      walk(full, "");
      // Non-recursive callers in server use parent+filter; -R always fine here.
      console.log(JSON.stringify(out));
    }
  } else if (cmd === "mkdir") {
    fs.mkdirSync(toLocal(args[args.length - 1]), { recursive: true });
  } else if (cmd === "deletefile") {
    fs.unlinkSync(toLocal(args[args.length - 1]));
  } else if (cmd === "purge") {
    fs.rmSync(toLocal(args[args.length - 1]), { recursive: true, force: true });
  } else if (cmd === "moveto" || cmd === "copyto" || cmd === "mov" || cmd === "copy") {
    const [src, dest] = args.slice(-2).map(toLocal);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (cmd.startsWith("move")) fs.renameSync(src, dest);
    else {
      const st = fs.statSync(src);
      if (st.isDirectory()) fs.cpSync(src, dest, { recursive: true });
      else fs.copyFileSync(src, dest);
    }
  } else if (cmd === "cat") {
    let offset = 0;
    let count = null;
    let target = null;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--offset") offset = Number(args[++i]);
      else if (args[i] === "--count") count = Number(args[++i]);
      else if (!args[i].startsWith("-")) target = args[i];
    }
    const buf = fs.readFileSync(toLocal(target));
    process.stdout.write(count == null ? buf.subarray(offset) : buf.subarray(offset, offset + count));
  } else if (cmd === "rcat") {
    const target = args.filter((a) => !a.startsWith("-")).pop();
    const full = toLocal(target);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const ws = fs.createWriteStream(full);
    await new Promise((resolve, reject) => {
      process.stdin.pipe(ws);
      ws.on("finish", resolve);
      ws.on("error", reject);
      process.stdin.on("error", reject);
    });
  } else {
    console.error(`unknown stub command ${cmd}`);
    process.exit(1);
  }
} catch (err) {
  console.error(err.code === "ENOENT" ? "not found" : err.message);
  process.exit(1);
}
