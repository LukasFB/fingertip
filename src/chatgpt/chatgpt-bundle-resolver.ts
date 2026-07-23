import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";

interface BoundedCommandOptions {
  readonly timeoutMs: number;
  readonly outputCapBytes: number;
}

export type RunBoundedCommand = (
  command: string,
  args: readonly string[],
  options: BoundedCommandOptions,
) => Promise<string>;

export interface ResolvedChatGptBundle {
  readonly bundlePath: string;
  readonly binaryPath: string;
  readonly appVersion: string;
  readonly appBuild: string;
  readonly codexVersion: string;
  readonly fingerprint: string;
}

interface BundleResolverOptions {
  readonly run: RunBoundedCommand;
  readonly homeDirectory: string;
}

const runBoundedCommand: RunBoundedCommand = (command, args, options) => new Promise((resolve, reject) => {
  let settled = false;
  let length = 0;
  const chunks: Buffer[] = [];
  const child = spawn(command, [...args], { shell: false, stdio: ["ignore", "pipe", "ignore"] });
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    finish(new Error("command timeout"));
  }, options.timeoutMs);
  const finish = (error?: Error): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error !== undefined) reject(error);
    else resolve(Buffer.concat(chunks).toString("utf8"));
  };
  child.stdout.on("data", (chunk: Buffer) => {
    length += chunk.length;
    if (length > options.outputCapBytes) {
      child.kill("SIGKILL");
      finish(new Error("command output exceeds limit"));
    } else {
      chunks.push(chunk);
    }
  });
  child.once("error", () => finish(new Error("command spawn failed")));
  child.once("exit", (code) => finish(code === 0 ? undefined : new Error("command failed")));
});

function boundedValue(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || Buffer.byteLength(normalized, "utf8") > 128) {
    throw new Error("invalid bundle version value");
  }
  return normalized;
}

function parseBundlePath(output: string): string | null {
  const quoted = /LSBundlePath["']?\s*[=:]\s*["']([^"']+)["']/u.exec(output)?.[1];
  if (quoted !== undefined) return quoted;
  const plain = /LSBundlePath["']?\s*[=:]\s*([^\r\n]+)/u.exec(output)?.[1]?.trim();
  return plain === undefined || plain.length === 0 ? null : plain;
}

export class ChatGptBundleResolver {
  readonly #options: BundleResolverOptions;

  constructor(options?: Partial<BundleResolverOptions>) {
    this.#options = {
      run: options?.run ?? runBoundedCommand,
      homeDirectory: options?.homeDirectory ?? process.env.HOME ?? "",
    };
  }

  async resolve(): Promise<ResolvedChatGptBundle> {
    const ordered: string[] = [];
    try {
      const asn = boundedValue(await this.#options.run(
        "/usr/bin/lsappinfo",
        ["find", "bundleID=com.openai.codex"],
        { timeoutMs: 5_000, outputCapBytes: 4_096 },
      ));
      const info = await this.#options.run(
        "/usr/bin/lsappinfo",
        ["info", "-only", "bundlepath", "-app", asn],
        { timeoutMs: 5_000, outputCapBytes: 4_096 },
      );
      const runningPath = parseBundlePath(info);
      if (runningPath !== null) ordered.push(runningPath);
    } catch {
      // A missing running instance is an expected discovery result.
    }
    ordered.push("/Applications/ChatGPT.app");
    if (this.#options.homeDirectory.length > 0) {
      ordered.push(path.join(this.#options.homeDirectory, "Applications", "ChatGPT.app"));
    }
    try {
      const spotlight = await this.#options.run(
        "/usr/bin/mdfind",
        ["kMDItemCFBundleIdentifier == 'com.openai.codex'"],
        { timeoutMs: 5_000, outputCapBytes: 1024 * 1024 },
      );
      ordered.push(...spotlight.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean).sort());
    } catch {
      // Fixed candidates are still useful when Spotlight is unavailable.
    }

    const seen = new Set<string>();
    for (const candidate of ordered) {
      if (Buffer.byteLength(candidate, "utf8") > 4_096) continue;
      let canonical: string;
      try {
        canonical = await realpath(candidate);
      } catch {
        continue;
      }
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      const resolved = await this.#validate(canonical).catch(() => null);
      if (resolved !== null) return resolved;
    }
    throw new Error("ChatGPT bundle not found");
  }

  async #validate(bundlePath: string): Promise<ResolvedChatGptBundle> {
    const infoPath = path.join(bundlePath, "Contents", "Info.plist");
    const readPlistValue = async (key: string): Promise<string> => boundedValue(await this.#options.run(
      "/usr/bin/plutil",
      ["-extract", key, "raw", "-o", "-", infoPath],
      { timeoutMs: 5_000, outputCapBytes: 4_096 },
    ));
    if (await readPlistValue("CFBundleIdentifier") !== "com.openai.codex") {
      throw new Error("unexpected bundle identifier");
    }
    const appVersion = await readPlistValue("CFBundleShortVersionString");
    const appBuild = await readPlistValue("CFBundleVersion");
    const binaryPath = path.join(bundlePath, "Contents", "Resources", "codex");
    const binaryStat = await stat(binaryPath);
    if (!binaryStat.isFile() || binaryStat.uid !== process.getuid?.()) throw new Error("invalid Codex binary owner");
    await access(binaryPath, constants.X_OK);
    const codexVersion = boundedValue(await this.#options.run(
      binaryPath,
      ["--version"],
      { timeoutMs: 5_000, outputCapBytes: 4_096 },
    ));
    return Object.freeze({
      bundlePath,
      binaryPath,
      appVersion,
      appBuild,
      codexVersion,
      fingerprint: `${bundlePath}\u0000${appVersion}\u0000${appBuild}\u0000${codexVersion}`,
    });
  }
}
