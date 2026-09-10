/** MCP definitions, health and OAuth grants, kept together by server. */
import type { PluginSurfaceProps, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useEffect, useMemo, useState } from "react";
import { Linking, Text, View } from "react-native";
import { z } from "zod";
import {
  mcpAdd,
  mcpApply,
  mcpAuth,
  mcpDefAll,
  mcpEditOne,
  mcpMatrix,
  mcpRemove,
  mcpRename,
  mcpSync,
  mcpWorkspace,
  type Destination,
  type McpAuthAccount,
  type McpDefRow,
  type ProjectMcpServer,
  type McpServerRow,
} from "../shared/contracts";
import {
  ParsedServerSchema,
  mcpExport,
  mcpExportFile,
  mcpImportApply,
  mcpImportParse,
  mcpLogin,
  mcpLoginComplete,
  mcpLoginCancel,
  mcpLoginStatus,
  mcpLogout,
  mcpRawGet,
  mcpRawPut,
  type JsonIssue,
  type LoginSession,
  type RawDefRow,
} from "../shared/mcpjson";
import { HealthSummary, ServerHealthTag, healthStatus, healthWord, useHealth } from "./health";
import {
  Button,
  Card,
  Choice,
  CodeBlock,
  ConfirmButton,
  Coverage,
  Disclosure,
  EmptyState,
  ErrorText,
  Facts,
  Field,
  Grid,
  Header,
  Intro,
  Loading,
  Notice,
  Row,
  Screen,
  Section,
  Segmented,
  StatCard,
  StatusPill,
  Step,
  Tag,
  Toolbar,
  TokensProvider,
  copyToClipboard,
  useTokens,
  useUi,
  type ChoiceItem,
  type Status,
} from "./ui";

type ParsedServer = z.infer<typeof ParsedServerSchema>;
type PutResult = z.output<typeof mcpRawPut.output>;
type Mode = "add" | "import";
type Kind = "stdio" | "http";

// -------------------------------------------------------------------- helpers

function sessionStatus(state: LoginSession["state"]): Status {
  if (state === "done") return "ok";
  if (state === "failed") return "error";
  if (state === "waiting") return "attention";
  return "busy";
}

