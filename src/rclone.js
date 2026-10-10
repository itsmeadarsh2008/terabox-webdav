import { spawn } from "node:child_process";

// rclone CLI storage backend (TeraBox remote). Reads stay on terabox-gateway
// (fast, cached); every MUTATION goes through here:
//   list (lsjson) · mkdir · deletefile/purge · moveto/copyto · rcat upload.
// Binary/config/remote/timeout are injectable so tests can point RCLONE_BIN
// at a stub script instead of the network.
export function createRclone({ bin, config, remote, timeoutMs = 60000 } = {}) {
  const base = {
    RCLONE_CONFIG: config,
    RCLONE_FAST_LIST: "true",
  };

  function run(args, { input = null } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, { env: { ...process.env, ...base } });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(Object.assign(new Error("rclone timeout"), { code: "ETIMEOUT" }));
      }, timeoutMs);
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve({ stdout, stderr });
        else {
          const err = new Error(`rclone ${args[0]} failed (${code}): ${stderr.slice(0, 200)}`);
          err.code = /not found|doesn't exist|not_found|ENOENT/i.test(stderr) ? "ENOTFOUND" : "EFAILED";
          reject(err);
        }
      });
      if (input) {
        if (typeof input.pipe === "function") input.pipe(child.stdin);
        else {
          child.stdin.end(input);
        }
      } else if (args[0] === "rcat") {
        // caller streams via returned handle (see upload()).
      } else {
        child.stdin.end();
      }
    });
  }

  const at = (p) => `${remote}${p.startsWith("/") ? p : "/" + p}`;

  return {
    // Directory listing: [{ name, size, isDir }]
    async list(dirPath) {
      const { stdout } = await run(["lsjson", "--files-only", "-R", at(dirPath)]);
      const items = JSON.parse(stdout || "[]");
      return (Array.isArray(items) ? items : []).map((e) => ({
        name: String(e.Name ?? e.name ?? "").split("/").pop(),
        path: e.Path ?? e.path ?? "",
        size: typeof e.Size === "number" ? e.Size : undefined,
        isDir: Boolean(e.IsDir ?? e.isDir),
        modTime: e.ModTime ?? e.modTime ?? undefined,
      }));
    },
    // Single entry stat; throws ENOTFOUND when missing.
    async stat(entryPath) {
      const parent = entryPath.split("/").slice(0, -1).join("/") || "/";
      const base = entryPath.split("/").filter(Boolean).pop();
      const items = await this.list(parent);
      const hit = items.find((e) => e.name === base);
      if (!hit) {
        const err = new Error("not found");
        err.code = "ENOTFOUND";
        throw err;
      }
      return hit;
    },
    async mkdir(dirPath) {
      await run(["mkdir", at(dirPath)]);
    },
    async remove(entryPath, { recursive = false } = {}) {
      await run(recursive ? ["purge", at(entryPath)] : ["deletefile", at(entryPath)]);
    },
    async move(src, dest) {
      await run(["moveto", at(src), at(dest)]);
    },
    async copy(src, dest) {
      await run(["copyto", at(src), at(dest)]);
    },
    // Byte slice for Range support: rclone cat --offset/--count.
    // Returns { stream, done } like upload().
    catRange(remotePath, start, end) {
      const args = ["cat", at(remotePath)];
      if (start > 0 || end != null) {
        args.push("--offset", String(start));
        if (end != null) args.push("--count", String(end - start + 1));
      }
      let settle;
      const done = new Promise((resolve, reject) => { settle = { resolve, reject }; });
      const child = spawn(bin, args, { env: { ...process.env, ...base } });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        settle.reject(Object.assign(new Error("rclone cat timeout"), { code: "ETIMEOUT" }));
      }, timeoutMs);
      let stderr = "";
      child.stderr.on("data", (d) => { stderr += d; });
      child.on("error", (err) => {
        clearTimeout(timer);
        settle.reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) settle.resolve();
        else settle.reject(Object.assign(new Error(`cat failed (${code}): ${stderr.slice(0, 200)}`), { code: "EFAILED" }));
      });
      return { stream: child.stdout, done };
    },
    // Upload stream → remote path. Returns { stream, done }: pipe the request
    // body into stream; await done for completion (rejects on failure).
    upload(destPath) {
      let settle;
      const done = new Promise((resolve, reject) => { settle = { resolve, reject }; });
      const child = spawn(bin, ["rcat", at(destPath)], { env: { ...process.env, ...base } });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        settle.reject(Object.assign(new Error("rclone upload timeout"), { code: "ETIMEOUT" }));
      }, timeoutMs);
      let stderr = "";
      child.stderr.on("data", (d) => { stderr += d; });
      child.on("error", (err) => {
        clearTimeout(timer);
        settle.reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) settle.resolve(destPath);
        else settle.reject(Object.assign(new Error(`upload failed (${code}): ${stderr.slice(0, 200)}`), { code: "EFAILED" }));
      });
      return { stream: child.stdin, done };
    },
  };
}

export function rcloneConfig() {
  return {
    bin: process.env.RCLONE_BIN ?? "rclone",
    config: process.env.RCLONE_CONFIG ?? "",
    remote: process.env.RCLONE_REMOTE ?? "terabox:",
    timeoutMs: Number(process.env.RCLONE_TIMEOUT_MS ?? 60000),
  };
}
