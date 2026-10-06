import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { Destination } from "../shared/contracts";
import { scrubSecret } from "../shared/setup";
import { forgetFile } from "./files";
import { backupFile, destReadOne, destWrite, jsonMcpRead } from "./handlers";
import { cliPath } from "./mcpjson";

/**
 * Bring your own sign-in app (0.16.0), the one write the plugin can't make
 * with its own writers. Claude Code keeps a pre-registered client's secret in
 * its secure store (the macOS Keychain, or `.credentials.json` elsewhere),
 * under `mcpOAuthClientConfig["<name>|<hash of type, url, headers>"]`, and only
 * its own `claude mcp add` / `add-json --client-secret` puts it there (checked
 * against Claude Code 2.1.280; "Use pre-configured OAuth credentials",
 * code.claude.com/docs/en/mcp). So for this server the plugin:
 *
 *   1. refuses when the name is already there (presence by name);
 *   2. backs up the config file, as every other write does;
 *   3. runs `claude mcp add-json --scope user --client-secret -- <name> <json>`
 *      for that account (its CLAUDE_CONFIG_DIR), with the secret in the child's
 *      environment as MCP_CLIENT_SECRET, which Claude Code reads before it
 *      would prompt. Never in its arguments (other users can read those), never
 *      logged, never returned. `--` so a name starting with `-` is a name;
 *   4. reads the file back and compares it with the plan;
 *   5. when Claude Code failed, hung (killed after TERM_MS, then KILL_MS) or
 *      couldn't store the secret, takes out the entry it had already written
 *      (it writes the config before the secret), so nothing is left that
 *      can't sign in and a retry isn't refused as a clash.
 */

const HOME = homedir();
const TIMEOUTS = { termMs: 30_000, killMs: 5_000 };
let timeouts = { ...TIMEOUTS };

/** For tests: shorter waits before TERM and KILL; null restores them. */
export function setByoTimeouts(next: { termMs: number; killMs: number } | null): void {
  timeouts = next ? { ...next } : { ...TIMEOUTS };
}

export type ByoWrite = { ok: boolean; message: string };

/** Sorted keys, so two definitions compare by content. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
}

export function sameDefinition(read: unknown, planned: Record<string, unknown>): boolean {
  return JSON.stringify(canonical(read)) === JSON.stringify(canonical(planned));
}

/**
 * The CLAUDE_CONFIG_DIR a Claude destination stands for: "" for the primary
 * `~/.claude.json`, else the file's own folder. Not the login path's rule:
 * an account at `~/.claude` keeps its config in `~/.claude/.claude.json`,
 * which Claude Code only writes with CLAUDE_CONFIG_DIR set to that folder.
 */
export function claudeAccountDir(dest: Pick<Destination, "configPath">): string {
  return resolve(dest.configPath) === resolve(join(HOME, ".claude.json")) ? "" : dirname(resolve(dest.configPath));
}

function claudeEnvironment(dest: Pick<Destination, "configPath">): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const dir = claudeAccountDir(dest);
  if (dir) env.CLAUDE_CONFIG_DIR = dir;
  else delete env.CLAUDE_CONFIG_DIR;
  return env;
}

type RunResult = { code: number | null; output: string; error: string; killed: boolean };

function run(binary: string, args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((done) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], env, cwd: HOME });
    let output = "";
    let killed = false;
    const onChunk = (chunk: Buffer) => {
      output = `${output}${chunk.toString()}`.slice(-4000);
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    let hard: NodeJS.Timeout | undefined;
    const soft = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
      hard = setTimeout(() => child.kill("SIGKILL"), timeouts.killMs);
    }, timeouts.termMs);
    const stop = () => {
      clearTimeout(soft);
      if (hard) clearTimeout(hard);
    };
    child.once("error", (error) => {
      stop();
      done({ code: null, output, error: error.message, killed });
    });
    child.once("exit", (code) => {
      stop();
      done({ code, output, error: "", killed });
    });
  });
}

/**
 * Take out what Claude Code wrote under `name` when the add didn't finish,
 * through the plugin's own writer (backup first). Only an entry that is
 * exactly the one planned: anything else under that name is left and said.
 */
