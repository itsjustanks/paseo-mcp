/** Connectors (MCP servers): their settings, health and sign-ins, kept together per connector. */
import type { PluginSurfaceProps, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { z } from "zod";
import {
  healthNeedsAttention,
  mcpAdd,
  mcpAgentServers,
  mcpApply,
  mcpAuth,
  mcpDefAll,
  mcpEditOne,
  mcpMatrix,
  mcpRemove,
  mcpRename,
  mcpSetEnabled,
  mcpWorkspace,
  type AgentServer,
  type Destination,
  type McpAuthAccount,
  type McpDefRow,
  type McpServerTools,
  type PluginServer,
  type ProjectMcpServer,
  type McpServerRow,
} from "../shared/contracts";
import { SWITCH_EFFECT_NOTE } from "../shared/enabled";
import { plainError } from "../shared/errors";
import { clockTime } from "../shared/schedule";
import { ownedFromRow } from "../shared/catalog";
import { CURATED_CATALOG } from "../shared/catalog-curated";
import { SERVER_FILTERS, healthPlainNote, healthPlainWord, projectFilesFor, providerName, removePlan, serverGallery, signInState, type RemovePlan, type RemoveScope, type ServerCardModel, type ServerFilter } from "../shared/servers";
import { COPY_ALL_EXPLAINER, COPY_ALL_LABEL } from "../shared/copy-all";
import { overviewNextStep, overviewVerdict, type OverviewTarget } from "../shared/overview";
import { HELP_QUESTIONS, MCP_NAME, MCP_NAME_LOWER, PROJECTS_LINE, WHAT_CONNECTORS_ARE, type HelpTarget } from "../shared/guide";
import { addServerRequest, checkNowRequest } from "../shared/screen-params";
import { summarizeTools } from "../shared/tools";
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
import { WorkspaceContext, pickLoad } from "./budget";
import { CatalogGallery, CopyCatalogEntryButton } from "./catalog";
import { CopyAllPanel } from "./copy-all";
import { HealthSummary, ServerHealthTag, healthCheckedLabel, healthStatus, healthWord, splitIssues, useHealth } from "./health";
import { setSignInFocus, useSignInFocus } from "./focus";
import { canOpenMcp, openMcp, takePendingServer } from "./navigate";
import { GuideCard, OverviewGuide } from "./guide";
import { useOpenLink } from "./links";
import { TabBar, type SectionId } from "./navigation";
import { PaseoToolsAgentRow, PaseoToolsCard, PaseoToolsLine, paseoToolsTitle, usePaseoTools } from "./paseo-tools";
import { AiRouterCard } from "./promo";
import { ServerTools, toolsStatus, toolsWord, useTools } from "./tools";
import {
  Accordion,
  AccordionItem,
  Button,
  Card,
  CodeBlock,
  ConfirmButton,
  Disclosure,
  Divider,
  EmptyState,
  ErrorText,
  Facts,
  Field,
  Grid,
  Header,
  HeroCard,
  IconButton,
  Loading,
  Notice,
  Pills,
  QuietLine,
  Row,
  Screen,
  Section,
  SectionTitle,
  Segmented,
  StaleNote,
  StatusLine,
  StatusPill,
  Step,
  Tag,
  Toggle,
  Toolbar,
  TokensProvider,
  TYPE,
  copyToClipboard,
  useTokens,
  useUi,
  type Status,
} from "./ui";

type ParsedServer = z.infer<typeof ParsedServerSchema>;
type PutResult = z.output<typeof mcpRawPut.output>;
type Mode = "add" | "import";
type Kind = "stdio" | "http";

// -------------------------------------------------------------------- helpers

/** A sign-in's progress, in words. */
function sessionWord(state: LoginSession["state"]): string {
  if (state === "done") return "Done";
  if (state === "failed") return "Failed";
  if (state === "waiting") return "Waiting for you";
  return "Starting";
}

function sessionStatus(state: LoginSession["state"]): Status {
  if (state === "done") return "ok";
  if (state === "failed") return "error";
  if (state === "waiting") return "attention";
  return "busy";
}

/** A log or a stack trace is useful; twenty lines of it under the toolbar is not. */
/** Every error shown in these panels, in plain words (shared/errors.ts). */
function errorText(error: unknown): string {
  return plainError(error);
}

/** "14:05" for a query's last successful read. */
function readAt(updatedAt: number): string {
  return clockTime(updatedAt ? new Date(updatedAt).toISOString() : null);
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

/** How current a Codex account's sign-in state is; Codex is asked in the background on the host. */
function codexCheckLine(account: McpAuthAccount): string {
  if (account.provider !== "codex") return "";
  if (account.checking) return " · checking with Codex…";
  if (account.statusNote) {
    return account.statusAsOf
      ? ` · as of ${clockTime(account.statusAsOf)}; the latest check didn't finish: ${account.statusNote}`
      : ` · Codex couldn't be asked: ${account.statusNote}`;
  }
  return account.statusAsOf ? ` · checked ${clockTime(account.statusAsOf)}` : "";
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
      title={`${title} · ${selected.length} of ${destinations.length}`}
      trailing={
        <View style={{ flexDirection: "row", gap: t.space.sm }}>
          <Button label="All" variant="ghost" onPress={onAll} />
          <Button label="None" variant="ghost" onPress={onNone} />
        </View>
      }
    >
      <Card padded={false}>
        {destinations.length === 0 ? (
          <EmptyState title="No AI app found" body="None of Claude, Codex, Kimi or Grok is set up on this computer yet." />
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
              trailing={on ? <Tag label="Included" tone="ok" /> : <Tag label="Skipped" />}
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
    <View style={{ gap: t.space.row }}>
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
        hint="One KEY=value per line. A hidden ••• value keeps the key this app already has."
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
    <View style={{ gap: t.space.row }}>
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
    <View style={{ gap: t.space.row }}>
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
  const openLinkInBrowser = useOpenLink();
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
            ? "Signed in"
            : unsupported
              ? "Can't sign in from here"
              : live
                ? "Signing in…"
                : failed
                  ? "Sign-in failed"
                : auth === "not-connected"
                  ? "Needs sign-in"
                  : "Not checked yet";
          const app = account.provider === "claude" ? "Claude" : "Codex";
          return (
            <Row
              key={`${account.provider}-${account.dir}`}
              first={index === 0}
              title={bare ? "Sign-in" : account.email}
              subtitle={
                (bare
                  ? `${account.email} · ${app}${account.isPrimary ? "" : " (extra account)"}`
                  : `${app}${account.isPrimary ? "" : " (extra account)"}`) +
                codexCheckLine(account)
              }
              trailing={
                connected ? (
                  <>
                    <Button label="Sign in again" onPress={() => onAuthorise(account)} />
                    <ConfirmButton label="Sign out" confirmLabel="Yes, sign out" onConfirm={() => onSignOut(account)} />
                  </>
                ) : !unsupported && daemonIsLocal ? (
                  <Button
                    label="Connect"
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
                          {`Sign-in runs on ${daemonHostname || "the computer running Paseo"}. Approve it in any browser. If it doesn't finish by itself, paste the page's address below.`}
                        </Text>
                        <Disclosure quiet title="Sign in from a terminal instead">
                          <CodeBlock>{loginCommand(account, server, workspaceDirectory)}</CodeBlock>
                        </Disclosure>
                      </>
                    ) : null}
                    {!remote && !session ? (
                      <Text style={t.text.caption}>
                        Connect opens this connector's sign-in page in your browser. If it doesn't finish by itself, paste the page's address below.
                      </Text>
                    ) : null}
                    {session ? (
                      <>
                        <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
                          <StatusPill status={sessionStatus(session.state)} label={sessionWord(session.state)} />
                          <Text style={[t.text.caption, { flex: 1, minWidth: 0 }]} numberOfLines={2}>
                            {session.message}
                          </Text>
                        </View>
                        {session.url ? <CodeBlock>{session.url}</CodeBlock> : null}
                        <View style={{ flexDirection: "row", gap: t.space.sm }}>
                          {session.url ? (
                            <>
                              <Button label="Open sign-in" icon="ExternalLink" onPress={() => openLinkInBrowser(session.url)} />
                              <Button label="Copy link" onPress={() => onCopied(copyToClipboard(session.url))} />
                            </>
                          ) : null}
                          {live ? <Button label="Cancel" variant="ghost" onPress={() => onCancel(session.key)} /> : null}
                        </View>
                        {live && session.expectsRedirect && session.url ? (
                          <View style={{ gap: t.space.sm }}>
                            <Field
                              label="The page's address after you sign in"
                              value={redirects[session.key] ?? ""}
                              onChangeText={(value) => setRedirects((previous) => ({ ...previous, [session.key]: value }))}
                              placeholder={session.callbackUrl || "Paste the full address here"}
                              hint="If your browser ends on a page that won't load (its address starts with localhost), copy that page's full address and paste it here."
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
    <Section title="Sign-in">
      <Card padded={false}>{content}</Card>
    </Section>
  );
}

// --------------------------------------------------------------- switches

function scopeWord(scope: AgentServer["scope"]): string {
  return scope === "user" ? "in every workspace" : scope === "project" ? "this project's own" : "this folder only";
}

/**
 * What one agent loads here, one row per server, with the per-workspace switch
 * its editor actually has. Claude: `disabledMcpServers` for user and local
 * servers, the `.mcp.json` approval lists for project ones. Codex: only the
 * servers the hook injects can be left out. Anything else shows its state and
 * says why there is no switch. State is read from the config on every call, so
 * a `/mcp disable` in a terminal shows up on the next refresh.
 */
function AgentServers({
  data,
  loading,
  error,
  providerLabel,
  onToggle,
  toggling,
  toolsByName,
  signIn,
}: {
  data: z.output<typeof mcpAgentServers.output> | undefined;
  loading: boolean;
  error: unknown;
  providerLabel: string;
  onToggle: (name: string, enabled: boolean) => void;
  toggling: string | null;
  toolsByName: Map<string, McpServerTools> | null;
  signIn: (server: AgentServer) => React.ReactNode;
}) {
  const t = useTokens();
  if (loading && !data) return <Loading label="Reading what this agent loads…" />;
  if (error && !data) return <ErrorText>{errorText(error)}</ErrorText>;
  if (!data) return null;
  const anySwitch = data.servers.some((entry) => entry.enabled.writable);
  const offCount = data.servers.filter((entry) => entry.enabled.state === "disabled").length;
  return (
    <Section
      title={`Connectors for a ${providerLabel} agent here`}
      trailing={canOpenMcp() ? <Button label="All connectors" variant="ghost" onPress={() => openMcp()} /> : undefined}
    >
      <View style={{ gap: t.space.sm }}>
        <Facts
          items={[
            { value: plural(data.servers.length + (data.paseoTools && data.paseoTools.tools > 0 ? 1 : 0) + (data.pluginServers?.length ?? 0), "connector") },
            offCount > 0 ? { value: `${offCount} off for this workspace`, tone: "attention" } : null,
            data.scope ? { value: data.scope.label } : { value: "no settings found for this agent's app" },
          ]}
        />
        <Text style={t.text.caption}>
          {anySwitch
            ? `A switch changes what an agent started in ${data.directory} loads. ${SWITCH_EFFECT_NOTE}`
            : data.scope?.provider === "codex"
              ? "Codex always loads the connectors in its own settings, so only this project's own connectors can be switched off here. To stop Codex loading one, remove it under Connectors."
              : "This app can't switch connectors off for one workspace; each shows whether it's on."}
        </Text>
        {!data.projectIncluded && data.projectNote ? <Text style={t.text.caption}>{data.projectNote}.</Text> : null}
        <Card padded={false}>
          {data.servers.length === 0 && !data.paseoTools && !data.pluginServers?.length ? <EmptyState title="Nothing loads here" body="This agent's app has no connectors for this workspace." /> : null}
          {data.paseoTools ? <PaseoToolsAgentRow info={data.paseoTools} providerLabel={providerLabel} first /> : null}
          {data.servers.map((entry, index) => {
            const tools = toolsByName?.get(entry.name);
            const off = entry.enabled.state === "disabled";
            return (
              <Row
                key={entry.name}
                first={index === 0 && !data.paseoTools}
                tone={off ? "neutral" : undefined}
                title={
                  <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: t.space.sm, minWidth: 0 }}>
                    <Text numberOfLines={1} style={[t.text.bodyStrong, { flexShrink: 1, opacity: off ? 0.6 : 1 }]}>{entry.name}</Text>
                    <Tag label={entry.transport} />
                    <Tag label={scopeWord(entry.scope)} tone={entry.scope === "user" ? undefined : "ok"} />
                    {entry.enabled.state === "undecided" ? <Tag label="asks at launch" tone="attention" /> : null}
                    {tools ? <Tag label={toolsWord(tools)} tone={toolsStatus(tools.kind)} /> : null}
                  </View>
                }
                subtitle={entry.detail || undefined}
                meta={<Text style={t.text.caption}>{entry.enabled.reason}</Text>}
                trailing={
                  entry.enabled.writable ? (
                    <Toggle
                      label={`${entry.name} ${off ? "off" : "on"} for this workspace`}
                      value={!off}
                      loading={toggling === entry.name}
                      disabled={toggling !== null}
                      onChange={(next) => onToggle(entry.name, next)}
                    />
                  ) : (
                    <Tag label={off ? "off here" : "on"} tone={off ? undefined : "ok"} />
                  )
                }
                expanded={
                  <View style={{ gap: t.space.sm }}>
                    {signIn(entry)}
                    {tools && tools.kind === "listed" && tools.tools.length > 0 ? (
                      <Disclosure title={`Tools · ${toolsWord(tools)}`}>
                        <ServerTools entry={tools} open />
                      </Disclosure>
                    ) : null}
                  </View>
                }
              />
            );
          })}
          {(data.pluginServers ?? []).map((entry, index) => (
            <PluginServerRow key={`plugin:${entry.name}`} entry={entry} first={index === 0 && data.servers.length === 0 && !data.paseoTools} />
          ))}
        </Card>
      </View>
    </Section>
  );
}

/**
 * A server the agent was started with that no editor config explains: another
 * plugin's `agent.create` hook added it. No switch: it is that plugin's to turn off.
 */
function PluginServerRow({ entry, first }: { entry: PluginServer; first: boolean }) {
  const t = useTokens();
  return (
    <Row
      first={first}
      title={
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: t.space.sm, minWidth: 0 }}>
          <Text numberOfLines={1} style={[t.text.bodyStrong, { flexShrink: 1 }]}>{entry.name}</Text>
          <Tag label={entry.transport} />
          <Tag label="Added when created" />
          {entry.tools !== undefined ? <Tag label={plural(entry.tools, "tool")} tone="ok" /> : null}
        </View>
      }
      meta={
        <Text style={t.text.caption}>
          {`${entry.tools !== undefined ? "" : `${entry.note.charAt(0).toUpperCase()}${entry.note.slice(1)}. `}Not in any AI app's settings now: it was added when this agent was started, by a plugin (or this plugin's "Add project connectors" setting at the time) or by whoever started the agent. A new agent gets whatever those add then.`}
        </Text>
      }
      trailing={<Tag label="on" tone="ok" />}
    />
  );
}

// ------------------------------------------------------------------- removal

/**
 * Delete with three honest scopes, two steps each, never inside an editor.
 * Step one picks the scope; step two reads the plan (files, counts, what is
 * lost) and confirms. Scope `everywhere` is the only one after which the server
 * stays gone, since Claude Code reads a project's `.mcp.json` straight back.
 */
function RemovePanel({
  server,
  destinations,
  projectFiles,
  armed,
  onArm,
  pending,
  result,
  onRemove,
}: {
  server: McpServerRow;
  destinations: Destination[];
  projectFiles: { project: string; path: string }[];
  armed: { scope: RemoveScope; destId?: string } | null;
  onArm: (next: { scope: RemoveScope; destId?: string } | null) => void;
  pending: boolean;
  result: { ok: boolean; removed: string[]; skipped: string[] } | null;
  onRemove: (plan: RemovePlan) => void;
}) {
  const t = useTokens();
  const present = destinations.filter((dest) => server.presentIn.includes(dest.id));
  const [destId, setDestId] = useState<string>(present[0]?.id ?? "");
  const plan = armed ? removePlan(server, destinations, armed.scope, armed.destId ?? destId, projectFiles) : null;
  const everywhereCount = present.length + projectFiles.length;
  if (present.length === 0 && projectFiles.length === 0) return null;
  return (
    <View style={{ gap: t.space.sm }}>
      {!armed ? (
        <View style={{ gap: t.space.sm }}>
          <Text style={t.text.body}>You'll see exactly what's removed before anything changes.</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: t.space.sm }}>
            {present.length > 1 ? <Button label="From one app…" variant="danger" disabled={pending} onPress={() => onArm({ scope: "one" })} /> : null}
            {present.length > 0 ? <Button label={present.length > 1 ? `From all ${plural(present.length, "app")}` : "From this app"} variant="danger" disabled={pending} onPress={() => onArm({ scope: present.length > 1 ? "all" : "one" })} /> : null}
            {projectFiles.length > 0 ? <Button label={`Everywhere, projects too (${everywhereCount})`} variant="danger" disabled={pending} onPress={() => onArm({ scope: "everywhere" })} /> : null}
          </View>
        </View>
      ) : null}
      {armed?.scope === "one" && present.length > 1 ? (
        <Segmented value={destId} onChange={setDestId} options={present.map((dest) => ({ value: dest.id, label: dest.label }))} />
      ) : null}
      {armed && plan ? (
        <Notice tone="error">
          <View style={{ gap: t.space.sm }}>
            <Text style={t.text.bodyStrong}>{plan.title}</Text>
            {plan.lines.map((line, index) => (
              <Text key={index} style={t.text.caption}>{line}</Text>
            ))}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm }}>
              <Button label={plan.confirmLabel} variant="danger" loading={pending} onPress={() => onRemove(plan)} />
              <Button label="Cancel" variant="ghost" onPress={() => onArm(null)} />
            </View>
          </View>
        </Notice>
      ) : armed ? (
        <Text style={t.text.caption}>Nothing to remove there.</Text>
      ) : null}
      {result && result.skipped.length > 0 ? (
        <Notice tone={result.ok ? "attention" : "error"}>
          <View style={{ gap: t.space.xs }}>
            <Text style={t.text.bodyStrong}>{result.ok ? `Removed from ${result.removed.length}; ${plural(result.skipped.length, "place")} skipped` : "Nothing removed"}</Text>
            <Lines items={result.skipped} />
          </View>
        </Notice>
      ) : null}
    </View>
  );
}