/** A log or a stack trace is useful; twenty lines of it under the toolbar is not. */
function clampLines(text: string, limit: number): string {
  const lines = text.split("\n");
  if (lines.length <= limit) return text.trim();
  return `${lines.slice(0, limit).join("\n")}\n… ${lines.length - limit} more lines`;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * "line 4, col 12 — message", the offending line, and a caret under the column.
 * A coordinate the reader has to count to is a coordinate they will get wrong.
 */
function formatIssue(source: string, issue: JsonIssue): string {
  if (issue.line < 1) return issue.message;
  const head = `line ${issue.line}, col ${issue.column} — ${issue.message}`;
  const line = source.split("\n")[issue.line - 1];
  if (line === undefined) return head;
  return `${head}\n${line}\n${" ".repeat(Math.max(0, issue.column - 1))}^`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function loginCommand(account: McpAuthAccount, server: string, directory = ""): string {
  const variable = account.provider === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
  const login = account.isPrimary
    ? `${account.provider} mcp login ${shellQuote(server)}`
    : `${variable}=${shellQuote(account.dir)} ${account.provider} mcp login ${shellQuote(server)}`;
  return directory ? `cd ${shellQuote(directory)} && ${login}` : login;
}

function oauthState(account: McpAuthAccount, server: string) {
  const needs = account.needsAuth.includes(server);
  const auth = account.authStatus[server] ?? (needs ? "not-connected" : "unknown");
  return { needs, auth, known: needs || auth === "connected" || auth === "not-connected" };
}

// ----------------------------------------------------------------- fragments

function Issues({ source, issues }: { source: string; issues: JsonIssue[] }) {
  const t = useTokens();
  if (issues.length === 0) return null;
  return (
    <View style={{ gap: t.space.sm }}>
      {issues.map((issue, index) => (
        <CodeBlock key={`${issue.code}-${index}`} tone="error">
          {formatIssue(source, issue)}
        </CodeBlock>
      ))}
    </View>
  );
}

function Lines({ items }: { items: string[] }) {
  const t = useTokens();
  return (
    <View style={{ gap: t.space.xs }}>
      {items.map((item, index) => (
        <Text key={`${item}-${index}`} style={t.text.caption}>
          {item}
        </Text>
      ))}
    </View>
  );
}

/** A destination is picked by pressing its row; the word says which state it is in. */
function Targets({
  title,
  destinations,
  selected,
  onToggle,
  onAll,
  onNone,
}: {
  title: string;
  destinations: Destination[];
  selected: string[];
  onToggle: (id: string) => void;
  onAll: () => void;
  onNone: () => void;
}) {
  const t = useTokens();
  return (
    <Section
      title={`${title} — ${selected.length} of ${destinations.length}`}
      trailing={
        <View style={{ flexDirection: "row", gap: t.space.sm }}>
          <Button label="All" variant="ghost" onPress={onAll} />
          <Button label="None" variant="ghost" onPress={onNone} />
        </View>
      }
    >
      <Card padded={false}>
        {destinations.length === 0 ? (
          <EmptyState title="Nowhere to write" body="No CLI config was found on this machine to write a server into." />
        ) : null}
        {destinations.map((dest, index) => {
          const on = selected.includes(dest.id);
          return (
            <Row
              key={dest.id}
              first={index === 0}
              selected={on}
              onPress={() => onToggle(dest.id)}
              title={dest.label}
              subtitle={dest.configPath}
              trailing={on ? <Tag label="included" tone="ok" /> : <Tag label="skipped" />}
            />
          );
        })}
      </Card>
    </Section>
  );
}

function useTargetSet(destinations: Destination[]) {
  // null means "every destination", so a freshly loaded destination is included
  // rather than silently dropped from a selection made before it appeared.
  const [chosen, setChosen] = useState<string[] | null>(null);
  const ids = chosen ?? destinations.map((dest) => dest.id);
  return {
    ids,
    toggle: (id: string) =>
      setChosen((previous) => {
        const next = new Set(previous ?? destinations.map((dest) => dest.id));
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return [...next];
      }),
    all: () => setChosen(null),
    none: () => setChosen([]),
    reset: () => setChosen(null),
  };
}

// ------------------------------------------------------------------- editors

function FieldsEditor({
  row,
  saving,
  onDirty,
  onSave,
}: {
  row: McpDefRow;
  saving: boolean;
  onDirty: (dirty: boolean) => void;
  onSave: (input: { kind: Kind; url: string; command: string; kvLines: string }) => void;
}) {
  const t = useTokens();
  const [kind, setKind] = useState<Kind>(row.kind);
  const [url, setUrl] = useState(row.url);
  const [command, setCommand] = useState(row.command);
  const [kvLines, setKvLines] = useState(row.kvLines);
  const dirty = kind !== row.kind || url !== row.url || command !== row.command || kvLines !== row.kvLines;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  return (
    <View style={{ gap: t.space.md }}>
      <Segmented
        value={kind}
        onChange={setKind}
        options={[
          { value: "http", label: "HTTP" },
          { value: "stdio", label: "Command" },
        ]}
      />
      {kind === "http" ? (
        <Field label="URL" value={url} onChangeText={setUrl} placeholder="https://example.com/mcp" />
      ) : (
        <Field label="Command" value={command} onChangeText={setCommand} placeholder="npx -y some-mcp-server" />
      )}
      <Field
        label={kind === "http" ? "Headers" : "Environment"}
        value={kvLines}
        onChangeText={setKvLines}
        multiline
        mono
        placeholder={kind === "http" ? "Authorization=Bearer …" : "API_KEY=…"}
        hint="One KEY=value per line. A masked ••• value keeps this destination's stored secret."
      />
      <View style={{ flexDirection: "row", gap: t.space.sm }}>
        <Button
          label="Save this destination"
          variant="primary"
          loading={saving}
          disabled={!dirty}
          onPress={() => onSave({ kind, url, command, kvLines })}
        />
      </View>
    </View>
  );
}

/**
 * The JSON tab. Save stays shut until the buffer both differs and has come back
 * clean from the daemon, and any keystroke throws the verdict away — a pass from
 * two edits ago is not permission to write.
 */
function JsonEditor({
  seed,
  nativePreview,
  onDirty,
  onPut,
}: {
  seed: string;
  nativePreview: string;
  onDirty: (dirty: boolean) => void;
  onPut: (json: string, dryRun: boolean) => Promise<PutResult | null>;
}) {
  const t = useTokens();
  const [buffer, setBuffer] = useState(seed);
  const [baseline, setBaseline] = useState(seed);
  const [verdict, setVerdict] = useState<PutResult | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [busy, setBusy] = useState<"validate" | "preview" | "save" | null>(null);
  const dirty = buffer !== baseline;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);

  const run = async (job: "validate" | "preview" | "save") => {
    setBusy(job);
    const result = await onPut(buffer, job !== "save");
    setBusy(null);
    if (!result) return;
    setVerdict(result);
    setShowPreview(job === "preview");
    if (job === "save" && result.ok) setBaseline(buffer);
  };

  return (
    <View style={{ gap: t.space.md }}>
      <Field
        label="Definition"
        value={buffer}
        onChangeText={(next) => {
          setBuffer(next);
          setVerdict(null);
          setShowPreview(false);
        }}
        multiline
        mono
        minHeight={t.text.mono.lineHeight * 14}
        hint="Claude's shape, whatever the destination stores. Preview shows the translation."
      />
      <View style={{ flexDirection: "row", gap: t.space.sm }}>
        <Button label="Validate" loading={busy === "validate"} onPress={() => void run("validate")} />
        <Button label="Preview" loading={busy === "preview"} onPress={() => void run("preview")} />
        <Button
          label="Save"
          variant="primary"
          loading={busy === "save"}
          disabled={!dirty || !verdict?.ok}
          onPress={() => void run("save")}
        />
        <Button
          label="Revert"
          variant="ghost"
          disabled={!dirty}
          onPress={() => {
            setBuffer(baseline);
            setVerdict(null);
            setShowPreview(false);
          }}
        />
      </View>
      {verdict && !verdict.ok && verdict.issues.length === 0 ? <ErrorText>{verdict.message}</ErrorText> : null}
      {verdict ? <Issues source={buffer} issues={verdict.issues} /> : null}
      {verdict?.ok ? (
        <Text style={t.text.caption}>
          {dirty ? "Checked clean — Save is now open." : verdict.message || "Nothing left to write."}
        </Text>
      ) : null}
      {verdict && verdict.warnings.length > 0 ? <Lines items={verdict.warnings} /> : null}
      {showPreview && verdict ? (
        <>
          <Section title="What this destination will hold">
            <CodeBlock>{verdict.preview || nativePreview}</CodeBlock>
          </Section>
          {verdict.dropped.length > 0 ? (
            <Section title="Dropped — no equivalent in this format">
              <Lines items={verdict.dropped} />
            </Section>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

function DestinationEditor({
  tab,
  onTab,
  defRow,
  rawRow,
  saving,
  otherCount,
  onSaveFields,
  onPut,
  onCopyEverywhere,
  onClose,
}: {
  tab: "fields" | "json";
  onTab: (tab: "fields" | "json") => void;
  defRow?: McpDefRow;
  rawRow?: RawDefRow;
  saving: boolean;
  otherCount: number;
  onSaveFields: (input: { kind: Kind; url: string; command: string; kvLines: string }) => void;
  onPut: (json: string, dryRun: boolean) => Promise<PutResult | null>;
  onCopyEverywhere: () => void;
  onClose: () => void;
}) {
  const t = useTokens();
  // Copying this definition over the others is only meaningful once it is the
  // definition on disk, so an unsaved buffer withdraws the offer.
  const [dirty, setDirty] = useState(false);
  return (
    <View style={{ gap: t.space.md }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: t.space.sm }}>
        <Segmented
          value={tab}
          onChange={onTab}
          options={[
            { value: "fields", label: "Fields" },
            { value: "json", label: "JSON" },
          ]}
        />
        <Button label="Close" variant="ghost" onPress={onClose} />
      </View>
      {tab === "fields" ? (
        !defRow ? (
          <Loading label="Reading this destination…" />
        ) : defRow.found ? (
          <FieldsEditor
            key={`${defRow.destId}-fields`}
            row={defRow}
            saving={saving}
            onDirty={setDirty}
            onSave={onSaveFields}
          />
        ) : (
          <ErrorText>This destination has no readable definition for that server.</ErrorText>
        )
      ) : !rawRow ? (
        <Loading label="Reading this destination…" />
      ) : rawRow.found ? (
        <JsonEditor
          key={`${rawRow.destId}-json`}
          seed={rawRow.json}
          nativePreview={rawRow.nativePreview}
          onDirty={setDirty}
          onPut={onPut}
        />
      ) : (
        <ErrorText>This destination has no readable definition for that server.</ErrorText>
      )}
      {otherCount > 0 ? (
        <View style={{ gap: t.space.xs }}>
          {dirty ? (
            <Text style={t.text.caption}>Save this destination before copying it over the others.</Text>
          ) : (
            <ConfirmButton
              label="Use for all destinations"
              confirmLabel={`Overwrite ${otherCount} destinations`}
              onConfirm={onCopyEverywhere}
            />
          )}
        </View>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------- auth

function AuthRows({
  server,
  accounts,
  destinations,
  presentIn,
  sessions,
  oauthCapable,
  daemonIsLocal,
  daemonHostname,
  pendingAccount,
  forceDefined = false,
  workspaceId = "",
  workspaceDirectory = "",
  onAuthorise,
  onCancel,
  onSignOut,
  onComplete,
  onCopied,
  bare = false,
  onlyAccount,
}: {
  server: string;
  accounts: McpAuthAccount[];
  destinations: Destination[];
  presentIn: string[];
  sessions: LoginSession[];
  oauthCapable: boolean;
  daemonIsLocal: boolean;
  daemonHostname: string;
  pendingAccount: string | null;
  forceDefined?: boolean;
  workspaceId?: string;
  workspaceDirectory?: string;
  onAuthorise: (account: McpAuthAccount) => void;
  onCancel: (key: string) => void;
  onSignOut: (account: McpAuthAccount) => void;
  onComplete: (key: string, redirectUrl: string) => void;
  onCopied: (ok: boolean) => void;
  bare?: boolean;
  onlyAccount?: { provider: string; email: string };
}) {
  const t = useTokens();
  const [redirects, setRedirects] = useState<Record<string, string>>({});
  const rows = accounts
    .filter(
      (account) =>
        !onlyAccount || (account.provider === onlyAccount.provider && account.email === onlyAccount.email),
    )
    .map((account) => {
      const dest = destinations.find((entry) => entry.provider === account.provider && entry.account === account.email);
      const state = oauthState(account, server);
      const session = sessions.find(
        (entry) =>
          entry.server === server &&
          entry.account === account.email &&
          entry.provider === account.provider &&
          entry.workspaceId === workspaceId,
      );
      return {
        account,
        defined: forceDefined || (dest ? presentIn.includes(dest.id) : false),
        ...state,
        session,
      };
    })
    .filter((row) => (row.defined || row.needs) && (row.known || row.session));
  if (rows.length === 0 || !oauthCapable) return null;

  const content = rows.map(({ account, auth, session }, index) => {
          const live = session?.state === "starting" || session?.state === "waiting";
          const connected = session?.state === "done" || auth === "connected";
          const failed = session?.state === "failed";
          const unsupported = auth === "unsupported";
          const remote = !connected && !unsupported && !daemonIsLocal;
          const status: Status = connected
            ? "ok"
            : unsupported
              ? "neutral"
              : live
                ? "busy"
                : failed
                  ? "error"
                  : auth === "not-connected"
                    ? "attention"
                    : "neutral";
          const statusLabel = connected
            ? "connected"
            : unsupported
              ? "OAuth unsupported"
              : live
                ? "connecting"
                : failed
                  ? "connection failed"
                : auth === "not-connected"
                  ? "connect required"
                  : "not checked";
          return (
            <Row
              key={`${account.provider}-${account.dir}`}
              first={index === 0}
              title={bare ? "Account connection" : account.email}
              subtitle={
                bare
                  ? `${account.email} · ${account.isPrimary ? "primary" : "routed"} ${account.provider === "claude" ? "Claude" : "Codex"}`
                  : `${account.isPrimary ? "primary" : "routed"} ${account.provider === "claude" ? "Claude" : "Codex"} account`
              }
              trailing={
                connected ? (
                  <>
                    <Button label="Reconnect" onPress={() => onAuthorise(account)} />
                    <ConfirmButton label="Sign out" confirmLabel="Revoke this grant" onConfirm={() => onSignOut(account)} />
                  </>
                ) : !unsupported && daemonIsLocal ? (
                  <Button
                    label="Connect OAuth"
                    loading={pendingAccount === `${account.provider}|${account.email}`}
                    disabled={live}
                    onPress={() => onAuthorise(account)}
                  />
                ) : undefined
              }
              meta={<StatusPill status={status} label={statusLabel} />}
              expanded={
                remote || session || (!connected && !unsupported) ? (
                  <View style={{ gap: t.space.sm }}>
                    {remote ? (
                      <>
                        <Text style={t.text.caption}>
                          Sign-in runs on {daemonHostname || "the daemon machine"}. Approve in any browser, then paste
                          the return address below if it does not finish on its own.
                        </Text>
                        <CodeBlock>{loginCommand(account, server, workspaceDirectory)}</CodeBlock>
                      </>
                    ) : null}
                    {!remote && !session ? (
                      <Text style={t.text.caption}>
                        Connect starts this server's own browser sign-in. Approve it in any browser, then paste the return address below if it does not finish on its own.
                      </Text>
                    ) : null}
                    {session ? (
                      <>
                        <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
                          <StatusPill status={sessionStatus(session.state)} label={session.state} />
                          <Text style={[t.text.caption, { flex: 1, minWidth: 0 }]} numberOfLines={2}>
                            {session.message}
                          </Text>
                        </View>
                        {session.url ? <CodeBlock>{session.url}</CodeBlock> : null}
                        {session.callbackUrl ? (
                          <View style={{ gap: t.space.xs }}>
                            <Text style={t.text.caption}>Callback returns to</Text>
                            <CodeBlock>{session.callbackUrl}</CodeBlock>
                          </View>
                        ) : null}
                        <View style={{ flexDirection: "row", gap: t.space.sm }}>
                          {session.url ? (
                            <>
                              <Button label="Open sign-in" onPress={() => void Linking.openURL(session.url)} />
                              <Button label="Copy link" onPress={() => onCopied(copyToClipboard(session.url))} />
                            </>
                          ) : null}
                          {live ? <Button label="Cancel" variant="ghost" onPress={() => onCancel(session.key)} /> : null}
                        </View>
                        {live && session.expectsRedirect && session.url ? (
                          <View style={{ gap: t.space.sm }}>
                            <Field
                              label="Callback return URL"
                              value={redirects[session.key] ?? ""}
                              onChangeText={(value) => setRedirects((previous) => ({ ...previous, [session.key]: value }))}
                              placeholder={session.callbackUrl || "Paste the full URL after sign-in"}
                              hint="Approve in your browser. If it lands on a localhost page that won't load, copy that page's full address from the address bar and paste it here."
                            />
                            <Button
                              label="Finish connection"
                              variant="primary"
                              disabled={!redirects[session.key]?.trim()}
                              onPress={() => onComplete(session.key, redirects[session.key]!.trim())}
                            />
                          </View>
                        ) : null}
                      </>
                    ) : null}
                  </View>
                ) : undefined
              }
            />
          );
        });
  if (bare) return <View style={{ gap: t.space.xs }}>{content}</View>;
  return (
    <Section title="Account connections">
      <Card padded={false}>{content}</Card>
    </Section>
  );
}

// -------------------------------------------------------------------- surface

type SectionId = "overview" | "servers" | "accounts" | "projects" | "transfer" | "guide";
type Filter = "all" | "gaps" | "issues";

const SECTIONS: ChoiceItem<SectionId>[] = [
  { id: "overview", label: "Overview", icon: "LayoutDashboard", description: "Your next step" },
  { id: "servers", label: "Servers", icon: "Server", description: "Definitions across editors" },
  { id: "accounts", label: "Accounts", icon: "KeyRound", description: "Sign-in and OAuth grants" },
  { id: "projects", label: "Projects", icon: "FolderCode", description: "Per-project .mcp.json" },
  { id: "transfer", label: "Import & Export", icon: "ArrowLeftRight", description: "Paste JSON, back up" },
  { id: "guide", label: "Guide & Setup", icon: "BookOpen", description: "How this works" },
];

const GUIDE_STEPS: { title: string; detail: string; label: string; section: SectionId }[] = [
  { title: "Add or import servers", detail: "Type a URL or command, or paste the JSON block straight out of a README. Fences, comments and the mcpServers wrapper are handled.", label: "Open Import & Export", section: "transfer" },
  { title: "Apply to every editor", detail: "A server defined in one editor can be copied to the others. Codex and Grok store TOML; the translation happens for you and anything dropped is reported.", label: "Review servers", section: "servers" },
  { title: "Sign in per account", detail: "HTTP servers that use OAuth need a grant for each account. Connect opens the server's own sign-in on the daemon host.", label: "Open accounts", section: "accounts" },
  { title: "Project servers", detail: "A workspace's .mcp.json is read-only here. Open MCP connections from that workspace to connect its accounts.", label: "See projects", section: "projects" },
];

function providerName(provider: string): string {
  const known: Record<string, string> = { claude: "Claude", codex: "Codex", kimi: "Kimi", grok: "Grok" };
  return known[provider] ?? (provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : "Editor");
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** Toasts carry one line. Anything longer is kept where the section can show it. */
function firstLine(text: string, fallback: string): string {
  const line = text.split("\n").map((entry) => entry.trim()).find(Boolean) ?? "";
  if (!line) return fallback;
  return text.trim().includes("\n") ? `${line} …` : line;
}

/** "Claude · Codex ×2 · Kimi" — which editors hold a server, provider by provider. */
function editorFacts(presentIn: string[], destinations: Destination[]): string[] {
  const counts = new Map<string, number>();
  for (const dest of destinations) {
    if (!presentIn.includes(dest.id)) continue;
    const name = providerName(dest.provider);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name));
}

export function McpSurface({ theme, layout, host }: PluginSurfaceProps) {
  const t = useUi(theme, layout.compact);
  return (
    <TokensProvider value={t}>
      <McpBody key={host.id} theme={theme} layout={layout} host={host} />
    </TokensProvider>
  );
}

function McpBody({ layout, host }: PluginSurfaceProps) {
  const t = useTokens();
  const toast = useToast();
  const queryClient = useQueryClient();

  const callMatrix = useRpc(mcpMatrix);
  const callAuth = useRpc(mcpAuth);
  const callAdd = useRpc(mcpAdd);
  const callApply = useRpc(mcpApply);
  const callRemove = useRpc(mcpRemove);
  const callRename = useRpc(mcpRename);
  const callExport = useRpc(mcpExport);
  const callExportFile = useRpc(mcpExportFile);
  const callSync = useRpc(mcpSync);
  const callDefAll = useRpc(mcpDefAll);
  const callEditOne = useRpc(mcpEditOne);
  const callRawGet = useRpc(mcpRawGet);
  const callRawPut = useRpc(mcpRawPut);
  const callImportParse = useRpc(mcpImportParse);
  const callImportApply = useRpc(mcpImportApply);
  const callLogin = useRpc(mcpLogin);
  const callLoginComplete = useRpc(mcpLoginComplete);
  const callLoginStatus = useRpc(mcpLoginStatus);
  const callLoginCancel = useRpc(mcpLoginCancel);
  const callLogout = useRpc(mcpLogout);

  const [section, setSection] = useState<SectionId>("overview");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [mode, setMode] = useState<Mode>("add");
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editTab, setEditTab] = useState<"fields" | "json">("fields");
  const [revealed, setRevealed] = useState(false);
  const [exportRevealed, setExportRevealed] = useState(false);
  const [renameTo, setRenameTo] = useState("");
  const [syncLog, setSyncLog] = useState("");

  const [addName, setAddName] = useState("");
  const [addKind, setAddKind] = useState<Kind>("http");
  const [addUrl, setAddUrl] = useState("");
  const [addCommand, setAddCommand] = useState("");
  const [addKv, setAddKv] = useState("");

  const [blob, setBlob] = useState("");
  const [debouncedBlob, setDebouncedBlob] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [overwrite, setOverwrite] = useState(false);
  const [allowPlaceholders, setAllowPlaceholders] = useState(false);
  const [importResult, setImportResult] = useState<{
    written: string[];
    skipped: string[];
    issues: JsonIssue[];
  } | null>(null);

  const matrixQuery = useQuery({ queryKey: ["paseo-mcp", "matrix"], queryFn: () => callMatrix({}), retry: 1 });
  const destinations = useMemo<Destination[]>(() => matrixQuery.data?.destinations ?? [], [matrixQuery.data]);
  const servers = useMemo<McpServerRow[]>(() => matrixQuery.data?.servers ?? [], [matrixQuery.data]);
  // The host probes on its own timer and caches the verdict; Refresh and
  // Check now force a fresh probe through `refetch`.
  const healthQuery = useHealth();
  const health = useMemo(
    () => healthQuery.data ? new Map(healthQuery.data.results.map((entry) => [entry.name, entry])) : null,
    [healthQuery.data],
  );

  const addTargets = useTargetSet(destinations);
  const importTargets = useTargetSet(destinations);

  const authQuery = useQuery({ queryKey: ["paseo-mcp", "auth"], queryFn: () => callAuth({}), retry: 1 });
  const accounts = useMemo<McpAuthAccount[]>(() => authQuery.data?.accounts ?? [], [authQuery.data]);
  const rawQuery = useQuery({
    queryKey: ["paseo-mcp", "raw", selected, revealed],
    queryFn: () => callRawGet({ name: selected as string, reveal: revealed }),
    enabled: Boolean(selected),
  });
  // The raw rows feed every destination line; the field rows are only read once
  // an editor is actually open.
  const defQuery = useQuery({
    queryKey: ["paseo-mcp", "def", selected, revealed],
    queryFn: () => callDefAll({ name: selected as string, reveal: revealed }),
    enabled: Boolean(selected) && editing !== null,
  });

  const [liveLogin, setLiveLogin] = useState(false);
  const loginQuery = useQuery({
    queryKey: ["paseo-mcp", "login-status"],
    queryFn: () => callLoginStatus({}),
    refetchInterval: liveLogin ? 2000 : false,
  });
  const sessions = useMemo<LoginSession[]>(() => loginQuery.data?.sessions ?? [], [loginQuery.data]);
  const daemonIsLocal = loginQuery.data?.daemonIsLocal ?? true;
  const daemonHostname = loginQuery.data?.hostname ?? host.label;
  const anyLive = sessions.some((entry) => entry.state === "starting" || entry.state === "waiting");
  useEffect(() => setLiveLogin(anyLive), [anyLive]);
  // A grant that just landed changes who still needs one.
  const settled = sessions.filter((entry) => entry.state === "done").map((entry) => entry.key).join("|");
  const refetchAuth = authQuery.refetch;
  useEffect(() => {
    if (!settled) return;
    void refetchAuth();
  }, [settled, refetchAuth]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedBlob(blob), 400);
    return () => clearTimeout(timer);
  }, [blob]);
  const parseQuery = useQuery({
    queryKey: ["paseo-mcp", "import-parse", debouncedBlob],
    queryFn: () => callImportParse({ blob: debouncedBlob }),
    enabled: section === "transfer" && mode === "import" && debouncedBlob.trim().length > 0,
  });
  const parsed = parseQuery.data;
  const parsedNames = (parsed?.servers ?? []).map((entry) => entry.name).join("|");
  useEffect(() => {
    setPicked(parsedNames ? parsedNames.split("|") : []);
    setImportResult(null);
  }, [parsedNames]);

  // Targeted refreshes: a definition change moves the matrix, health and who
  // still needs a grant; a login only moves the session list.
  const refreshDefinitions = () => {
    void matrixQuery.refetch();
    void healthQuery.refetch();
    void authQuery.refetch();
    void queryClient.invalidateQueries({ queryKey: ["paseo-mcp", "raw"] });
    void queryClient.invalidateQueries({ queryKey: ["paseo-mcp", "def"] });
  };
  const refreshLogins = () => void loginQuery.refetch();
  const refreshAll = () => {
    refreshDefinitions();
    refreshLogins();
  };
  const fail = (error: unknown) => toast.error(firstLine(errorText(error), "Something went wrong. Please retry."));
  const report = (result: { ok: boolean; message: string }) => {
    if (result.ok) {
      toast.show(firstLine(result.message, "Done."), { variant: "success" });
      refreshDefinitions();
    } else {
      toast.error(firstLine(result.message, "Refused."));
    }
  };
  const notify = (result: { ok: boolean; message: string }) => {
    if (result.ok) toast.show(firstLine(result.message, "Done."), { variant: "success" });
    else toast.error(firstLine(result.message, "Refused."));
  };

  const selectServer = (name: string | null) => {
    setSection("servers");
    setSelected(name);
    setEditing(null);
    setRevealed(false);
    setRenameTo("");
  };
  const go = (next: SectionId, options: { server?: string | null; filter?: Filter; mode?: Mode } = {}) => {
    setSection(next);
    if (options.server !== undefined) {
      setSelected(options.server);
      setEditing(null);
      setRevealed(false);
      setRenameTo("");
    }
    if (options.filter) setFilter(options.filter);
    if (options.mode) setMode(options.mode);
  };
  const closeEditor = () => {
    setEditing(null);
    setRevealed(false);
  };

  const addMutation = useMutation({
    mutationFn: () =>
      callAdd({
        name: addName.trim(),
        kind: addKind,
        command: addCommand,
        url: addUrl,
        kvLines: addKv,
        targets: addTargets.ids,
      }),
    onError: fail,
    onSuccess: (result) => {
      report(result);
      if (!result.ok) return;
      const name = addName.trim();
      setAddName("");
      setAddUrl("");
      setAddCommand("");
      setAddKv("");
      addTargets.reset();
      selectServer(name);
    },
  });
  const applyMutation = useMutation({
    mutationFn: (input: { name: string; targets: string[]; sourceDestId?: string }) => callApply(input),
    onError: fail,
    onSuccess: report,
  });
  const removeMutation = useMutation({
    mutationFn: (input: { name: string; targets: string[] }) => callRemove(input),
    onError: fail,
    onSuccess: report,
  });
  // Export is two steps on purpose: the first produces the text (masked unless
  // secrets are revealed), the second writes it where the user can find it.
  const exportMutation = useMutation({
    mutationFn: async (input: { scope: "one" | "all"; name?: string; reveal: boolean }) => {
      const made = await callExport({ scope: input.scope, name: input.name, reveal: input.reveal });
      const saved = await callExportFile({ text: made.text, filename: made.filename });
      return { ...saved, containsSecrets: made.containsSecrets };
    },
    onSuccess: (result) => {
      if (!result.ok) return toast.error(firstLine(result.message, "Export failed."));
      toast.show(
        `${firstLine(result.message, "Export written.")}${result.containsSecrets ? " It holds live credentials." : " Credentials are redacted."}`,
        { variant: result.containsSecrets ? "warning" : "success" },
      );
    },
    onError: fail,
  });

  const renameMutation = useMutation({
    mutationFn: (input: { name: string; newName: string }) => callRename(input),
    onError: fail,
    onSuccess: (result, input) => {
      report(result);
      if (!result.ok) return;
      setRenameTo("");
      setSelected(input.newName);
      setEditing(null);
    },
  });
  const editOneMutation = useMutation({
    mutationFn: (input: { destId: string; kind: Kind; command: string; url: string; kvLines: string }) =>
      callEditOne({ name: selected as string, ...input }),
    onError: fail,
    onSuccess: report,
  });
  const syncMutation = useMutation({
    mutationFn: () => callSync({}),
    onError: fail,
    onSuccess: (result) => {
      setSyncLog(result.log.trim());
      report({ ok: result.ok, message: result.ok ? "Accounts synced. Definitions copied; grants untouched." : result.log });
    },
  });
  const importMutation = useMutation({
    mutationFn: () =>
      callImportApply({
        servers: (parsed?.servers ?? [])
          .filter((entry) => picked.includes(entry.name))
          .map((entry) => ({ name: entry.name, json: entry.json })),
        targets: importTargets.ids,
        overwrite,
        allowPlaceholders,
      }),
    onError: fail,
    onSuccess: (result) => {
      report(result);
      setImportResult({ written: result.written, skipped: result.skipped, issues: result.issues });
    },
  });
  const loginMutation = useMutation({
    mutationFn: (input: { provider: "claude" | "codex"; accountDir: string; account: string; server: string; workspaceId?: string }) =>
      callLogin(input),
    onError: fail,
    onSuccess: (result) => {
      notify(result);
      setLiveLogin(true);
      refreshLogins();
    },
  });
  const loginCancelMutation = useMutation({
    mutationFn: (key: string) => callLoginCancel({ key }),
    onError: fail,
    onSuccess: (result) => {
      notify(result);
      refreshLogins();
    },
  });
  const loginCompleteMutation = useMutation({
    mutationFn: (input: { key: string; redirectUrl: string }) => callLoginComplete(input),
    onError: fail,
    onSuccess: (result) => {
      notify(result);
      setLiveLogin(true);
      refreshLogins();
    },
  });
  const logoutMutation = useMutation({
    mutationFn: (input: { provider: "claude" | "codex"; accountDir: string; server: string; workspaceId?: string }) => callLogout(input),
    onError: fail,
    onSuccess: (result) => {
      notify(result);
      if (result.ok) {
        void authQuery.refetch();
        refreshLogins();
      }
    },
  });

  const putJson = async (destId: string, json: string, dryRun: boolean): Promise<PutResult | null> => {
    try {
      const result = await callRawPut({ name: selected as string, destId, json, dryRun });
      if (!dryRun) report(result);
      return result;
    } catch (error) {
      fail(error);
      return null;
    }
  };

  // ------------------------------------------------------------ derived state

  const query = search.trim().toLowerCase();
  const gapServers = servers.filter((server) => server.presentIn.length < destinations.length);
  const isIssue = (server: McpServerRow) => {
    const entry = health?.get(server.name);
    return Boolean(entry && entry.status !== "ok" && entry.status !== "unknown");
  };
  const issueServers = health ? servers.filter(isIssue) : [];
  const brokenServers = issueServers.filter((server) => {
    const status = health?.get(server.name)?.status;
    return status === "down" || status === "binary-missing";
  });
  const needsAuthNames = [...new Set(accounts.flatMap((account) => account.needsAuth))].filter((name) =>
    servers.some((server) => server.name === name),
  );
  const coveredEditors = destinations.filter((dest) => servers.every((server) => server.presentIn.includes(dest.id))).length;
  const inlineServers = servers.filter((server) => server.inlineCredentialsIn.length > 0);
  const projectGroups = [...(authQuery.data?.projectServers ?? []).reduce((groups, entry) => {
    const names = groups.get(entry.project) ?? [];
    names.push(entry.name);
    groups.set(entry.project, names);
    return groups;
  }, new Map<string, string[]>()).entries()];
  const shown = servers.filter((server) => {
    if (query && !server.name.toLowerCase().includes(query)) return false;
    if (filter === "gaps" && server.presentIn.length >= destinations.length) return false;
    if (filter === "issues" && !isIssue(server)) return false;
    return true;
  });

  const server = selected ? servers.find((entry) => entry.name === selected) : undefined;
  const serverHealth = server ? health?.get(server.name) : undefined;
  const missing = server ? destinations.filter((dest) => !server.presentIn.includes(dest.id)) : [];
  const rawRows: RawDefRow[] = rawQuery.data?.rows ?? [];
  const defRows: McpDefRow[] = defQuery.data?.rows ?? [];
  const accountForDestination = (dest: Destination) =>
    accounts.find((account) => account.provider === dest.provider && account.email === dest.account);
  const oauthDestinations = server
    ? destinations.filter((dest) => {
        if (!server.presentIn.includes(dest.id) || server.inlineCredentialsIn.includes(dest.id)) return false;
        const account = accountForDestination(dest);
        return Boolean(account && oauthState(account, server.name).known);
      })
    : [];
  const inlineCredentialCount = server?.inlineCredentialsIn.length ?? 0;
  const ready = Boolean(matrixQuery.data) && !matrixQuery.isError;

  const headerPill = matrixQuery.isError
    ? { status: "error" as Status, label: "Host unavailable" }
    : !matrixQuery.data
      ? { status: "neutral" as Status, label: "Connecting" }
      : servers.length === 0
        ? { status: "neutral" as Status, label: "No servers yet" }
        : brokenServers.length > 0
          ? { status: "error" as Status, label: `${plural(brokenServers.length, "server")} down` }
          : needsAuthNames.length > 0
            ? { status: "attention" as Status, label: `${needsAuthNames.length} need sign-in` }
            : gapServers.length > 0
              ? { status: "attention" as Status, label: plural(gapServers.length, "gap") }
              : { status: "ok" as Status, label: "All servers healthy" };

  // Decision table for the Overview card, first match wins.
  const nextStep: { title: string; detail: string; label: string; onPress: () => void } = matrixQuery.isError
    ? { title: "Reconnect to the host", detail: "The MCP plugin could not read the editor configs on this host. Retry once the daemon is reachable.", label: "Retry", onPress: refreshAll }
    : !matrixQuery.data
      ? { title: "Reading editor configs", detail: `Looking for Claude, Codex, Kimi and Grok configs on ${host.label}. This takes a moment.`, label: "Refresh", onPress: refreshAll }
    : servers.length === 0
      ? { title: "Add or import your first server", detail: "Paste the JSON block from a server's README, or type a URL or command. It is written to every editor you choose.", label: "Open Import & Export", onPress: () => go("transfer", { mode: "import" }) }
      : gapServers.length > 0
        ? { title: `Apply ${plural(gapServers.length, "server")} to the editors missing them`, detail: "A server defined in one editor is not yet in the others. Open a server and choose Add to missing to copy its definition across.", label: "Review gaps", onPress: () => go("servers", { server: null, filter: "gaps" }) }
        : needsAuthNames.length > 0
          ? { title: `Sign in to ${plural(needsAuthNames.length, "server")}`, detail: "OAuth grants are per account. Connect each one once; the browser sign-in runs on the daemon host.", label: "Open Accounts", onPress: () => go("accounts") }
          : brokenServers.length > 0
            ? { title: `Fix ${plural(brokenServers.length, "unhealthy server")}`, detail: "A server is down or its binary is missing. Open it to read the health note and edit its definition.", label: "Show issues", onPress: () => go("servers", { server: null, filter: "issues" }) }
            : { title: "Ready", detail: `${plural(servers.length, "server")} defined in every editor, with every account connected. Add another server or export a backup whenever you like.`, label: "Browse servers", onPress: () => go("servers", { server: null, filter: "all" }) };

  const attention: { key: string; title: string; detail: string; tone: Status; server: string }[] = [
    ...issueServers.map((entry) => {
      const item = health!.get(entry.name)!;
      return {
        key: `health-${entry.name}`,
        title: `${entry.name} — ${healthWord(item.status)}`,
        detail: item.note || (item.status === "auth-required" ? "Needs an OAuth grant." : "Health check did not pass."),
        tone: healthStatus(item.status),
        server: entry.name,
      };
    }),
    ...inlineServers.map((entry) => ({
      key: `inline-${entry.name}`,
      title: `${entry.name} — credentials in ${plural(entry.inlineCredentialsIn.length, "config file")}`,
      detail: "A token is stored in clear text in the editor config. Exports keep it masked unless you reveal secrets.",
      tone: "attention" as Status,
      server: entry.name,
    })),
  ];

  // ---------------------------------------------------------------- sections

  const overview = (
    <View style={{ gap: t.space.lg }}>
      <Intro
        title="Every MCP server, in every editor."
        description={`You are managing ${host.label}. Definitions, health and account sign-in below belong to the editors installed on this host.`}
      />
      <Grid min={160}>
        <StatCard label="Servers" value={ready ? servers.length : "—"} detail="Defined in at least one editor" />
        <StatCard label="Editors covered" value={ready ? `${coveredEditors} of ${destinations.length}` : "—"} detail="Hold every server" />
        <StatCard label="Need sign-in" value={ready ? needsAuthNames.length : "—"} detail="OAuth grants missing" />
        <StatCard label="Projects with MCP" value={authQuery.data ? projectGroups.length : "—"} detail="Workspaces with a .mcp.json" />
      </Grid>
      <Card>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: t.space.sm }}>
          <StatusPill status={headerPill.status} label={headerPill.label} />
          <Text style={t.text.caption}>MCP · selected host</Text>
        </View>
        <Text style={t.text.heading}>{nextStep.title}</Text>
        <Text style={t.text.body}>{nextStep.detail}</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm }}>
          <Button label={nextStep.label} variant="primary" onPress={nextStep.onPress} />
          <Button label="Read the walkthrough" onPress={() => go("guide")} />
          <Button label="Refresh" variant="ghost" loading={matrixQuery.isFetching || healthQuery.isFetching} onPress={refreshAll} />
        </View>
      </Card>
      {attention.length > 0 ? (
        <Card>
          <Step index={0} title="Needs attention" />
          <View style={{ gap: t.space.md }}>
            {attention.map((item) => (
              <View key={item.key} style={{ gap: t.space.xs, borderTopWidth: 1, borderTopColor: t.color.borderSubtle, paddingTop: t.space.md }}>
                <StatusPill status={item.tone} label={item.title} />
                <Text style={t.text.caption}>{item.detail}</Text>
                <View style={{ flexDirection: "row" }}>
                  <Button label={`Open ${item.server}`} onPress={() => selectServer(item.server)} />
                </View>
              </View>
            ))}
          </View>
        </Card>
      ) : null}
    </View>
  );

  const filters = (
    <View style={{ flexDirection: layout.compact ? "column" : "row", alignItems: layout.compact ? "stretch" : "center", gap: t.space.md }}>
      <View style={{ flex: layout.compact ? undefined : 1, minWidth: 0 }}>
        <Field value={search} onChangeText={setSearch} placeholder="Search servers" />
      </View>
      <Segmented
        value={filter}
        onChange={setFilter}
        options={[
          { value: "all", label: `All ${servers.length}` },
          { value: "gaps", label: `Gaps ${gapServers.length}` },
          { value: "issues", label: `Issues ${issueServers.length}`, disabled: !health },
        ]}
      />
    </View>
  );

  const list = (
    <Card padded={false}>
      {matrixQuery.isLoading ? <Loading label="Reading configs…" /> : null}
      {healthQuery.error ? (
        <View style={{ padding: t.space.md }}>
          <ErrorText>{`Automatic health check failed: ${errorText(healthQuery.error)}`}</ErrorText>
        </View>
      ) : null}
      {!matrixQuery.isLoading && shown.length === 0 ? (
        <EmptyState
          title="Nothing here"
          body={
            servers.length === 0
              ? "No MCP server is defined in any editor yet."
              : "No server matches this search and filter."
          }
          action={servers.length === 0 ? <Button label="Add or import a server" variant="primary" onPress={() => go("transfer")} /> : undefined}
        />
      ) : null}
      {[...shown]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((entry, index) => {
          const entryHealth = health?.get(entry.name);
          return (
            <Row
              key={entry.name}
              first={index === 0}
              selected={selected === entry.name}
              onPress={() => selectServer(entry.name)}
              title={
                <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm, minWidth: 0 }}>
                  <Text numberOfLines={1} style={[t.text.bodyStrong, { flexShrink: 1 }]}>{entry.name}</Text>
                  <Tag label={entry.transport} />
                </View>
              }
              meta={
                <View style={{ gap: t.space.xs, paddingTop: 2 }}>
                  <Coverage
                    present={entry.presentIn.length}
                    total={destinations.length}
                    label={`${entry.presentIn.length} of ${plural(destinations.length, "editor")}`}
                  />
                  <Facts items={editorFacts(entry.presentIn, destinations).map((value) => ({ value }))} />
                </View>
              }
              trailing={
                healthQuery.isFetching && !entryHealth ? (
                  <StatusPill status="busy" label="checking" />
                ) : entryHealth ? (
                  <StatusPill status={healthStatus(entryHealth.status)} label={healthWord(entryHealth.status)} />
                ) : undefined
              }
            />
          );
        })}
    </Card>
  );

  const back = (
    <View style={{ flexDirection: "row" }}>
      <Button label="← All servers" variant="ghost" onPress={() => selectServer(null)} />
    </View>
  );

  const destinationConnection = (entry: McpServerRow, dest: Destination) => (
    <AuthRows
      server={entry.name}
      accounts={accounts}
      destinations={[dest]}
      presentIn={[dest.id]}
      sessions={sessions}
      oauthCapable={entry.transport === "http" && !entry.inlineCredentialsIn.includes(dest.id)}
      daemonIsLocal={daemonIsLocal}
      daemonHostname={daemonHostname}
      pendingAccount={
        loginMutation.isPending && loginMutation.variables
          ? `${loginMutation.variables.provider}|${loginMutation.variables.account}`
          : null
      }
      onAuthorise={(account) =>
        loginMutation.mutate({
          provider: account.provider,
          accountDir: account.isPrimary ? "" : account.dir,
          account: account.email,
          server: entry.name,
        })
      }
      onCancel={(key) => loginCancelMutation.mutate(key)}
      onSignOut={(account) =>
        logoutMutation.mutate({
          provider: account.provider,
          accountDir: account.isPrimary ? "" : account.dir,
          server: entry.name,
        })
      }
      onComplete={(key, redirectUrl) => loginCompleteMutation.mutate({ key, redirectUrl })}
      onCopied={(ok) =>
        ok ? toast.show("Sign-in link copied.", { variant: "success" }) : toast.show("No clipboard here — the link above is selectable.", { variant: "warning" })
      }
      bare
      onlyAccount={{ provider: dest.provider, email: dest.account }}
    />
  );

  const serverPane = server ? (
    <View style={{ gap: t.space.lg }}>
      {back}
      <Card>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: t.space.sm }}>
          <Text style={[t.text.display, { flexShrink: 1 }]} numberOfLines={1}>
            {server.name}
          </Text>
          <Tag label={server.transport} />
          {inlineCredentialCount > 0 ? <Tag label={`credentials in ${inlineCredentialCount}`} /> : null}
          {oauthDestinations.length > 0 ? <Tag label={`OAuth on ${oauthDestinations.length}`} /> : null}
          {serverHealth ? (
            <StatusPill status={healthStatus(serverHealth.status)} label={healthWord(serverHealth.status)} />
          ) : null}
        </View>
        <Facts
          items={[
            { value: `${server.presentIn.length} of ${plural(destinations.length, "editor")}` },
            ...editorFacts(server.presentIn, destinations).map((value) => ({ value })),
            server.detail ? { value: server.detail } : null,
            healthQuery.data?.checkedAt ? { value: `checked ${new Date(healthQuery.data.checkedAt).toLocaleString()}` } : null,
          ]}
        />
        {serverHealth && serverHealth.status !== "ok" && serverHealth.note ? (
          <Text style={t.text.body}>{serverHealth.note}</Text>
        ) : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm }}>
          {missing.length > 0 ? (
            <Button
              label={`Add to ${missing.length} missing`}
              variant="primary"
              loading={applyMutation.isPending}
              onPress={() => applyMutation.mutate({ name: server.name, targets: missing.map((dest) => dest.id) })}
            />
          ) : null}
          <Button
            label={revealed ? "Hide secrets" : "Reveal secrets"}
            onPress={() => setRevealed((value) => !value)}
          />
          <Button
            label="Check now"
            loading={healthQuery.isFetching}
            onPress={() => { void healthQuery.refetch(); }}
          />
          {/* A panel cannot download, so an export is written next to the
              user's other files and the path is reported back. */}
          <Button
            label="Export"
            loading={exportMutation.isPending}
            onPress={() => exportMutation.mutate({ scope: "one", name: server.name, reveal: revealed })}
          />
        </View>
        <Disclosure title="Rename this server everywhere">
          <Field label="New name" value={renameTo} onChangeText={setRenameTo} placeholder={server.name} />
          <Button
            label="Rename everywhere"
            loading={renameMutation.isPending}
            disabled={!renameTo.trim() || renameTo.trim() === server.name}
            onPress={() => renameMutation.mutate({ name: server.name, newName: renameTo.trim() })}
          />
        </Disclosure>
      </Card>

      {server.transport === "http" && authQuery.error ? (
        <ErrorText>{errorText(authQuery.error)}</ErrorText>
      ) : null}

      {server.transport === "http" ? (
        <AuthRows
          server={server.name}
          accounts={accounts}
          destinations={destinations}
          presentIn={server.presentIn}
          sessions={sessions}
          oauthCapable={server.inlineCredentialsIn.length < server.presentIn.length}
          daemonIsLocal={daemonIsLocal}
          daemonHostname={daemonHostname}
          pendingAccount={
            loginMutation.isPending && loginMutation.variables
              ? `${loginMutation.variables.provider}|${loginMutation.variables.account}`
              : null
          }
          onAuthorise={(account) =>
            loginMutation.mutate({
              provider: account.provider,
              accountDir: account.isPrimary ? "" : account.dir,
              account: account.email,
              server: server.name,
            })
          }
          onCancel={(key) => loginCancelMutation.mutate(key)}
          onSignOut={(account) =>
            logoutMutation.mutate({
              provider: account.provider,
              accountDir: account.isPrimary ? "" : account.dir,
              server: server.name,
            })
          }
          onComplete={(key, redirectUrl) => loginCompleteMutation.mutate({ key, redirectUrl })}
          onCopied={(ok) =>
            ok
              ? toast.show("Sign-in link copied.", { variant: "success" })
              : toast.show("No clipboard here — the link above is selectable.", { variant: "warning" })
          }
        />
      ) : null}

      {revealed ? (
        <Notice tone="error">
          <View style={{ gap: t.space.sm }}>
            <Text style={t.text.body}>
              Secrets are in clear text on this pane. They re-mask when the editor closes or you leave this server.
            </Text>
            <View style={{ flexDirection: "row", gap: t.space.sm }}>
              <Button label="Hide secrets" onPress={() => setRevealed(false)} />
            </View>
          </View>
        </Notice>
      ) : null}

      <Section title="Editors">
        <Card padded={false}>
          {destinations.map((dest, index) => {
            const present = server.presentIn.includes(dest.id);
            const rawRow = rawRows.find((entry) => entry.destId === dest.id);
            const defRow = defRows.find((entry) => entry.destId === dest.id);
            const open = editing === dest.id && present;
            const authAccount = accountForDestination(dest);
            const destinationOauth = authAccount ? oauthState(authAccount, server.name) : null;
            return (
              <Row
                key={dest.id}
                first={index === 0}
                tone={present ? undefined : "attention"}
                title={dest.label}
                subtitle={
                  present
                    ? rawRow?.nativePreview ?? (rawQuery.isFetching ? "reading…" : undefined)
                    : "not defined here"
                }
                meta={
                  present && server.inlineCredentialsIn.includes(dest.id) ? (
                    <StatusPill status="ok" label="credentials in definition" />
                  ) : present && destinationOauth?.known ? (
                    <StatusPill
                      status={destinationOauth.auth === "connected" ? "ok" : "attention"}
                      label={destinationOauth.auth === "connected" ? "OAuth connected" : "OAuth needed"}
                    />
                  ) : undefined
                }
                trailing={
                  present ? (
                    open ? undefined : (
                      <Button
                        label="Manage"
                        onPress={() => {
                          setEditing(dest.id);
                          setEditTab("fields");
                        }}
                      />
                    )
                  ) : (
                    <Button
                      label="Add here"
                      loading={applyMutation.isPending && (applyMutation.variables?.targets ?? []).includes(dest.id)}
                      disabled={applyMutation.isPending}
                      onPress={() => applyMutation.mutate({ name: server.name, targets: [dest.id] })}
                    />
                  )
                }
                expanded={
                  open ? (
                    <View style={{ gap: t.space.md }}>
                      {destinationConnection(server, dest)}
                      <DestinationEditor
                        tab={editTab}
                        onTab={setEditTab}
                        defRow={defRow}
                        rawRow={rawRow}
                        saving={editOneMutation.isPending}
                        otherCount={destinations.length - 1}
                        onSaveFields={(input) => editOneMutation.mutate({ destId: dest.id, ...input })}
                        onPut={(json, dryRun) => putJson(dest.id, json, dryRun)}
                        onCopyEverywhere={() =>
                          applyMutation.mutate({
                            name: server.name,
                            targets: destinations.filter((other) => other.id !== dest.id).map((other) => other.id),
                            sourceDestId: dest.id,
                          })
                        }
                        onClose={closeEditor}
                      />
                      <ConfirmButton
                        label="Remove from this editor"
                        confirmLabel="Remove from here"
                        onConfirm={() => removeMutation.mutate({ name: server.name, targets: [dest.id] })}
                      />
                    </View>
                  ) : undefined
                }
              />
            );
          })}
        </Card>
      </Section>
    </View>
  ) : null;

  const serversSection = server ? serverPane : (
    <View style={{ gap: t.space.lg }}>
      <Toolbar
        title={`${plural(servers.length, "server")} across ${plural(destinations.length, "editor")}`}
        subtitle="Open a server to manage definitions, check reachability, and connect each account."
        actions={
          <>
            <Button label="Add server" variant="primary" onPress={() => go("transfer", { mode: "add" })} />
            <Button label="Import" onPress={() => go("transfer", { mode: "import" })} />
            <Button
              label="Refresh"
              variant="ghost"
              loading={matrixQuery.isFetching || healthQuery.isFetching}
              onPress={refreshAll}
            />
          </>
        }
        below={healthQuery.data?.checkedAt ? <Text style={t.text.caption}>Last checked {new Date(healthQuery.data.checkedAt).toLocaleString()}</Text> : undefined}
      />
      {filters}
      {list}
    </View>
  );

  const accountCard = (account: McpAuthAccount, index: number) => {
    const connectedNames = Object.entries(account.authStatus).filter(([, state]) => state === "connected").map(([name]) => name);
    const needs = account.needsAuth.filter((name) => servers.some((server) => server.name === name));
    const rowsFor = (name: string) => {
      const entry = servers.find((candidate) => candidate.name === name);
      return (
        <AuthRows
          key={`${account.provider}-${account.dir}-${name}`}
          server={name}
          accounts={accounts}
          destinations={destinations}
          presentIn={entry?.presentIn ?? []}
          sessions={sessions}
          oauthCapable
          daemonIsLocal={daemonIsLocal}
          daemonHostname={daemonHostname}
          pendingAccount={
            loginMutation.isPending && loginMutation.variables
              ? `${loginMutation.variables.provider}|${loginMutation.variables.account}`
              : null
          }
          forceDefined
          onAuthorise={(target) =>
            loginMutation.mutate({
              provider: target.provider,
              accountDir: target.isPrimary ? "" : target.dir,
              account: target.email,
              server: name,
            })
          }
          onCancel={(key) => loginCancelMutation.mutate(key)}
          onSignOut={(target) =>
            logoutMutation.mutate({
              provider: target.provider,
              accountDir: target.isPrimary ? "" : target.dir,
              server: name,
            })
          }
          onComplete={(key, redirectUrl) => loginCompleteMutation.mutate({ key, redirectUrl })}
          onCopied={(ok) =>
            ok ? toast.show("Sign-in link copied.", { variant: "success" }) : toast.show("No clipboard here — the link above is selectable.", { variant: "warning" })
          }
          bare
          onlyAccount={{ provider: account.provider, email: account.email }}
        />
      );
    };
    return (
      <Card key={`${account.provider}-${account.dir}-${index}`}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: t.space.sm }}>
          <Text style={[t.text.heading, { flexShrink: 1 }]} numberOfLines={1}>
            {`${providerName(account.provider)} · ${account.email || "no account"}`}
          </Text>
          <Tag label={account.isPrimary ? "primary" : "AgentLink slot"} />
          <View style={{ flexGrow: 1 }} />
          <StatusPill
            status={needs.length > 0 ? "attention" : connectedNames.length > 0 ? "ok" : "neutral"}
            label={needs.length > 0 ? `${needs.length} need sign-in` : `${connectedNames.length} connected`}
          />
        </View>
        <Facts
          items={[
            { value: plural(account.definedServers, "server") },
            { value: `${connectedNames.length} connected`, tone: connectedNames.length > 0 ? "ok" : undefined },
            { value: account.dir },
          ]}
        />
        {needs.length > 0 ? (
          <View style={{ gap: t.space.sm }}>
            {needs.map((name) => (
              <View key={name} style={{ gap: t.space.xs }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
                  <Text style={t.text.bodyStrong}>{name}</Text>
                  <Button label="Open server" variant="ghost" onPress={() => selectServer(name)} />
                </View>
                <Card level={2} padded={false}>{rowsFor(name)}</Card>
              </View>
            ))}
          </View>
        ) : (
          <Text style={t.text.caption}>Nothing waits on this account.</Text>
        )}
        {connectedNames.length > 0 ? (
          <Disclosure title={`Connected: ${connectedNames.join(", ")}`}>
            {connectedNames.map((name) => (
              <View key={name} style={{ gap: t.space.xs }}>
                <Text style={t.text.bodyStrong}>{name}</Text>
                <Card level={2} padded={false}>{rowsFor(name)}</Card>
              </View>
            ))}
          </Disclosure>
        ) : null}
      </Card>
    );
  };

  const accountsSection = (
    <View style={{ gap: t.space.lg }}>
      <Toolbar
        title="One grant per account, per server."
        subtitle="Definitions can be copied between editors. OAuth grants cannot, so each Claude or Codex account signs in to a server once."
        actions={<Button label="Refresh account status" loading={authQuery.isFetching || loginQuery.isFetching} onPress={() => { void authQuery.refetch(); refreshLogins(); }} />}
      />
      {authQuery.isLoading ? <Loading label="Reading accounts…" /> : null}
      {authQuery.error ? (
        <Notice tone="error">
          <View style={{ gap: t.space.sm }}>
            <Text style={t.text.body}>{errorText(authQuery.error)}</Text>
            <View style={{ flexDirection: "row" }}>
              <Button label="Retry" onPress={() => void authQuery.refetch()} />
            </View>
          </View>
        </Notice>
      ) : null}
      {loginQuery.error ? <ErrorText>{errorText(loginQuery.error)}</ErrorText> : null}
      {authQuery.data && accounts.length === 0 ? (
        <Card>
          <EmptyState title="No Claude or Codex account found" body="Sign in to Claude Code or Codex on this host once. Their config directories are discovered automatically." />
        </Card>
      ) : null}
      {accounts.map(accountCard)}
      <Card>
        <Step index={0} title="Sync accounts" />
        <Text style={t.text.body}>
          Copies server definitions, trusted projects and preferences from the primary account into every AgentLink slot. OAuth grants are never copied — each account still connects on its own.
        </Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm }}>
          {syncMutation.isPending ? (
            <Button label="Syncing…" loading onPress={() => undefined} />
          ) : (
            <ConfirmButton label="Sync accounts" confirmLabel="Overwrite slot definitions" variant="secondary" onConfirm={() => syncMutation.mutate()} />
          )}
        </View>
        {syncLog ? (
          <Disclosure title="Last sync log">
            <CodeBlock>{clampLines(syncLog, 30)}</CodeBlock>
          </Disclosure>
        ) : null}
      </Card>
    </View>
  );

  const projectsSection = (
    <View style={{ gap: t.space.lg }}>
      <Intro
        eyebrow="Projects"
        title="Servers a project brings with it."
        description="A .mcp.json at a project root defines servers for that workspace only. They are read here; sign-in happens from the workspace itself."
      />
      {authQuery.isLoading ? <Loading label="Reading projects…" /> : null}
      {authQuery.data && projectGroups.length === 0 ? (
        <Notice tone="neutral">No trusted project on this host has a .mcp.json yet. Add one at a project root and it appears here after the next refresh.</Notice>
      ) : null}
      {projectGroups.length > 0 ? (
        <Card padded={false}>
          {projectGroups.map(([project, names], index) => (
            <Row
              key={project}
              first={index === 0}
              title={project}
              subtitle={names.join(", ")}
              meta={<Facts items={[{ value: plural(names.length, "server") }]} />}
              trailing={<Tag label="workspace panel" />}
            />
          ))}
        </Card>
      ) : null}
      <Text style={t.text.caption}>Open MCP connections from a project workspace (command palette → "Open workspace MCP connections") to connect that project's accounts.</Text>
    </View>
  );

  const addPane = (
    <View style={{ gap: t.space.lg }}>
      <Card>
        <Text style={t.text.heading}>Add a server</Text>
        <Field label="Name" value={addName} onChangeText={setAddName} placeholder="my-server" />
        <Segmented
          value={addKind}
          onChange={setAddKind}
          options={[
            { value: "http", label: "HTTP" },
            { value: "stdio", label: "Command" },
          ]}
        />
        {addKind === "http" ? (
          <Field label="URL" value={addUrl} onChangeText={setAddUrl} placeholder="https://example.com/mcp" />
        ) : (
          <Field label="Command" value={addCommand} onChangeText={setAddCommand} placeholder="npx -y some-mcp-server" />
        )}
        <Field
          label={addKind === "http" ? "Headers" : "Environment"}
          value={addKv}
          onChangeText={setAddKv}
          multiline
          mono
          placeholder={addKind === "http" ? "Optional: Authorization=Bearer …" : "API_KEY=…"}
          hint={
            addKind === "http"
              ? "OAuth server? Leave this blank. After adding, open the server and choose Connect OAuth."
              : "One KEY=value per line."
          }
        />
      </Card>
      <Targets
        title="Write it to"
        destinations={destinations}
        selected={addTargets.ids}
        onToggle={addTargets.toggle}
        onAll={addTargets.all}
        onNone={addTargets.none}
      />
      <View style={{ flexDirection: "row", gap: t.space.sm }}>
        <Button
          label={`Add to ${plural(addTargets.ids.length, "editor")}`}
          variant="primary"
          loading={addMutation.isPending}
          disabled={
            !addName.trim() ||
            addTargets.ids.length === 0 ||
            (addKind === "http" ? !addUrl.trim() : !addCommand.trim())
          }
          onPress={() => addMutation.mutate()}
        />
      </View>
    </View>
  );

  const pickedServers: ParsedServer[] = (parsed?.servers ?? []).filter((entry) => picked.includes(entry.name));
  const stillPlaceholders = pickedServers.filter((entry) => entry.hasPlaceholders.length > 0);
  const importPane = (
    <View style={{ gap: t.space.lg }}>
      <Card>
        <Text style={t.text.heading}>Paste a server definition</Text>
        <Field
          value={blob}
          onChangeText={setBlob}
          multiline
          mono
          minHeight={t.text.mono.lineHeight * 10}
          placeholder={'{ "mcpServers": { "example": { "type": "http", "url": "https://…" } } }'}
          hint="Straight from a README — code fences, comments and a wrapper key are handled."
        />
      </Card>
      {parseQuery.isFetching ? <Loading label="Reading it…" /> : null}
      {parseQuery.error ? <ErrorText>{errorText(parseQuery.error)}</ErrorText> : null}
      {parsed && parsed.normalisations.length > 0 ? (
        <Section title="Cleaned up on the way in">
          <Lines items={parsed.normalisations} />
        </Section>
      ) : null}
      {parsed && parsed.issues.length > 0 ? <Issues source={debouncedBlob} issues={parsed.issues} /> : null}
      {parsed && parsed.servers.length > 0 ? (
        <>
          <Section title={`Found ${parsed.servers.length}`}>
            <Card padded={false}>
              {parsed.servers.map((entry, index) => {
                const on = picked.includes(entry.name);
                return (
                  <Row
                    key={entry.name}
                    first={index === 0}
                    selected={on}
                    onPress={() =>
                      setPicked((previous) =>
                        previous.includes(entry.name)
                          ? previous.filter((name) => name !== entry.name)
                          : [...previous, entry.name],
                      )
                    }
                    title={entry.name}
                    subtitle={entry.summary}
                    meta={
                      <Facts
                        items={[
                          { value: entry.kind },
                          entry.hasPlaceholders.length > 0
                            ? { value: `fill in ${entry.hasPlaceholders.join(", ")}`, tone: "attention" as Status }
                            : null,
                        ]}
                      />
                    }
                    trailing={on ? <Tag label="import" tone="ok" /> : <Tag label="skip" />}
                  />
                );
              })}
            </Card>
          </Section>
          <Targets
            title="Write it to"
            destinations={destinations}
            selected={importTargets.ids}
            onToggle={importTargets.toggle}
            onAll={importTargets.all}
            onNone={importTargets.none}
          />
          <Section title="If a server of that name is already there">
            <Segmented
              value={overwrite ? "overwrite" : "keep"}
              onChange={(value) => setOverwrite(value === "overwrite")}
              options={[
                { value: "keep", label: "Keep what is there" },
                { value: "overwrite", label: "Overwrite it" },
              ]}
            />
          </Section>
          {stillPlaceholders.length > 0 ? (
            <Notice tone="attention">
              <View style={{ gap: t.space.sm }}>
                <Text style={t.text.body}>
                  {`Placeholders still in ${stillPlaceholders.map((entry) => entry.name).join(", ")} — imported as they are, they fail at connect time.`}
                </Text>
                <Segmented
                  value={allowPlaceholders ? "allow" : "block"}
                  onChange={(value) => setAllowPlaceholders(value === "allow")}
                  options={[
                    { value: "block", label: "Fix them first" },
                    { value: "allow", label: "Import anyway" },
                  ]}
                />
              </View>
            </Notice>
          ) : null}
          <View style={{ flexDirection: "row", gap: t.space.sm }}>
            <Button
              label={`Import ${pickedServers.length} into ${plural(importTargets.ids.length, "editor")}`}
              variant="primary"
              loading={importMutation.isPending}
              disabled={
                pickedServers.length === 0 ||
                importTargets.ids.length === 0 ||
                (stillPlaceholders.length > 0 && !allowPlaceholders)
              }
              onPress={() => importMutation.mutate()}
            />
          </View>
        </>
      ) : null}
      {importResult ? (
        <>
          {importResult.written.length > 0 ? (
            <Section title="Written">
              <Lines items={importResult.written} />
            </Section>
          ) : null}
          {importResult.skipped.length > 0 ? (
            <Section title="Skipped">
              <Lines items={importResult.skipped} />
            </Section>
          ) : null}
          <Issues source={debouncedBlob} issues={importResult.issues} />
        </>
      ) : null}
    </View>
  );

  const transferSection = (
    <View style={{ gap: t.space.lg }}>
      <Intro
        eyebrow="Import & Export"
        title="Bring servers in, keep a copy out."
        description="Add one server by hand, paste a whole block of JSON, or write every definition to a backup file on this host."
      />
      <Segmented
        value={mode}
        onChange={setMode}
        options={[
          { value: "add", label: "Add server" },
          { value: "import", label: "Paste JSON" },
        ]}
      />
      {mode === "add" ? addPane : importPane}
      <Card>
        <Step index={0} title="Export everything" />
        <Text style={t.text.body}>
          Writes one JSON file with every server from every editor, next to your other files on {host.label}. Secrets are masked unless you reveal them, and a masked export cannot be re-imported as-is.
        </Text>
        <Segmented
          value={exportRevealed ? "reveal" : "mask"}
          onChange={(value) => setExportRevealed(value === "reveal")}
          options={[
            { value: "mask", label: "Mask secrets" },
            { value: "reveal", label: "Include secrets" },
          ]}
        />
        {exportRevealed ? (
          <Notice tone="error">The export file will hold live credentials in clear text. Delete it once it has been restored elsewhere.</Notice>
        ) : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm }}>
          <Button
            label="Export all servers"
            loading={exportMutation.isPending && exportMutation.variables?.scope === "all"}
            disabled={servers.length === 0}
            onPress={() => exportMutation.mutate({ scope: "all", reveal: exportRevealed })}
          />
        </View>
      </Card>
    </View>
  );

  const guideSection = (
    <View style={{ gap: t.space.lg }}>
      <Intro
        eyebrow="Guide & Setup"
        title="How MCP management works."
        description="Four steps take a server from a README to every editor and every account on this host."
      />
      <Grid min={260}>
        {GUIDE_STEPS.map((step, index) => (
          <Card key={step.title}>
            <Step index={index + 1} title={step.title} />
            <Text style={t.text.body}>{step.detail}</Text>
            <View style={{ flexDirection: "row" }}>
              <Button label={step.label} onPress={() => go(step.section, step.section === "servers" ? { server: null } : {})} />
            </View>
          </Card>
        ))}
      </Grid>
      <Card>
        <Step index={0} title="When something does not work" />
        <Text style={t.text.body}>
          Sign-in runs on the daemon host, not necessarily on the device you are holding. Connect opens the server's own authorization page in a browser there.
        </Text>
        <Text style={t.text.body}>
          If the browser lands on a localhost page that will not load, the callback reached the wrong machine. Copy that page's full address and paste it into the Callback return URL field under the account, then choose Finish connection.
        </Text>
        <Text style={t.text.body}>
          OAuth grants are per account and are never synced. Sync accounts copies definitions and preferences only; every account still connects to each server once.
        </Text>
        <Text style={t.text.body}>
          A server marked "no binary" needs its command installed on {host.label}. A server marked "down" answered with an error; open it to read the note and check its URL or headers.
        </Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm }}>
          <Button label="Open accounts" onPress={() => go("accounts")} />
          <Button label="Show issues" onPress={() => go("servers", { server: null, filter: "issues" })} />
        </View>
      </Card>
    </View>
  );

  const content = section === "overview"
    ? overview
    : section === "servers"
      ? serversSection
      : section === "accounts"
        ? accountsSection
        : section === "projects"
          ? projectsSection
          : section === "transfer"
            ? transferSection
            : guideSection;

  const pad = t.compact ? 16 : 20;
  return (
    <View style={{ flex: 1, backgroundColor: t.color.surface0 }}>
      <View style={{ padding: pad, paddingBottom: t.space.md, gap: t.space.md, width: "100%", maxWidth: t.maxWidth, alignSelf: "center" }}>
        <Header title="MCP" caption={`Selected host: ${host.label}`} pill={<StatusPill status={headerPill.status} label={headerPill.label} />} />
        <Choice<SectionId> items={SECTIONS} selected={section} onChange={(next) => go(next, next === "servers" ? { server: null } : {})} label="MCP sections" />
      </View>
      <Screen t={t} paddingTop={4}>
        {matrixQuery.isError ? (
          <Notice tone="error">
            <View style={{ gap: t.space.sm }}>
              <Text style={t.text.body}>{errorText(matrixQuery.error)}</Text>
              <View style={{ flexDirection: "row" }}>
                <Button label="Retry connection" onPress={refreshAll} />
              </View>
            </View>
          </Notice>
        ) : null}
        <View key={section}>{content}</View>
      </Screen>
    </View>
  );
}