function undoPartialAdd(dest: Destination, name: string, definition: Record<string, unknown>): string {
  forgetFile(dest.configPath);
  const read = jsonMcpRead(dest.configPath)[name];
  if (!read) return "Nothing was written.";
  if (!sameDefinition(read, definition)) return `A connector called '${name}' is in the file now but isn't the one planned; open it to check.`;
  try {
    destWrite(dest, name, null);
    return "The entry it had already written was taken out again (backup saved), so you can add it again.";
  } catch (error) {
    return `The entry it wrote could not be taken out (${error instanceof Error ? error.message : String(error)}); remove '${name}' and add it again.`;
  }
}

/**
 * One add at a time per config file. Two installs of one name overlapping
 * (two open panels) would otherwise both pass the name check, and the second
 * run's clean-up would take out the first run's entry. Queued, the second
 * sees the name and is refused before Claude Code runs.
 */
const queues = new Map<string, Promise<void>>();

function queued<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

/** Add one server with its client to one Claude account. The secret is only ever in the child's environment. */
export function addWithClaudeClient(dest: Destination, name: string, definition: Record<string, unknown>, clientSecret: string, options: { secretless?: boolean } = {}): Promise<ByoWrite> {
  return queued(resolve(dest.configPath), () => addNow(dest, name, definition, clientSecret, options.secretless === true));
}

/**
 * `secretless` (0.18.3, Meta Ads): the vendor's sign-in takes no client
 * secret, so Claude Code is run without `--client-secret` and nothing goes in
 * its environment or secure store; the client ID is in the entry, as always.
 */
async function addNow(dest: Destination, name: string, definition: Record<string, unknown>, clientSecret: string, secretless: boolean): Promise<ByoWrite> {
  const secret = clientSecret.trim();
  if (!secret && !secretless) return { ok: false, message: "No client secret was given, so nothing was written." };
  const plain = (text: string) => scrubSecret(text, secret).replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").trim().split("\n").slice(-2).join(" ").slice(0, 300);
  const binary = cliPath("claude");
  if (!binary) return { ok: false, message: "Claude Code isn't on this computer's PATH, and only Claude Code can store the client secret. Install it, or add the connector in a terminal with claude mcp add-json." };
  if (basename(dest.configPath) !== ".claude.json") return { ok: false, message: `${dest.configPath} isn't a Claude Code config file.` };
  if (destReadOne(dest, name)) return { ok: false, message: `'${name}' is already there; nothing was replaced.` };
  try {
    backupFile(dest.configPath);
  } catch (error) {
    return { ok: false, message: `could not back up ${dest.configPath} first, so nothing was written (${error instanceof Error ? error.message : String(error)})` };
  }
  const args = ["mcp", "add-json", "--scope", "user", ...(secretless ? [] : ["--client-secret"]), "--", name, JSON.stringify(definition)];
  const env = claudeEnvironment(dest);
  delete env.MCP_CLIENT_SECRET;
  const result = await run(binary, args, secretless ? env : { ...env, MCP_CLIENT_SECRET: secret });
  forgetFile(dest.configPath);
  const failure = result.error
    ? `claude could not be started: ${plain(result.error)}.`
    : result.killed
      ? `Claude Code didn't finish within ${Math.round(timeouts.termMs / 1000)} seconds and was stopped.`
      : result.code !== 0
        ? `${(plain(result.output) || `claude mcp add-json stopped with code ${result.code}`).replace(/\.$/, "")}.`
        : /client secret could not be stored/i.test(result.output)
          ? "Claude Code could not store the client secret (its secure store was locked or missing)."
          : "";
  // Claude Code refused a name another writer added meanwhile: this run wrote nothing, so nothing is taken out.
  if (failure && !result.killed && /already exists/i.test(result.output)) return { ok: false, message: `'${name}' is already there; nothing was replaced.` };
  if (failure) return { ok: false, message: `${failure} ${undoPartialAdd(dest, name, definition)}` };
  const read = jsonMcpRead(dest.configPath)[name];
  if (!read) return { ok: false, message: "Claude Code said it added the connector, but it isn't in the file; open the connector to check." };
  if (!sameDefinition(read, definition)) return { ok: false, message: "written, but it did not read back as planned; open the connector to check it" };
  return { ok: true, message: "" };
}