// -------------------------------------------------------------------- surface

// Since 0.7.0 the Servers section is the one place for a server. Since 0.15.0
// it is a gallery: each card says what the server is, whether it works, which
// apps have it and its sign-in state; its tools, sign-in rows, Add to missing
// and Remove are on its own page, behind the card's settings button. Totals
// and Paseo's built-in tools sit in two closed rows above the gallery, and
// Sync (now "Copy servers to my other accounts") is on Overview. The sections
// themselves (ids, labels, icons, the line under the tab bar) live in
// client/navigation.tsx.
type Filter = ServerFilter;

function plural(count: number, word: string, many?: string): string {
  return `${count} ${count === 1 ? word : many ?? `${word}s`}`;
}

const FILTER_WORDS: Record<Filter, string> = {
  all: "",
  gaps: "is missing from one of your apps",
  issues: "needs attention",
  "sign-in": "needs you to sign in",
};

/** "Checked 6 connectors: none has "jam" in its name or description and needs you to sign in." — what an empty list was checked for. */
function noMatchLine(count: number, search: string, filter: Filter): string {
  const parts = [search.trim() ? `has "${search.trim()}" in its name or description` : "", FILTER_WORDS[filter]].filter(Boolean);
  return `Checked ${plural(count, "connector")}: none ${parts.join(" and ")}.`;
}