/** Workspace-local .mcp.json inventory and OAuth, opened beside that workspace. */
export function McpWorkspacePanel(props: PluginWorkspacePanelProps) {
  const t = useUi(props.theme, props.layout.compact);
  return (
    <TokensProvider value={t}>
      <WorkspaceBody key={props.workspaceId} {...props} />
    </TokensProvider>
  );
}

/**
 * Shared by the workspace panel and the agent panel. `intro` renders under the
 * header; the agent panel uses it for its provider/injection line.
 */
export function WorkspaceBody({
  host,
  workspaceId,
  caption = "project MCP servers and sign-in",
  intro,
}: Pick<PluginWorkspacePanelProps, "host" | "workspaceId"> & { caption?: string; intro?: React.ReactNode }) {
  const t = useTokens();
  const toast = useToast();
  const workspace = useWorkspace(workspaceId, ({ name, directory }) => ({ name, directory }));
  const callWorkspace = useRpc(mcpWorkspace);
  const callLogin = useRpc(mcpLogin);
  const callLoginStatus = useRpc(mcpLoginStatus);
  const callLoginCancel = useRpc(mcpLoginCancel);
  const callLoginComplete = useRpc(mcpLoginComplete);
  const callLogout = useRpc(mcpLogout);
  const [selected, setSelected] = useState<string | null>(null);
  const [liveLogin, setLiveLogin] = useState(false);

  const workspaceQuery = useQuery({
    queryKey: ["paseo-mcp", "workspace", workspaceId],
    queryFn: () => callWorkspace({ workspaceId }),
    enabled: Boolean(workspace),
  });
  const loginQuery = useQuery({
    queryKey: ["paseo-mcp", "login-status"],
    queryFn: () => callLoginStatus({}),
    refetchInterval: liveLogin ? 2000 : false,
  });
  const sessions = useMemo<LoginSession[]>(() => loginQuery.data?.sessions ?? [], [loginQuery.data]);
  const anyLive = sessions.some((entry) => entry.state === "starting" || entry.state === "waiting");
  useEffect(() => setLiveLogin(anyLive), [anyLive]);
  const settled = sessions
    .filter((entry) => entry.workspaceId === workspaceId && entry.state === "done")
    .map((entry) => entry.key)
    .join("|");
  const refetchWorkspace = workspaceQuery.refetch;
  useEffect(() => {
    if (!settled) return;
    void refetchWorkspace();
  }, [settled, refetchWorkspace]);

  const fail = (error: unknown) => toast.error(firstLine(errorText(error), "Something went wrong. Please retry."));
  const notify = (result: { ok: boolean; message: string }) => {
    if (result.ok) toast.show(firstLine(result.message, "Done."), { variant: "success" });
    else toast.error(firstLine(result.message, "Refused."));
  };
  const refreshLogins = () => void loginQuery.refetch();
  const loginMutation = useMutation({
    mutationFn: (input: {
      provider: "claude" | "codex";
      accountDir: string;
      account: string;
      server: string;
      workspaceId: string;
    }) => callLogin(input),
    onError: fail,
    onSuccess: (result) => {
      notify(result);
      setLiveLogin(result.ok);
      refreshLogins();
    },
  });
  const cancelMutation = useMutation({
    mutationFn: (key: string) => callLoginCancel({ key }),
    onError: fail,
    onSuccess: (result) => {
      notify(result);
      refreshLogins();
    },
  });
  const completeMutation = useMutation({
    mutationFn: (input: { key: string; redirectUrl: string }) => callLoginComplete(input),
    onError: fail,
    onSuccess: (result) => {
      notify(result);
      setLiveLogin(result.ok);
      refreshLogins();
    },
  });
  const logoutMutation = useMutation({
    mutationFn: (input: { provider: "claude" | "codex"; accountDir: string; server: string; workspaceId: string }) =>
      callLogout(input),
    onError: fail,
    onSuccess: (result) => {
      notify(result);
      if (result.ok) void workspaceQuery.refetch();
    },
  });

  const data = workspaceQuery.data;
  const server: ProjectMcpServer | undefined = selected
    ? data?.servers.find((entry) => entry.name === selected)
    : undefined;
  const projectOauthAccounts = server
    ? (data?.accounts ?? []).filter(
        (account) => account.provider === "claude" && oauthState(account, server.name).known,
      )
    : [];
  const refresh = () => {
    void workspaceQuery.refetch();
    refreshLogins();
  };
  const pill = !workspace
    ? { status: "error" as Status, label: "Workspace unavailable" }
    : workspaceQuery.isError
      ? { status: "error" as Status, label: "Host unavailable" }
      : !data
        ? { status: "neutral" as Status, label: "Reading" }
        : data.servers.length === 0
          ? { status: "neutral" as Status, label: "No project servers" }
          : { status: "ok" as Status, label: plural(data.servers.length, "project server") };

  const body = !workspace ? (
    <EmptyState title="Workspace unavailable" body="This Paseo workspace no longer exists." />
  ) : workspaceQuery.isLoading ? (
    <Loading label="Reading project MCP servers…" />
  ) : workspaceQuery.error ? (
    <Notice tone="error">
      <View style={{ gap: t.space.sm }}>
        <Text style={t.text.body}>{errorText(workspaceQuery.error)}</Text>
        <View style={{ flexDirection: "row" }}>
          <Button label="Retry" onPress={refresh} />
        </View>
      </View>
    </Notice>
  ) : server && data ? (
    <View style={{ gap: t.space.lg }}>
      <View style={{ flexDirection: "row" }}>
        <Button label="← Workspace MCP servers" variant="ghost" onPress={() => setSelected(null)} />
      </View>
      <View style={{ gap: t.space.sm }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
          <Text style={[t.text.display, { flexShrink: 1 }]} numberOfLines={1}>{server.name}</Text>
          <Tag label={server.transport} />
          {projectOauthAccounts.length > 0 ? <Tag label={`OAuth on ${projectOauthAccounts.length}`} /> : null}
        </View>
        {server.detail ? <Text style={t.text.caption}>{server.detail}</Text> : null}
      </View>
      {server.authStyle === "inline-credentials" ? (
        <Notice tone="ok">This project definition already supplies credentials; no OAuth grant is required here.</Notice>
      ) : null}
      {projectOauthAccounts.length > 0 && loginQuery.isLoading ? (
        <Loading label="Reading account connections…" />
      ) : null}
      {projectOauthAccounts.length > 0 && loginQuery.error ? (
        <ErrorText>{errorText(loginQuery.error)}</ErrorText>
      ) : null}
      <AuthRows
        server={server.name}
        accounts={projectOauthAccounts}
        destinations={[]}
        presentIn={[]}
        sessions={sessions}
        oauthCapable={projectOauthAccounts.length > 0}
        daemonIsLocal={loginQuery.data?.daemonIsLocal ?? true}
        daemonHostname={loginQuery.data?.hostname ?? host.label}
        pendingAccount={
          loginMutation.isPending && loginMutation.variables
            ? `${loginMutation.variables.provider}|${loginMutation.variables.account}`
            : null
        }
        forceDefined
        workspaceId={workspaceId}
        workspaceDirectory={data.workspace.directory}
        onAuthorise={(account) =>
          loginMutation.mutate({
            provider: account.provider,
            accountDir: account.isPrimary ? "" : account.dir,
            account: account.email,
            server: server.name,
            workspaceId,
          })
        }
        onCancel={(key) => cancelMutation.mutate(key)}
        onSignOut={(account) =>
          logoutMutation.mutate({
            provider: account.provider,
            accountDir: account.isPrimary ? "" : account.dir,
            server: server.name,
            workspaceId,
          })
        }
        onComplete={(key, redirectUrl) => completeMutation.mutate({ key, redirectUrl })}
        onCopied={(ok) =>
          ok ? toast.show("Sign-in link copied.", { variant: "success" }) : toast.show("No clipboard here — the link above is selectable.", { variant: "warning" })
        }
      />
    </View>
  ) : data ? (
    <View style={{ gap: t.space.md }}>
      <Facts
        items={[
          { value: data.configPath || "No .mcp.json" },
          { value: plural(data.servers.length, "project server") },
        ]}
      />
      <Card padded={false}>
        {data.servers.length === 0 ? (
          <EmptyState
            title={data.configPath ? "No project MCP servers" : "No .mcp.json in this workspace"}
            body={data.configPath ? "The file exists but has no mcpServers entries." : "Add a .mcp.json at the workspace or project root."}
          />
        ) : null}
        {data.servers.map((entry, index) => (
          <Row
            key={entry.name}
            first={index === 0}
            title={entry.name}
            subtitle={entry.detail}
            onPress={() => setSelected(entry.name)}
            trailing={
              <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.xs }}>
                <ServerHealthTag name={entry.name} />
                <Tag label={entry.transport} />
              </View>
            }
          />
        ))}
      </Card>
    </View>
  ) : null;

  const pad = t.compact ? 16 : 20;
  return (
    <View style={{ flex: 1, backgroundColor: t.color.surface0 }}>
      <View style={{ padding: pad, paddingBottom: t.space.md, gap: t.space.md, width: "100%", maxWidth: t.maxWidth, alignSelf: "center" }}>
        <Header
          title={workspace?.name ?? "MCP connections"}
          caption={`Selected host: ${host.label} · ${caption}`}
          pill={<StatusPill status={pill.status} label={pill.label} />}
        />
        {intro}
        <HealthSummary directory={workspace?.directory ?? ""} />
        <View style={{ flexDirection: "row" }}>
          <Button label="Refresh" variant="ghost" onPress={refresh} />
        </View>
      </View>
      <Screen t={t} paddingTop={4}>{body}</Screen>
    </View>
  );
}
