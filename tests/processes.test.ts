import assert from "node:assert/strict";
import test from "node:test";
import { buildProcessTree, descendantsOf, formatMemory, observeWorkspace, parseProcessTable, processKey } from "../shared/processes";

// A trimmed copy of a real `ps -eo pid=,ppid=,rss=,args=` from a Paseo host:
// the daemon (2), a Claude agent in data-glue running @digitalocean/mcp, a
// Codex agent whose own cwd is $HOME but whose server runs in data-glue, and a
// Claude agent in another project running the same server.
const TABLE = `
      2       1  55268 Paseo Daemon
    100       2 282456 /home/demo/.local/bin/claude --output-format stream-json --mcp-config {"mcpServers":{"x":{"headers":{"Authorization":"Bearer sk-secret"}}}}
    101     100 141608 npm exec @digitalocean/mcp
    102     101   1960 sh -c mcp
    103     102  50444 node /home/demo/.npm/_npx/abc/node_modules/.bin/mcp
    104     103  16652 /home/demo/.npm/_npx/abc/node_modules/@digitalocean/mcp/dist/mcp-digitalocean
    200       2 105284 /home/demo/.local/bin/codex app-server --enable goals
    201     200  91164 npm exec @digitalocean/mcp
    202     201  32168 /home/demo/.codex/bin/codex-code-mode
    300       2 251452 /home/demo/.local/bin/claude --output-format stream-json
    301     300 100528 npm exec @digitalocean/mcp
    400       2 156988 /usr/bin/node /opt/paseo/plugins/plugin-process.js
    500       1   9052 /usr/local/bin/code tunnel
`;

const CWD: Record<number, string> = {
  100: "/home/demo/projects/data-glue",
  101: "/home/demo/projects/data-glue",
  200: "/home/demo",
  201: "/home/demo/projects/data-glue",
  300: "/home/demo/projects/other",
  301: "/home/demo/projects/other",
  400: "/home/demo",
};

test("parses the ps table shape", () => {
  const records = parseProcessTable(TABLE);
  assert.equal(records.length, 13);
  assert.deepEqual(records[0], { pid: 2, ppid: 1, rssKb: 55268, args: "Paseo Daemon" });
  assert.equal(records[1].args.startsWith("/home/demo/.local/bin/claude"), true);
});

test("descendants walk the whole subtree", () => {
  const tree = buildProcessTree(parseProcessTable(TABLE));
  assert.deepEqual(descendantsOf(tree, 100).sort(), [101, 102, 103, 104]);
  assert.deepEqual(descendantsOf(tree, 500), []);
});

test("process keys come from the package, never a secret or a bare launcher", () => {
  assert.equal(processKey({ command: "npx", args: ["-y", "@digitalocean/mcp"] }), "@digitalocean/mcp");
  assert.equal(processKey({ command: "node", args: ["server.js", "--port", "3"] }), "server.js");
  assert.equal(processKey({ command: "/usr/local/bin/my-mcp" }), "my-mcp");
  assert.equal(processKey({ command: "npx" }), null);
  assert.equal(processKey({ command: "npx", args: ["-y", "pkg", "--api-key", "sk-live-1234"] }), "pkg");
  assert.equal(processKey({ command: "npx", args: ["SECRET_TOKEN_VALUE"] }), null);
  assert.equal(processKey({ url: "https://x" } as { command?: string }), null);
});

test("attributes server processes to the workspace by agent cwd or server cwd", () => {
  const tree = buildProcessTree(parseProcessTable(TABLE));
  const observed = observeWorkspace({
    tree,
    roots: [100, 200, 300, 400],
    directory: "/home/demo/projects/data-glue",
    cwdOf: (pid) => CWD[pid] ?? null,
    servers: [
      { name: "digitalocean", command: "npx", args: ["-y", "@digitalocean/mcp"] },
      { name: "jam", url: "https://mcp.jam.dev" } as { name: string; command?: string },
      { name: "mystery", command: "npx" },
    ],
  });
  // Claude agent (100) and Codex agent (200) belong here; 300 is another project; 400 is a plugin host.
  assert.equal(observed.agents, 2);
  assert.equal(observed.servers.length, 1);
  assert.equal(observed.servers[0].name, "digitalocean");
  // 101+102+103+104 under claude, 201+202 under codex.
  assert.equal(observed.servers[0].processes, 6);
  assert.equal(observed.servers[0].rssKb, 141608 + 1960 + 50444 + 16652 + 91164 + 32168);
  assert.equal(observed.processes, 6);
  assert.deepEqual(observed.unmatchable, ["mystery"]);
});

test("nothing is attributed to a workspace with no agents", () => {
  const tree = buildProcessTree(parseProcessTable(TABLE));
  const observed = observeWorkspace({
    tree,
    roots: [100, 200, 300],
    directory: "/home/demo/projects/nothing-here",
    cwdOf: (pid) => CWD[pid] ?? null,
    servers: [{ name: "digitalocean", command: "npx", args: ["-y", "@digitalocean/mcp"] }],
  });
  assert.equal(observed.agents, 0);
  assert.equal(observed.processes, 0);
});

test("formats memory for a caption", () => {
  assert.equal(formatMemory(850), "850 KB");
  assert.equal(formatMemory(141608), "138 MB");
  assert.equal(formatMemory(2 * 1024 * 1024), "2.0 GB");
});