/** What the plugin knows about well-known servers, for the cards' one-line descriptions. */
const KNOWN_SERVERS = CURATED_CATALOG.map((entry) => ({ url: entry.url, command: entry.command, args: entry.args, description: entry.description }));

/**
 * One connector on the Connectors tab: what it is, whether it works, which
 * apps have it, and its sign-in state. The whole card opens its own page
 * (0.19.0; before, only the small settings button did).
 */
function ServerGalleryCard({ card, checking, onOpen }: { card: ServerCardModel; checking: boolean; onOpen: () => void }) {
  const t = useTokens();
  const attention = Boolean(card.health && healthNeedsAttention(card.health));
  const waiting = checking && !card.health;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Open ${card.name}`} onPress={onOpen} style={({ pressed }) => ({ flexGrow: 1, opacity: pressed ? 0.85 : 1 })}>
    <Card grow tone={attention && card.health ? healthStatus(card.health) : undefined}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: t.space.sm }}>
        <View style={{ flex: 1, minWidth: 0, gap: t.space.hair }}>
          <Text numberOfLines={1} style={t.text.heading}>{card.name}</Text>
          <Text numberOfLines={2} style={[t.text.body, { minHeight: 44 }]}>{card.description}</Text>
        </View>
        <IconButton icon="ChevronRight" label={`Open ${card.name}`} onPress={onOpen} />
      </View>
      <View style={{ gap: t.space.xs }}>
        <StatusPill status={waiting ? "busy" : card.health ? healthStatus(card.health) : "neutral"} label={waiting ? "Checking…" : card.healthWord} />
        <Text numberOfLines={2} style={{ ...TYPE.secondary, color: card.missing > 0 ? t.color.warning : t.color.fg }}>{card.apps}</Text>
        <Text numberOfLines={1} style={{ ...TYPE.secondary, color: card.signIn === "needs" ? t.color.warning : t.color.fg }}>{card.signInText}</Text>
      </View>
    </Card>
    </Pressable>
  );
}

/** Toasts carry one line. Anything longer is kept where the section can show it. */
function firstLine(text: string, fallback: string): string {
  const line = text.split("\n").map((entry) => entry.trim()).find(Boolean) ?? "";
  if (!line) return fallback;
  return text.trim().includes("\n") ? `${line} …` : line;
}

/** "Claude · Codex ×2 · Kimi" — which AI apps have a connector, app by app. */
function editorFacts(presentIn: string[], destinations: Destination[]): string[] {
  const counts = new Map<string, number>();
  for (const dest of destinations) {
    if (!presentIn.includes(dest.id)) continue;
    const name = providerName(dest.provider);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name));
}

/** The AI apps found on this computer, by name: "Claude", "Codex", "Kimi Code". */
function appNames(destinations: Destination[]): string[] {
  return [...new Set(destinations.map((dest) => dest.label.split(" · ")[0]!.trim()).filter(Boolean))];
}

/** The hero's tone and icons, from the verdict and where the next step goes. */
function heroFor(status: Status, target: OverviewTarget, facts: { state: string; staleAt: string | null; servers: number; signIn: number }): { tone: Status; icon: string; action?: string } {
  if (facts.state === "error") return { tone: "error", icon: "CircleAlert", action: "RefreshCw" };
  if (facts.state === "loading") return { tone: "neutral", icon: "Loader", action: "RefreshCw" };
  if (facts.staleAt) return { tone: "attention", icon: "Clock", action: "RefreshCw" };
  if (facts.servers === 0) return { tone: "neutral", icon: "Plus", action: "Plus" };
  if (status === "ok") return { tone: "ok", icon: "CircleCheck", action: "Plug" };
  if (target.section === "copy") return { tone: "attention", icon: "Copy", action: "Copy" };
  if (status === "error") return { tone: "error", icon: "CircleAlert", action: "Search" };
  return { tone: "attention", icon: facts.signIn > 0 && target.section === "servers" && target.filter === "sign-in" ? "KeyRound" : "TriangleAlert", action: "Search" };
}

/** `params` (Paseo 0.11 screens): `add=server` opens on Add a connector, from the sidebar row's "+"; `check=now` checks every connector again (0.19.1). */
export function McpSurface({ theme, layout, host, params }: PluginSurfaceProps & { params?: Record<string, string> }) {
  const t = useUi(theme, layout.compact);
  return (
    <TokensProvider value={t}>
      <McpBody key={host.id} theme={theme} layout={layout} host={host} addRequest={addServerRequest(params)} checkRequest={checkNowRequest(params)} />
    </TokensProvider>
  );
}

function McpBody({ layout, host, addRequest, checkRequest }: PluginSurfaceProps & { addRequest: string | null; checkRequest: string | null }) {
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
  // 0.15.0: "Copy to all my AI apps" opens its preview in place of the section.
  const [copyOpen, setCopyOpen] = useState(false);
  // 0.19.0: Help's "Save a backup" opens the backup fold-out at the bottom of the Connectors tab.
  const [extraOpen, setExtraOpen] = useState<"backup" | null>(null);
  // 0.12.0: "Add server" opens the catalogue gallery in place of the list.
  const [catalogOpen, setCatalogOpen] = useState(addRequest !== null);
  // The sidebar "+" (0.11): each press carries a new `at`, so the gallery opens again even while the page is open.
  useEffect(() => {
    if (addRequest === null) return;
    setCopyOpen(false);
    setSection("servers");
    setSelected(null);
    setCatalogOpen(true);
  }, [addRequest]);

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
  // Tool lists are cached on the host the same way; the connector page reads
  // them, and Refresh there asks every connector again.
  const toolsQuery = useTools();
  const paseoToolsQuery = usePaseoTools();
  const toolsByName = useMemo(
    () => toolsQuery.data ? new Map(toolsQuery.data.servers.map((entry) => [entry.name, entry])) : null,
    [toolsQuery.data],
  );

  const addTargets = useTargetSet(destinations);
  const importTargets = useTargetSet(destinations);

  // Sign-in state answers at once from files; `refresh` also asks Codex again
  // on the host, in the background. While that check runs (`checking`), read
  // again every few seconds, and only then.
  const forceAuth = useRef(false);
  const authQuery = useQuery({
    queryKey: ["paseo-mcp", "auth"],
    queryFn: () => {
      const refresh = forceAuth.current;
      forceAuth.current = false;
      return callAuth({ refresh });
    },
    retry: 1,
    refetchInterval: (query) => (query.state.data?.checking ? 3000 : false),
  });
  const refetchAuthQuery = authQuery.refetch;
  const refreshAuth = useCallback(() => {
    forceAuth.current = true;
    return refetchAuthQuery();
  }, [refetchAuthQuery]);
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
  useEffect(() => {
    if (!settled) return;
    void refreshAuth();
  }, [settled, refreshAuth]);

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
    void refreshAuth();
    void queryClient.invalidateQueries({ queryKey: ["paseo-mcp", "raw"] });
    void queryClient.invalidateQueries({ queryKey: ["paseo-mcp", "def"] });
  };
  const refreshLogins = () => void loginQuery.refetch();
  const refreshAll = () => {
    refreshDefinitions();
    refreshLogins();
  };
  // "Check connectors" (0.19.1): each press carries a new `at`, so it checks again even while the page is open.
  useEffect(() => {
    if (checkRequest !== null) refreshAll();
  }, [checkRequest]);
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
    setArmedRemove(null);
    setRemoveResult(null);
  };
  // A panel's problem row can open this surface asking for one server.
  useEffect(() => {
    const requested = takePendingServer();
    if (requested) selectServer(requested);
  }, []);
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
    mutationFn: (input: { name: string; targets: string[]; projectFiles: string[] }) => callRemove(input),
    onError: fail,
    onSuccess: (result, input) => {
      // Partial failure stays visible: the toast is one line, the skipped
      // targets are reported in full under the server.
      report(result);
      setRemoveResult({ ...result, server: input.name });
    },
  });
  // Both carry the server they belong to: the list draws a RemovePanel per
  // card, and an unkeyed armed state armed every card at once (0.7.0-0.8.0).
  const [removeResult, setRemoveResult] = useState<{ server: string; ok: boolean; removed: string[]; skipped: string[] } | null>(null);
  const [armedRemove, setArmedRemove] = useState<{ server: string; scope: RemoveScope; destId?: string } | null>(null);
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
        void refreshAuth();
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
    return Boolean(entry && healthNeedsAttention(entry.status));
  };
  const issueServers = health ? servers.filter(isIssue) : [];
  const brokenServers = issueServers.filter((server) => {
    const status = health?.get(server.name)?.status;
    return status === "down" || status === "binary-missing";
  });
  const inlineServers = servers.filter((server) => server.inlineCredentialsIn.length > 0);
  const projectServers = authQuery.data?.projectServers ?? [];
  const projectGroups = [...projectServers.reduce((groups, entry) => {
    const names = groups.get(entry.project) ?? [];
    names.push(entry.name);
    groups.set(entry.project, names);
    return groups;
  }, new Map<string, string[]>()).entries()];
  const signInOf = (server: McpServerRow) => signInState(server.name, accounts);
  const signInServers = servers.filter((server) => signInOf(server) === "needs");
  // Your servers as the Add gallery's "already have" rules read them (shared/catalog.ts alreadyHave).
  const owned = useMemo(() => servers.map(ownedFromRow), [servers]);
  // The Servers gallery: cards, what the filter and search keep, and each pill's count (shared/servers.ts).
  const gallery = serverGallery({ servers, destinations, health, accounts, authRead: Boolean(authQuery.data), known: KNOWN_SERVERS, filter, query });
  const toolTotals = toolsQuery.data ? summarizeTools(toolsQuery.data.servers) : null;

  const server = selected ? servers.find((entry) => entry.name === selected) : undefined;
  const serverHealth = server ? health?.get(server.name) : undefined;
  const serverTools = server ? toolsByName?.get(server.name) : undefined;
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
  // A failed refresh keeps the last good read on screen (labelled with its time)
  // instead of emptying the surface; only a first read that fails shows an error.
  const ready = Boolean(matrixQuery.data);
  const matrixStale = matrixQuery.isError && Boolean(matrixQuery.data);

  // The pill and the Overview's next step come from one decision table
  // (shared/overview.ts), so they always name the same problem. Sign-in counts
  // the connectors the "Needs sign-in" filter shows, so the two numbers match.
  const overviewFacts = {
    state: matrixQuery.data ? ("ready" as const) : matrixQuery.isError ? ("error" as const) : ("loading" as const),
    staleAt: matrixStale ? readAt(matrixQuery.dataUpdatedAt) : null,
    hostLabel: host.label,
    servers: servers.length,
    broken: brokenServers.length,
    warnings: issueServers.length - brokenServers.length,
    signIn: signInServers.length,
    gaps: gapServers.length,
  };
  const headerPill: { status: Status; label: string } = overviewVerdict(overviewFacts);
  const nextStep = overviewNextStep(overviewFacts);
  const goTo = (target: OverviewTarget) => {
    if (target.section === "refresh") refreshAll();
    else if (target.section === "copy") setCopyOpen(true);
    else if (target.section === "transfer") go("transfer", { mode: target.mode });
    else if (target.section === "add") { go("servers", { server: null }); setCatalogOpen(true); }
    else go("servers", { server: null, filter: target.filter });
  };

  // One row per connector that needs a look, with every reason it is listed.
  const attentionByServer = new Map<string, { label: string; detail: string; tone: Status }[]>();
  const noteAttention = (name: string, item: { label: string; detail: string; tone: Status }) =>
    attentionByServer.set(name, [...(attentionByServer.get(name) ?? []), item]);
  for (const entry of issueServers) {
    const item = health!.get(entry.name)!;
    noteAttention(entry.name, { label: healthPlainWord(item.status), detail: healthPlainNote(item.status), tone: healthStatus(item.status) });
  }
  for (const entry of inlineServers) {
    noteAttention(entry.name, {
      label: `saved key in ${plural(entry.inlineCredentialsIn.length, "app")}`,
      detail: "A key is saved as plain text in that app's settings file. Exports hide it unless you choose to include it.",
      tone: "attention",
    });
  }
  const attention = [...attentionByServer.entries()];

  // ---------------------------------------------------------------- sections

  const toServers = (filter: Filter) => () => go("servers", { server: null, filter });

  // "a, b, c and 2 more": which connectors a line is about, without a wall of names.
  const nameList = (list: McpServerRow[]) => {
    const head = list.slice(0, 3).map((entry) => entry.name).join(", ");
    return list.length > 3 ? `${head} and ${list.length - 3} more` : head;
  };
  const connectedCount = servers.filter((entry) => signInOf(entry) === "connected").length;

  // At a glance, inside the hero: three questions, each with the link to where it is dealt with (the calm standard:
  // at most four rows). Tools, Paseo's own tools and projects have their own tabs.
  const glance = (
    <View style={{ gap: t.space.xs }}>
      <StatusLine
        label="Health"
        {...(!health
          ? { value: healthQuery.error ? "unavailable" : healthQuery.isFetching ? "checking" : "not checked yet", status: healthQuery.isFetching ? "busy" as Status : "neutral" as Status, hint: healthQuery.error ? errorText(healthQuery.error) : null }
          : health.size === 0
            ? { value: "nothing to check", status: "neutral" as Status, hint: null }
          : brokenServers.length > 0
            ? { value: `${brokenServers.length} not working`, status: "error" as Status, hint: nameList(brokenServers), action: { label: "Show", onPress: toServers("issues") } }
            : issueServers.length > 0
              ? { value: `${plural(issueServers.length, "connector")} with a warning`, status: "attention" as Status, hint: nameList(issueServers), action: { label: "Show", onPress: toServers("issues") } }
              : { value: "all working", status: "ok" as Status, hint: healthQuery.data ? healthCheckedLabel(healthQuery.data) : null })}
      />
      <StatusLine
        label="AI apps"
        {...(!ready
          ? { value: "reading", status: "neutral" as Status }
          : servers.length === 0
            ? { value: "no connectors yet", status: "neutral" as Status, hint: `${plural(destinations.length, "AI app and account", "AI apps and accounts")} found on ${host.label}` }
            : gapServers.length > 0
              ? { value: `${plural(gapServers.length, "connector")} missing from some apps`, status: "attention" as Status, action: { label: "Show", onPress: toServers("gaps") } }
              : { value: "every app has every connector", status: "ok" as Status, hint: `${plural(servers.length, "connector")} in ${plural(destinations.length, "AI app and account", "AI apps and accounts")}`, action: { label: "Connectors", onPress: toServers("all") } })}
      />
      <StatusLine
        label="Sign-in"
        {...(!authQuery.data
          ? { value: authQuery.error ? "unavailable" : "reading", status: "neutral" as Status, hint: authQuery.error ? errorText(authQuery.error) : null }
          : signInServers.length > 0
            ? { value: `${signInServers.length} need sign-in`, status: "attention" as Status, hint: nameList(signInServers), action: { label: "Show", onPress: toServers("sign-in") } }
            : connectedCount > 0
              ? { value: "all signed in", status: "ok" as Status, hint: `${plural(connectedCount, "connector")} you sign in to, across ${plural(accounts.length, "account")}` }
              : { value: "none needed", status: "neutral" as Status, hint: "No connector here asks you to sign in" })}
      />
    </View>
  );

  // The hero says the state in words, then three rows, one muted line and at most two buttons. The per-connector
  // detail folds behind a quiet link; teaching folds into one "New to connectors?" link; AI Router is one line.
  const hero = heroFor(headerPill.status, nextStep.target, overviewFacts);
  const checkedLine = healthQuery.data ? healthCheckedLabel(healthQuery.data) : null;
  const secondary =
    servers.length > 0 && nextStep.label !== "See your connectors"
      ? { label: "See your connectors", icon: "Plug", onPress: toServers("all") }
      : { label: "Add a connector", icon: "Plus", onPress: () => { go("servers", { server: null }); setCatalogOpen(true); } };
  const overview = (
    <View style={{ gap: t.space.section }}>
      <HeroCard tone={hero.tone} icon={hero.icon} title={nextStep.title} lead={nextStep.detail}>
        {matrixQuery.isError && !matrixQuery.data ? <ErrorText>{errorText(matrixQuery.error)}</ErrorText> : null}
        {glance}
        {checkedLine ? <Text style={t.text.caption}>{`Health ${checkedLine}`}</Text> : null}
        {attention.length > 0 ? (
          <Disclosure quiet title={`See which connectors need a look (${attention.length})`} openTitle="Hide which connectors need a look">
            <Card padded={false} level={2}>
              {attention.map(([name, items], index) => (
                <Row
                  key={name}
                  first={index === 0}
                  tone={items.some((item) => item.tone === "error") ? "error" : "attention"}
                  title={name}
                  meta={
                    <View style={{ gap: t.space.xs, paddingTop: t.space.hair }}>
                      {items.map((item) => (
                        <View key={item.label} style={{ gap: t.space.hair }}>
                          <StatusPill status={item.tone} label={item.label} />
                          <Text style={t.text.caption}>{item.detail}</Text>
                        </View>
                      ))}
                    </View>
                  }
                  trailing={<Button label="Open" onPress={() => selectServer(name)} />}
                />
              ))}
            </Card>
          </Disclosure>
        ) : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: t.space.sm }}>
          <Button
            label={nextStep.label}
            variant="primary"
            icon={hero.action}
            loading={nextStep.target.section === "refresh" && matrixQuery.isFetching}
            onPress={() => goTo(nextStep.target)}
          />
          <Button label={secondary.label} icon={secondary.icon} onPress={secondary.onPress} />
        </View>
      </HeroCard>
      <View style={{ gap: t.space.sm }}>
        <QuietLine icon="Info">{WHAT_CONNECTORS_ARE}</QuietLine>
        <OverviewGuide apps={appNames(destinations)} open={ready && servers.length === 0} onAdd={() => go("servers", { server: null })} onCopy={() => setCopyOpen(true)} />
      </View>
      <AiRouterCard />
    </View>
  );

  // Search and the filter pills, each pill with how many connectors it would show.
  const filters = (
    <View style={{ gap: t.space.sm }}>
      <Field value={search} onChangeText={setSearch} placeholder="Search your connectors" />
      <Pills
        value={filter}
        onChange={setFilter}
        options={SERVER_FILTERS.map((option) => ({ value: option.value, label: `${option.label} ${gallery.counts[option.value]}` }))}
      />
    </View>
  );

  // Totals, folded away so the gallery starts near the top.
  const summaryStrip = (
    <Facts
      items={[
        { value: `${plural(servers.length, "connector")} across ${plural(destinations.length, "app account")}` },
        toolTotals ? { value: `${toolTotals.tools} tools from ${toolTotals.listed} of ${plural(toolTotals.servers, "connector")}`, tone: toolTotals.tools > 0 ? "ok" : undefined } : { value: "tools not listed yet" },
        authQuery.data ? { value: `${signInServers.length} need sign-in`, tone: signInServers.length > 0 ? "attention" : undefined } : null,
        health ? { value: `${issueServers.length} need${issueServers.length === 1 ? "s" : ""} attention`, tone: issueServers.length > 0 ? "attention" : "ok" } : null,
        { value: `${gapServers.length} missing from some apps` },
        healthQuery.data ? { value: healthCheckedLabel(healthQuery.data, (iso) => new Date(iso).toLocaleString()) } : null,
      ]}
    />
  );

  const removePanel = (entry: McpServerRow) => (
    <RemovePanel
      server={entry}
      destinations={destinations}
      projectFiles={projectFilesFor(entry.name, projectServers)}
      armed={armedRemove?.server === entry.name ? armedRemove : null}
      onArm={(next) => setArmedRemove(next ? { ...next, server: entry.name } : null)}
      pending={removeMutation.isPending}
      result={removeResult?.server === entry.name ? removeResult : null}
      onRemove={(plan) => {
        setArmedRemove(null);
        removeMutation.mutate({ name: entry.name, targets: plan.targets, projectFiles: plan.projectFiles });
      }}
    />
  );

  const list = (
    <View style={{ gap: t.space.row }}>
      {matrixQuery.isLoading ? <Loading label={`Reading your AI apps' settings on ${host.label}…`} /> : null}
      {healthQuery.error ? (
        <ErrorText>
          {healthQuery.data
            ? `Could not read the latest health check (${errorText(healthQuery.error)}). Showing the check from ${clockTime(healthQuery.data.checkedAt)}.`
            : `Could not read the health check: ${errorText(healthQuery.error)}`}
        </ErrorText>
      ) : null}
      {ready && gallery.cards.length === 0 ? (
        <Card>
          {servers.length === 0 ? (
            <EmptyState
              title="No connectors yet"
              body={`None of your AI apps on ${host.label} has a connector yet. Add one from the gallery and it shows here.`}
              action={<Button label="Add a connector" variant="primary" onPress={() => setCatalogOpen(true)} />}
            />
          ) : (
            <EmptyState
              title="No connector matches"
              body={noMatchLine(servers.length, search, filter)}
              action={<Button label="Show all connectors" onPress={() => { setSearch(""); setFilter("all"); }} />}
            />
          )}
        </Card>
      ) : null}
      {gallery.cards.length > 0 ? (
        <Grid min={280}>
          {gallery.cards.map((card) => (
            <ServerGalleryCard key={card.name} card={card} checking={healthQuery.isFetching} onOpen={() => selectServer(card.name)} />
          ))}
          {/* Empty fillers keep a short last row at column width, as in the Add gallery. */}
          {t.compact ? null : [0, 1, 2].map((index) => <View key={`filler-${index}`} />)}
        </Grid>
      ) : null}
    </View>
  );

  const back = (
    <View style={{ flexDirection: "row" }}>
      <Button label="← All connectors" variant="ghost" onPress={() => selectServer(null)} />
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

  // A connector's own page (0.19.0): what it is and whether it works, the one or two things to do, its
  // sign-in when it has one, then fold-outs for its tools, its AI apps, renaming, the technical details and removal.
  const kindWord = server ? (server.transport === "http" ? "On the web" : server.transport === "stdio" ? "Runs on this computer" : "Kind unknown") : "";
  const appsWord = server
    ? server.presentIn.length === destinations.length
      ? `In all ${plural(destinations.length, "AI app")}`
      : `In ${server.presentIn.length} of ${plural(destinations.length, "AI app")}`
    : "";
  const serverPane = server ? (
    <View style={{ gap: t.space.section }}>
      {back}
      <Card>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: t.space.sm }}>
          <Text style={[t.text.display, { flexShrink: 1 }]} numberOfLines={1}>
            {server.name}
          </Text>
          {serverHealth ? (
            <StatusPill status={healthStatus(serverHealth.status)} label={healthWord(serverHealth.status)} />
          ) : null}
        </View>
        <Text style={t.text.body}>{`${kindWord} · ${appsWord}`}</Text>
        {serverHealth && serverHealth.status !== "ok" && serverHealth.note ? (
          <Text style={t.text.body}>{serverHealth.note}</Text>
        ) : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm }}>
          {missing.length > 0 ? (
            <Button
              label={`Add to the ${plural(missing.length, "app")} missing it`}
              variant="primary"
              loading={applyMutation.isPending}
              onPress={() => applyMutation.mutate({ name: server.name, targets: missing.map((dest) => dest.id) })}
            />
          ) : null}
          <Button
            label="Check now"
            loading={healthQuery.isFetching}
            onPress={() => { void healthQuery.refetch(); }}
          />
        </View>
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

      <Accordion>
        <AccordionItem
          icon="Wrench"
          title="What it can do"
          summary={serverTools ? toolsWord(serverTools) : toolsQuery.isFetching ? "Asking it…" : "Not listed yet"}
        >
          {serverTools ? (
            <ServerTools entry={serverTools} plain />
          ) : toolsQuery.isFetching ? (
            <Loading label="Asking your connectors what they can do…" />
          ) : (
            <Text style={t.text.caption}>Not listed yet. Refresh asks every connector.</Text>
          )}
          <View style={{ flexDirection: "row" }}>
            <Button label="Refresh" variant="ghost" loading={toolsQuery.isFetching} onPress={() => void toolsQuery.refetch()} />
          </View>
        </AccordionItem>
        <AccordionItem icon="Bot" title="Your AI apps" summary={missing.length > 0 ? `${appsWord} · missing from ${plural(missing.length, "app")}` : appsWord} open={missing.length > 0}>
          <Card padded={false} level={2}>
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
                subtitle={present ? "Added" : "Not in this app"}
                meta={
                  present && server.inlineCredentialsIn.includes(dest.id) ? (
                    <StatusPill status="ok" label="Key saved in its settings" />
                  ) : present && destinationOauth?.known ? (
                    <StatusPill
                      status={destinationOauth.auth === "connected" ? "ok" : "attention"}
                      label={destinationOauth.auth === "connected" ? "Signed in" : "Needs sign-in"}
                    />
                  ) : undefined
                }
                trailing={
                  present ? (
                    open ? undefined : (
                      <Button
                        label="Change"
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
                    <View style={{ gap: t.space.row }}>
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
                    </View>
                  ) : undefined
                }
              />
            );
          })}
          </Card>
        </AccordionItem>
        <AccordionItem icon="PenLine" title="Rename" summary="Change its name in every AI app">
          <Field label="New name" value={renameTo} onChangeText={setRenameTo} placeholder={server.name} />
          <View style={{ flexDirection: "row" }}>
            <Button
              label="Rename everywhere"
              loading={renameMutation.isPending}
              disabled={!renameTo.trim() || renameTo.trim() === server.name}
              onPress={() => renameMutation.mutate({ name: server.name, newName: renameTo.trim() })}
            />
          </View>
        </AccordionItem>
        <AccordionItem icon="SlidersHorizontal" title="Technical details" summary="Its address, saved keys, and copies to share">
          <Facts
            items={[
              server.detail ? { value: server.detail } : null,
              ...editorFacts(server.presentIn, destinations).map((value) => ({ value })),
              inlineCredentialCount > 0 ? { value: `Key saved in ${plural(inlineCredentialCount, "app")}` } : null,
              oauthDestinations.length > 0 ? { value: `Sign-in in ${plural(oauthDestinations.length, "app")}` } : null,
              projectFilesFor(server.name, projectServers).length > 0 ? { value: `In ${plural(projectFilesFor(server.name, projectServers).length, "project")}` } : null,
              healthQuery.data ? { value: healthCheckedLabel(healthQuery.data, (iso) => new Date(iso).toLocaleString()) } : null,
            ]}
          />
          {revealed ? (
            <Notice tone="error">Keys are showing as plain text on this page. They're hidden again when you leave this connector.</Notice>
          ) : null}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm }}>
            <Button label={revealed ? "Hide keys" : "Show keys"} onPress={() => setRevealed((value) => !value)} />
            {/* A panel cannot download, so a copy is saved next to the user's other files and the path is reported back. */}
            <Button
              label="Save a copy"
              loading={exportMutation.isPending}
              onPress={() => exportMutation.mutate({ scope: "one", name: server.name, reveal: revealed })}
            />
            <CopyCatalogEntryButton name={server.name} />
          </View>
          {rawRows.length > 0 ? (
            <View style={{ gap: t.space.sm }}>
              <Text style={t.text.label}>What each app has saved</Text>
              {destinations
                .filter((dest) => server.presentIn.includes(dest.id))
                .map((dest) => {
                  const rawRow = rawRows.find((entry) => entry.destId === dest.id);
                  return rawRow?.nativePreview ? (
                    <View key={dest.id} style={{ gap: t.space.xs }}>
                      <Text style={t.text.caption}>{dest.label}</Text>
                      <CodeBlock>{rawRow.nativePreview}</CodeBlock>
                    </View>
                  ) : null;
                })}
            </View>
          ) : rawQuery.isFetching ? (
            <Loading label="Reading…" />
          ) : null}
        </AccordionItem>
        <AccordionItem icon="Trash2" title="Remove" summary="From one app, or from all of them" tone="error">
          {removePanel(server)}
        </AccordionItem>
      </Accordion>
    </View>
  ) : null;

  // Every connector into one file (0.19.0: moved here from the old import-and-export tab).
  const backupBody = (
    <>
      <Text style={t.text.body}>
        {`Saves every connector from every AI app into one file on ${host.label}. Keys are left out unless you include them, and a file without its keys can't be added back as it is.`}
      </Text>
      <Segmented
        value={exportRevealed ? "reveal" : "mask"}
        onChange={(value) => setExportRevealed(value === "reveal")}
        options={[
          { value: "mask", label: "Leave keys out" },
          { value: "reveal", label: "Include keys" },
        ]}
      />
      {exportRevealed ? (
        <Notice tone="error">The file will hold your keys as plain text. Delete it once you've used it.</Notice>
      ) : null}
      <View style={{ flexDirection: "row" }}>
        <Button
          label="Save a backup"
          loading={exportMutation.isPending && exportMutation.variables?.scope === "all"}
          disabled={servers.length === 0}
          onPress={() => exportMutation.mutate({ scope: "all", reveal: exportRevealed })}
        />
      </View>
    </>
  );

  // The less-used parts of the Connectors tab, last and folded (0.19.0): backup, Paseo's own tools, totals.
  const extras = ready ? (
    <Accordion>
      <AccordionItem key={`backup-${extraOpen ?? ""}`} icon="Archive" title="Back up your connectors" summary="Save them all to one file" open={extraOpen === "backup"}>
        {backupBody}
      </AccordionItem>
      <AccordionItem icon="Boxes" title="Built-in tools" summary={paseoToolsTitle(paseoToolsQuery.data, Boolean(paseoToolsQuery.error))}>
        <PaseoToolsCard hostLabel={host.label} />
      </AccordionItem>
      <AccordionItem icon="ChartColumn" title="Totals and last check" summary={`${plural(servers.length, "connector")} · ${plural(destinations.length, "app account")}`}>
        {summaryStrip}
      </AccordionItem>
    </Accordion>
  ) : null;

  const serversSection = server ? serverPane : catalogOpen ? (
    <CatalogGallery
      destinations={destinations}
      owned={owned}
      onClose={() => setCatalogOpen(false)}
      onAddByHand={(name) => {
        setCatalogOpen(false);
        // The name only: nothing else from a registry answer is carried into the form.
        if (name) setAddName(name);
        go("transfer", { mode: "add" });
      }}
      onPaste={() => {
        setCatalogOpen(false);
        go("transfer", { mode: "import" });
      }}
      onInstalled={refreshDefinitions}
      onOpenServer={(name) => {
        setCatalogOpen(false);
        selectServer(name);
      }}
    />
  ) : (
    <View style={{ gap: t.space.section }}>
      <Toolbar
        actions={
          <>
            <Button label="Add connector" icon="Plus" variant="primary" onPress={() => setCatalogOpen(true)} />
            {/* One Refresh: settings, health, sign-in and every connector's tool list. */}
            <Button
              label="Refresh"
              variant="ghost"
              loading={matrixQuery.isFetching || healthQuery.isFetching || authQuery.isFetching || toolsQuery.isFetching}
              onPress={() => {
                refreshAll();
                void toolsQuery.refetch();
              }}
            />
          </>
        }
      />
      {filters}
      {filter === "gaps" && gallery.counts.gaps > 0 ? (
        <Notice tone="attention">
          <View style={{ flexDirection: t.compact ? "column" : "row", alignItems: t.compact ? "stretch" : "center", gap: t.space.sm }}>
            <Text style={[t.text.body, { flex: t.compact ? undefined : 1 }]}>
              {`${plural(gallery.counts.gaps, "connector")} ${gallery.counts.gaps === 1 ? "is" : "are"} missing from some of your AI apps. Copy ${gallery.counts.gaps === 1 ? "it" : "them"} everywhere in one go, after a preview.`}
            </Text>
            <Button label={COPY_ALL_LABEL} variant="secondary" onPress={() => setCopyOpen(true)} />
          </View>
        </Notice>
      ) : null}
      {list}
      {extras}
    </View>
  );

  const projectsSection = (
    <View style={{ gap: t.space.section }}>
      <Text style={t.text.body}>{PROJECTS_LINE}</Text>
      {authQuery.isLoading ? <Loading label="Reading projects…" /> : null}
      {authQuery.error ? <ErrorText>{authQuery.data ? `Could not refresh projects (${errorText(authQuery.error)}). Showing the earlier read.` : `Could not read projects: ${errorText(authQuery.error)}`}</ErrorText> : null}
      {authQuery.data && projectGroups.length === 0 ? (
        <Card>
          <EmptyState
            title="No project has its own connectors"
            body={`No project on ${host.label} comes with its own connectors yet. A project lists them in a file called .mcp.json in its top folder; they show here after the next refresh.`}
          />
        </Card>
      ) : null}
      {projectGroups.length > 0 ? (
        <Card padded={false}>
          {projectGroups.map(([project, names], index) => (
            <Row
              key={project}
              first={index === 0}
              title={project}
              subtitle={names.join(", ")}
              meta={<Facts items={[{ value: plural(names.length, "connector") }]} />}
            />
          ))}
        </Card>
      ) : null}
      <QuietLine icon="KeyRound">{`To sign in to a project's connectors, open that project's workspace, then its Workspace ${MCP_NAME_LOWER} tab.`}</QuietLine>
    </View>
  );

  const addPane = (
    <View style={{ gap: t.space.section }}>
      <Card>
        <Field label="Name" value={addName} onChangeText={setAddName} placeholder="my-connector" hint="What your AI apps will call it." />
        <Segmented
          value={addKind}
          onChange={setAddKind}
          options={[
            { value: "http", label: "It has a link" },
            { value: "stdio", label: "It runs on this computer" },
          ]}
        />
        {addKind === "http" ? (
          <Field label="Link" value={addUrl} onChangeText={setAddUrl} placeholder="https://example.com/mcp" hint="From the connector's setup instructions." />
        ) : (
          <Field label="Command that starts it" value={addCommand} onChangeText={setAddCommand} placeholder="npx -y some-mcp-server" hint="Its setup instructions give you this." />
        )}
        <Disclosure quiet title={addKind === "http" ? "Needs a key or token?" : "Needs settings?"} open={Boolean(addKv.trim())}>
          <Field
            label={addKind === "http" ? "Key or token" : "Settings"}
            value={addKv}
            onChangeText={setAddKv}
            multiline
            mono
            placeholder={addKind === "http" ? "Authorization=Bearer …" : "API_KEY=…"}
            hint={
              addKind === "http"
                ? "Only if the instructions give you one, one Name=value per line. If it signs in with your account instead, leave this empty: after adding, open it and choose Connect."
                : "One NAME=value per line, only if the instructions ask for one."
            }
          />
        </Disclosure>
      </Card>
      <Targets
        title="Add it to"
        destinations={destinations}
        selected={addTargets.ids}
        onToggle={addTargets.toggle}
        onAll={addTargets.all}
        onNone={addTargets.none}
      />
      <View style={{ flexDirection: "row", gap: t.space.sm }}>
        <Button
          label={`Add to ${plural(addTargets.ids.length, "app")}`}
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
    <View style={{ gap: t.space.section }}>
      <Card>
        <Field
          label="Setup instructions"
          value={blob}
          onChangeText={setBlob}
          multiline
          mono
          minHeight={t.text.mono.lineHeight * 10}
          placeholder="Paste the setup instructions here"
          hint="Copy them from the app's website as they are. Extra text around them is fine."
        />
      </Card>
      {parseQuery.isFetching ? <Loading label="Reading them…" /> : null}
      {parseQuery.error ? <ErrorText>{errorText(parseQuery.error)}</ErrorText> : null}
      {parsed && parsed.normalisations.length > 0 ? (
        <Disclosure quiet title="What was tidied up">
          <Lines items={parsed.normalisations} />
        </Disclosure>
      ) : null}
      {parsed && parsed.issues.length > 0 ? <Issues source={debouncedBlob} issues={parsed.issues} /> : null}
      {parsed && parsed.servers.length > 0 ? (
        <>
          <Section title={`Found ${plural(parsed.servers.length, "connector")}`}>
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
                          { value: entry.kind === "http" ? "on the web" : "runs on this computer" },
                          entry.hasPlaceholders.length > 0
                            ? { value: `fill in ${entry.hasPlaceholders.join(", ")}`, tone: "attention" as Status }
                            : null,
                        ]}
                      />
                    }
                    trailing={on ? <Tag label="Add" tone="ok" /> : <Tag label="Skip" />}
                  />
                );
              })}
            </Card>
          </Section>
          <Targets
            title="Add it to"
            destinations={destinations}
            selected={importTargets.ids}
            onToggle={importTargets.toggle}
            onAll={importTargets.all}
            onNone={importTargets.none}
          />
          <Section title="If you already have one with the same name">
            <Segmented
              value={overwrite ? "overwrite" : "keep"}
              onChange={(value) => setOverwrite(value === "overwrite")}
              options={[
                { value: "keep", label: "Keep mine" },
                { value: "overwrite", label: "Replace it" },
              ]}
            />
          </Section>
          {stillPlaceholders.length > 0 ? (
            <Notice tone="attention">
              <View style={{ gap: t.space.sm }}>
                <Text style={t.text.body}>
                  {`${stillPlaceholders.map((entry) => entry.name).join(", ")} still ${stillPlaceholders.length === 1 ? "has" : "have"} parts to fill in (like <API_KEY>). Added as ${stillPlaceholders.length === 1 ? "it is, it won't" : "they are, they won't"} connect.`}
                </Text>
                <Segmented
                  value={allowPlaceholders ? "allow" : "block"}
                  onChange={(value) => setAllowPlaceholders(value === "allow")}
                  options={[
                    { value: "block", label: "Fix them first" },
                    { value: "allow", label: "Add anyway" },
                  ]}
                />
              </View>
            </Notice>
          ) : null}
          <View style={{ flexDirection: "row", gap: t.space.sm }}>
            <Button
              label={`Add ${pickedServers.length} to ${plural(importTargets.ids.length, "app")}`}
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
            <Section title="Added">
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

  // Add with a link (0.19.0): the old import-and-export tab, reached from Add connector and Help; Connectors stays lit.
  const transferSection = (
    <View style={{ gap: t.space.section }}>
      <View style={{ flexDirection: "row" }}>
        <Button label="← Back to the gallery" variant="ghost" onPress={() => { go("servers", { server: null }); setCatalogOpen(true); }} />
      </View>
      <View style={{ gap: t.space.xs }}>
        <Text accessibilityRole="header" style={t.text.display}>Add with a link</Text>
        <Text style={t.text.body}>For a connector that isn't in the gallery: use the link or the setup instructions its maker gives you.</Text>
      </View>
      <Segmented
        value={mode}
        onChange={setMode}
        options={[
          { value: "add", label: "Paste a link" },
          { value: "import", label: "Paste setup instructions" },
        ]}
      />
      {mode === "add" ? addPane : importPane}
    </View>
  );

  // Help (0.19.0): plain questions first, each folded, then how connectors work.
  const helpAction = (target: HelpTarget) => {
    if (target.to === "filter") go("servers", { server: null, filter: target.filter });
    else if (target.to === "copy") setCopyOpen(true);
    else if (target.to === "projects") go("projects");
    else if (target.to === "add") { go("servers", { server: null }); setCatalogOpen(true); }
    else { setExtraOpen("backup"); go("servers", { server: null, filter: "all" }); }
  };
  const helpSection = (
    <View style={{ gap: t.space.section }}>
      <View style={{ gap: t.space.row }}>
        <SectionTitle icon="CircleHelp">Common questions</SectionTitle>
        <Accordion>
          {HELP_QUESTIONS.map((item) => (
            <AccordionItem key={item.question} icon={item.icon} title={item.question}>
              {item.answer.map((line) => (
                <Text key={line} style={t.text.body}>{line.split("{host}").join(host.label)}</Text>
              ))}
              {item.action ? (
                <View style={{ flexDirection: "row" }}>
                  <Button label={item.action.label} onPress={() => helpAction(item.action!.target)} />
                </View>
              ) : null}
            </AccordionItem>
          ))}
        </Accordion>
      </View>
      <View style={{ gap: t.space.row }}>
        <SectionTitle icon="BookOpen">How connectors work</SectionTitle>
        <GuideCard apps={appNames(destinations)} onAdd={() => { go("servers", { server: null }); setCatalogOpen(true); }} onCopy={() => setCopyOpen(true)} />
      </View>
    </View>
  );

  const content = copyOpen
    ? <CopyAllPanel onClose={() => setCopyOpen(false)} onCopied={refreshDefinitions} />
    : section === "overview"
    ? overview
    : section === "servers"
      ? serversSection
        : section === "projects"
          ? projectsSection
          : section === "transfer"
            ? transferSection
            : helpSection;

  const pad = t.compact ? 16 : 24;
  return (
    <View style={{ flex: 1, backgroundColor: t.color.surface0 }}>
      {/* Padded the same way as Screen below, so the header, the tab bar and the content share one left edge. */}
      <View style={{ paddingHorizontal: pad, paddingTop: pad }}>
        <View style={{ width: "100%", maxWidth: t.maxWidth, alignSelf: "center", gap: t.space.row }}>
          <Header title={MCP_NAME} status={headerPill} caption={ready ? `${plural(servers.length, "connector")} on ${host.label}` : `on ${host.label}`} />
          <TabBar active={section} onSelect={(next) => { setCopyOpen(false); go(next, next === "servers" ? { server: null } : {}); }} />
        </View>
      </View>
      <Screen t={t} paddingTop={t.space.section}>
        {matrixStale ? (
          <StaleNote what="your AI apps' settings" at={readAt(matrixQuery.dataUpdatedAt)} reason={errorText(matrixQuery.error)} onRetry={refreshAll} />
        ) : matrixQuery.isError && section !== "overview" ? (
          // On Overview the next-step card already says this, with its own Retry.
          <Notice tone="error">
            <View style={{ gap: t.space.sm }}>
              <Text style={t.text.body}>{errorText(matrixQuery.error)}</Text>
              <View style={{ flexDirection: "row" }}>
                <Button label="Retry connection" onPress={refreshAll} />
              </View>
            </View>
          </Notice>
        ) : null}
        <View key={copyOpen ? "copy" : section}>{content}</View>
      </Screen>
    </View>
  );
}

/** Workspace-local .mcp.json inventory and OAuth, opened beside that workspace. */
/**
 * Where the in-chat sign-in card's Connect lands: that server's sign-in rows
 * (the same OAuth flow as its row below), or, when the plugin cannot start one
 * for it here, where to sign in instead.
 */
function SignInFocus({
  server,
  entry,
  reading,
  rows,
  onDismiss,
}: {
  server: string;
  entry: AgentServer | null;
  reading: boolean;
  rows: (entry: AgentServer) => React.ReactNode;
  onDismiss: () => void;
}) {
  const t = useTokens();
  const signIn = entry ? rows(entry) : null;
  return (
    <Notice tone="attention" onDismiss={onDismiss}>
      <View style={{ gap: t.space.sm }}>
        <Text style={t.text.bodyStrong}>{`${server} needs sign-in`}</Text>
        {reading ? (
          <Loading label="Reading this agent's connectors…" />
        ) : signIn ? (
          signIn
        ) : (
          <Text style={t.text.caption}>
            {entry
              ? `${server} can't be signed in to from here for this agent's account. Sign in from its page under All connectors, or in the AI app itself.`
              : `${server} isn't one of the connectors this agent loads. Sign in from its page under All connectors, or in the AI app itself.`}
          </Text>
        )}
        {canOpenMcp() ? (
          <View style={{ flexDirection: "row" }}>
            <Button label="All connectors" variant="ghost" onPress={() => openMcp()} />
          </View>
        ) : null}
      </View>
    </Notice>
  );
}

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
  caption = "this project's connectors and sign-in",
  intro,
  providerId,
  agentId,
  chatSection,
}: Pick<PluginWorkspacePanelProps, "host" | "workspaceId"> & {
  caption?: string;
  intro?: React.ReactNode;
  /** The agent panel names its provider so the load shown is that agent's, not the heaviest editor's. */
  providerId?: string;
  /** The agent panel's agent, so servers other plugins added to it are listed and counted. */
  agentId?: string;
  /**
   * 0.14.0: the agent panel's chat section (client/chat.tsx), under the load.
   * Not called `context`: the host hands every panel `context: "workspace"`,
   * which the workspace panel passes on, and a string here was drawn as text.
   */
  chatSection?: React.ReactNode;
}) {
  const t = useTokens();
  const toast = useToast();
  const workspace = useWorkspace(workspaceId, ({ name, directory }) => ({ name, directory }));
  const healthQuery = useHealth();
  const callWorkspace = useRpc(mcpWorkspace);
  const callLogin = useRpc(mcpLogin);
  const callLoginStatus = useRpc(mcpLoginStatus);
  const callLoginCancel = useRpc(mcpLoginCancel);
  const callLoginComplete = useRpc(mcpLoginComplete);
  const callLogout = useRpc(mcpLogout);
  const callAgentServers = useRpc(mcpAgentServers);
  const callSetEnabled = useRpc(mcpSetEnabled);
  const toolsQuery = useTools();
  const toolsByName = useMemo(
    () => toolsQuery.data ? new Map(toolsQuery.data.servers.map((entry) => [entry.name, entry])) : null,
    [toolsQuery.data],
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [liveLogin, setLiveLogin] = useState(false);
  // 0.14.0: the in-chat sign-in card's Connect lands here with its server first.
  const signInFocus = useSignInFocus(agentId);

  const workspaceQuery = useQuery({
    queryKey: ["paseo-mcp", "workspace", workspaceId],
    queryFn: () => callWorkspace({ workspaceId }),
    enabled: Boolean(workspace),
    retry: 1,
  });
  // The workspace panel has no agent; it shows the switches for the heaviest
  // wired editor, the same one its count leads with.
  const switchProvider = providerId ?? (workspaceQuery.data ? pickLoad(workspaceQuery.data)?.providerId || "" : "");
  const agentServersQuery = useQuery({
    queryKey: ["paseo-mcp", "agent-servers", workspaceId, switchProvider, agentId ?? ""],
    queryFn: () => callAgentServers({ workspaceId, providerId: switchProvider, ...(agentId ? { agentId } : {}) }),
    enabled: Boolean(workspace) && switchProvider !== "",
    // Read fresh on every visit: a /mcp disable in a terminal must show here.
    // The host's defaults turn refetch-on-mount off, so it is asked for here.
    staleTime: 0,
    refetchOnMount: "always",
    retry: 1,
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
  const setEnabledMutation = useMutation({
    mutationFn: (input: { name: string; enabled: boolean }) => callSetEnabled({ workspaceId, providerId: switchProvider, ...input }),
    onError: fail,
    onSuccess: (result) => {
      notify(result);
      void agentServersQuery.refetch();
    },
  });
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
  // What an agent here loads, by name, so health issues can be split into
  // "this workspace" and "elsewhere" on the same basis as the budget card.
  const loaded = useMemo(() => {
    if (!data?.profile) return null;
    const names = new Set((pickLoad(data, providerId)?.servers ?? []).map((entry) => entry.name));
    for (const entry of data.profile.project) names.add(entry.name);
    return names;
  }, [data, providerId]);
  const attention = useMemo(() => {
    if (!healthQuery.data) return null;
    const directory = workspace?.directory ?? "";
    const { issues, project } = splitIssues(healthQuery.data, directory);
    const here = issues.filter((entry) => healthNeedsAttention(entry.status) && (loaded ? loaded.has(entry.name) : project.includes(entry))).length;
    return { here, elsewhere: issues.length - here };
  }, [healthQuery.data, loaded, workspace]);
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
    void agentServersQuery.refetch();
    void healthQuery.refetch();
    refreshLogins();
  };
  const authFor = (server: string, account: McpAuthAccount | null, inlineCredentials: boolean, transport: string) =>
    account && transport === "http" && !inlineCredentials && oauthState(account, server).known ? (
      <AuthRows
        server={server}
        accounts={[account]}
        destinations={[]}
        presentIn={[]}
        sessions={sessions}
        oauthCapable
        daemonIsLocal={loginQuery.data?.daemonIsLocal ?? true}
        daemonHostname={loginQuery.data?.hostname ?? host.label}
        pendingAccount={
          loginMutation.isPending && loginMutation.variables
            ? `${loginMutation.variables.provider}|${loginMutation.variables.account}`
            : null
        }
        forceDefined
        workspaceId={workspaceId}
        workspaceDirectory={workspaceQuery.data?.workspace.directory ?? ""}
        onAuthorise={(target) =>
          loginMutation.mutate({ provider: target.provider, accountDir: target.isPrimary ? "" : target.dir, account: target.email, server, workspaceId })
        }
        onCancel={(key) => cancelMutation.mutate(key)}
        onSignOut={(target) => logoutMutation.mutate({ provider: target.provider, accountDir: target.isPrimary ? "" : target.dir, server, workspaceId })}
        onComplete={(key, redirectUrl) => completeMutation.mutate({ key, redirectUrl })}
        onCopied={(ok) =>
          ok ? toast.show("Sign-in link copied.", { variant: "success" }) : toast.show("No clipboard here — the link above is selectable.", { variant: "warning" })
        }
        bare
        onlyAccount={{ provider: account.provider, email: account.email }}
      />
    ) : null;
  const workspaceStale = workspaceQuery.isError && Boolean(data);
  const pill = !workspace
    ? { status: "error" as Status, label: "Workspace unavailable" }
    : workspaceQuery.isError && !data
      ? { status: "error" as Status, label: "Host unavailable" }
      : workspaceStale
        ? { status: "attention" as Status, label: `As of ${readAt(workspaceQuery.dataUpdatedAt)}` }
      : !data
        ? { status: "neutral" as Status, label: "Reading" }
        : data.servers.length === 0
          ? { status: "neutral" as Status, label: "No project connectors" }
          : { status: "ok" as Status, label: plural(data.servers.length, "project connector") };

  const body = !workspace ? (
    <EmptyState title="Workspace unavailable" body="This Paseo workspace no longer exists." />
  ) : workspaceQuery.isLoading ? (
    <Loading label="Reading this project's connectors…" />
  ) : workspaceQuery.error && !data ? (
    <Notice tone="error">
      <View style={{ gap: t.space.sm }}>
        <Text style={t.text.body}>{errorText(workspaceQuery.error)}</Text>
        <View style={{ flexDirection: "row" }}>
          <Button label="Retry" onPress={refresh} />
        </View>
      </View>
    </Notice>
  ) : server && data ? (
    <View style={{ gap: t.space.section }}>
      <View style={{ flexDirection: "row" }}>
        <Button label={`← Workspace ${MCP_NAME_LOWER}`} variant="ghost" onPress={() => setSelected(null)} />
      </View>
      <View style={{ gap: t.space.sm }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
          <Text style={[t.text.display, { flexShrink: 1 }]} numberOfLines={1}>{server.name}</Text>
          <Tag label={server.transport} />
          {projectOauthAccounts.length > 0 ? <Tag label={`sign-in on ${projectOauthAccounts.length}`} /> : null}
        </View>
        {server.detail ? <Text style={t.text.caption}>{server.detail}</Text> : null}
      </View>
      {server.authStyle === "inline-credentials" ? (
        <Notice tone="ok">This project's server already includes its key; no sign-in needed here.</Notice>
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
    <View style={{ gap: t.space.section }}>
      {workspaceStale ? (
        <StaleNote what="this workspace" at={readAt(workspaceQuery.dataUpdatedAt)} reason={errorText(workspaceQuery.error)} onRetry={refresh} />
      ) : null}
      {switchProvider ? (
        <AgentServers
          data={agentServersQuery.data}
          loading={agentServersQuery.isLoading}
          error={agentServersQuery.error}
          providerLabel={providerName(agentServersQuery.data?.scope?.provider ?? switchProvider)}
          onToggle={(name, enabled) => setEnabledMutation.mutate({ name, enabled })}
          toggling={setEnabledMutation.isPending ? setEnabledMutation.variables?.name ?? null : null}
          toolsByName={toolsByName}
          signIn={(entry) => authFor(entry.name, agentServersQuery.data?.account ?? null, entry.inlineCredentials, entry.transport)}
        />
      ) : null}
      <Section title="This project's own connectors">
      <Facts
        items={[
          { value: data.configPath || "No .mcp.json file" },
          { value: plural(data.servers.length, "project connector") },
        ]}
      />
      <Card padded={false}>
        {data.servers.length === 0 ? (
          <EmptyState
            title={data.configPath ? "No connectors of its own" : "This project has no connectors of its own"}
            body={data.configPath ? "Its .mcp.json file is there but lists no connectors." : "A project lists its own connectors in a file called .mcp.json in its top folder."}
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
      </Section>
    </View>
  ) : null;

  const pad = t.compact ? 16 : 24;
  return (
    <View style={{ flex: 1, backgroundColor: t.color.surface0 }}>
      <View style={{ padding: pad, paddingBottom: t.space.row, gap: t.space.row, width: "100%", maxWidth: t.maxWidth, alignSelf: "center" }}>
        <Header title={workspace?.name ?? `Workspace ${MCP_NAME_LOWER}`} status={pill} caption={`${caption} · on ${host.label}`} icon={agentId ? "Bot" : "FolderCode"} />
        {intro}
        {signInFocus && agentId ? (
          <SignInFocus
            server={signInFocus}
            entry={agentServersQuery.data?.servers.find((entry) => entry.name === signInFocus) ?? null}
            reading={agentServersQuery.isLoading}
            rows={(entry) => authFor(entry.name, agentServersQuery.data?.account ?? null, entry.inlineCredentials, entry.transport)}
            onDismiss={() => setSignInFocus(agentId, null)}
          />
        ) : null}
        {data && !server ? <WorkspaceContext data={data} providerId={providerId} attention={attention} added={agentId ? agentServersQuery.data?.pluginServers : undefined} /> : null}
        {data && !server ? chatSection : null}
        <HealthSummary directory={workspace?.directory ?? ""} names={loaded} />
        <View style={{ flexDirection: "row" }}>
          <Button label="Refresh" variant="ghost" loading={workspaceQuery.isFetching || healthQuery.isFetching} onPress={refresh} />
        </View>
      </View>
      <Screen t={t} paddingTop={t.space.xs}>{body}</Screen>
    </View>
  );
}
