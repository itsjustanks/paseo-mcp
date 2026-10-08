/** Connectors (MCP servers): their settings, health and sign-ins, kept together per connector. */
import type { PluginSurfaceProps, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc, useWorkspace } from "@getpaseo/plugin/client";
import * as HostRN from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { z } from "zod";
import {
  healthNeedsAttention,
  resultNeedsAttention,
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
  type McpHealth,
  type McpHealthStatus,
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
import { BUILT_IN_LABEL, BUILT_IN_NOTE } from "../shared/builtin";
import { SERVER_FILTERS, appsLine, healthPlainNote, localRemoveCommand, projectFilesFor, providerName, removePlan, serverGallery, signInState, type RemovePlan, type RemoveScope, type ServerCardModel, type ServerFilter } from "../shared/servers";
import { COPY_ALL_EXPLAINER, COPY_ALL_LABEL } from "../shared/copy-all";
import { overviewNextStep, overviewVerdict, type OverviewTarget } from "../shared/overview";
import { HELP_QUESTIONS, HOW_IT_WORKS_QUESTION, MCP_NAME, MCP_NAME_LOWER, PROJECTS_LINE, WHAT_CONNECTORS_ARE, type HelpTarget } from "../shared/guide";
import { addServerRequest, checkNowRequest, filterRequest, tabFromParams, type ScreenFilter, type ScreenTab } from "../shared/screen-params";
import { summarizeTools } from "../shared/tools";
import { hostModal } from "../shared/host-features";
import { redactSecrets } from "../shared/redact";
import { openRemoveSession, type RemoveSession } from "../shared/remove-dialog";
import { EVERYWHERE, EVERYWHERE_LINE, homeRelative, scopeLabel, scopeOrder, shadowLine, sourceLabel, thisProject } from "../shared/scope";
import { JSON_EDIT_START, REVEAL_START, jsonDirty, jsonEditReducer, jsonToSave, jsonVersion, revealReducer, revealedValue } from "../shared/json-edit";
import { formatIssue } from "../shared/issues";
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
import { LoadDetails, pickLoad } from "./budget";
import { CatalogGallery, CopyCatalogEntryButton } from "./catalog";
import { CopyAllPanel } from "./copy-all";
import { ServerHealthTag, healthCheckedLabel, healthStatus, healthWord, splitIssues, useHealth } from "./health";
import { setSignInFocus, useSignInFocus } from "./focus";
import { canOpenMcp, canSyncTab, openMcp, openMcpAdd, syncTab, takePendingAdd, takePendingServer, type AddStart } from "./navigate";
import { GuideParts, OverviewGuide } from "./guide";
import { useOpenLink } from "./links";
import { AskAgentButton } from "./ask";
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
  useToast,
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
          {redactSecrets(item)}
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

/**
 * The Fields tab (0.20.0 review): masked and read-only first, like the JSON
 * tab. "Reveal to edit" loads the real values into the form's own buffer;
 * Hide keys, Close or leaving drops them. Save sends only revealed values, and
 * the host refuses masked text anyway.
 */
/** What the Fields form saves (0.20.0): the values, the version they were revealed at, and which changed since. */
type FieldsSave = {
  kind: Kind;
  url: string;
  command: string;
  kvLines: string;
  version?: string;
  changed?: { kind: boolean; command: boolean; url: boolean; kvLines: boolean };
};

function FieldsEditor({
  row,
  loadRaw,
  saving,
  onDirty,
  onSave,
}: {
  row: McpDefRow;
  loadRaw: () => Promise<McpDefRow | null>;
  saving: boolean;
  onDirty: (dirty: boolean) => void;
  onSave: (input: FieldsSave) => void;
}) {
  const t = useTokens();
  const [state, dispatch] = React.useReducer(revealReducer<McpDefRow>, REVEAL_START);
  useEffect(() => () => onDirty(false), [onDirty]);
  const reveal = () => {
    dispatch({ type: "reveal-start" });
    loadRaw()
      .then((raw) => dispatch(raw ? { type: "revealed", value: raw } : { type: "reveal-failed", error: "Couldn't read these settings. Try again." }))
      .catch(() => dispatch({ type: "reveal-failed", error: "Couldn't read these settings. Try again." }));
  };
  const raw = revealedValue(state);
  if (!raw) {
    const shown = [`${row.kind === "http" ? "URL" : "Command"}: ${row.kind === "http" ? row.url : row.command}`, row.kvLines ? `${row.kind === "http" ? "Headers" : "Environment"}:\n${row.kvLines}` : ""].filter(Boolean).join("\n");
    return (
      <View style={{ gap: t.space.row }}>
        <CodeBlock copy={false}>{shown}</CodeBlock>
        <Text style={t.text.caption}>These can't be changed here. Reveal to edit loads the real settings; Hide keys, Close or leaving forgets them.</Text>
        <View style={{ flexDirection: "row", gap: t.space.sm }}>
          <Button label="Reveal to edit" loading={state.mode === "masked" && state.loading} onPress={reveal} />
        </View>
        {state.mode === "masked" && state.error ? <ErrorText>{state.error}</ErrorText> : null}
      </View>
    );
  }
  return (
    <FieldsForm
      row={raw}
      saving={saving}
      onDirty={onDirty}
      onSave={onSave}
      onHide={() => {
        onDirty(false);
        dispatch({ type: "hide" });
      }}
    />
  );
}

function FieldsForm({
  row,
  saving,
  onDirty,
  onSave,
  onHide,
}: {
  row: McpDefRow;
  saving: boolean;
  onDirty: (dirty: boolean) => void;
  onSave: (input: FieldsSave) => void;
  onHide: () => void;
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
        hint="One KEY=value per line."
      />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm }}>
        <Button
          label="Save this destination"
          variant="primary"
          loading={saving}
          disabled={!dirty}
          onPress={() =>
            // The revealed version and what changed since Reveal go with it (0.20.0): unchanged fields stay as stored.
            onSave({ kind, url, command, kvLines, ...(row.version ? { version: row.version } : {}), changed: { kind: kind !== row.kind, command: command !== row.command, url: url !== row.url, kvLines: kvLines !== row.kvLines } })
          }
        />
        <Button label="Hide keys" variant="ghost" onPress={onHide} />
      </View>
    </View>
  );
}

/**
 * The JSON tab. Save stays shut until the buffer both differs and has come back
 * clean from the daemon, and any keystroke throws the verdict away — a pass from
 * two edits ago is not permission to write.
 */
/**
 * The definition as JSON (0.20.0 review): a masked, read-only view first.
 * "Reveal to edit" loads the real definition into its own buffer, and Save
 * sends only that buffer; "Hide keys", Close or leaving the page drops it
 * (shared/json-edit.ts). The masked text is never edited, so it is never saved.
 */
function JsonEditor({
  masked,
  nativePreview,
  loadRaw,
  onDirty,
  onPut,
}: {
  masked: string;
  nativePreview: string;
  loadRaw: () => Promise<{ json: string; version?: string } | null>;
  onDirty: (dirty: boolean) => void;
  onPut: (json: string, dryRun: boolean, version?: string) => Promise<PutResult | null>;
}) {
  const t = useTokens();
  const [state, dispatch] = React.useReducer(jsonEditReducer, JSON_EDIT_START);
  const [verdict, setVerdict] = useState<PutResult | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [busy, setBusy] = useState<"validate" | "preview" | "save" | null>(null);
  const dirty = jsonDirty(state);
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  // Leaving drops the raw buffer with the component; say the page is clean again.
  useEffect(() => () => onDirty(false), [onDirty]);

  const reveal = () => {
    dispatch({ type: "reveal-start" });
    loadRaw()
      .then((raw) => dispatch(raw === null ? { type: "reveal-failed", error: "Couldn't read this definition. Try again." } : { type: "revealed", raw: raw.json, ...(raw.version ? { version: raw.version } : {}) }))
      .catch(() => dispatch({ type: "reveal-failed", error: "Couldn't read this definition. Try again." }));
  };
  const hide = () => {
    dispatch({ type: "hide" });
    setVerdict(null);
    setShowPreview(false);
  };
  const run = async (job: "validate" | "preview" | "save") => {
    const json = jsonToSave(state);
    if (json === null) return;
    setBusy(job);
    const result = await onPut(json, job !== "save", jsonVersion(state));
    setBusy(null);
    if (!result) return;
    setVerdict(result);
    setShowPreview(job === "preview");
    if (job === "save" && result.ok) dispatch({ type: "saved", text: json });
  };

  if (state.mode === "masked") {
    return (
      <View style={{ gap: t.space.row }}>
        <CodeBlock copy={false}>{masked.trimEnd()}</CodeBlock>
        <Text style={t.text.caption}>This view can't be edited. Reveal to edit loads the real definition to change; Hide keys, Close or leaving forgets it.</Text>
        <View style={{ flexDirection: "row", gap: t.space.sm }}>
          <Button label="Reveal to edit" loading={state.loading} onPress={reveal} />
        </View>
        {state.error ? <ErrorText>{state.error}</ErrorText> : null}
      </View>
    );
  }
  const buffer = state.buffer;
  return (
    <View style={{ gap: t.space.row }}>
      <Field
        label="Definition"
        value={buffer}
        onChangeText={(next) => {
          dispatch({ type: "edit", text: next });
          setVerdict(null);
          setShowPreview(false);
        }}
        multiline
        mono
        minHeight={t.text.mono.lineHeight * 14}
        hint="Claude's shape, whatever the destination stores. Preview shows the translation."
      />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm }}>
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
            dispatch({ type: "revert" });
            setVerdict(null);
            setShowPreview(false);
          }}
        />
        <Button label="Hide keys" variant="ghost" onPress={hide} />
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
            {/* The host masks keys in the preview; the saved text may show them, so it gets no Copy. */}
            <CodeBlock copy={Boolean(verdict.preview)}>{verdict.preview || nativePreview}</CodeBlock>
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
  loadRaw,
  loadRawFields,
  onCopyEverywhere,
  onClose,
}: {
  tab: "fields" | "json";
  onTab: (tab: "fields" | "json") => void;
  defRow?: McpDefRow;
  rawRow?: RawDefRow;
  saving: boolean;
  otherCount: number;
  onSaveFields: (input: FieldsSave) => void;
  onPut: (json: string, dryRun: boolean, version?: string) => Promise<PutResult | null>;
  loadRaw: () => Promise<{ json: string; version?: string } | null>;
  loadRawFields: () => Promise<McpDefRow | null>;
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
            loadRaw={loadRawFields}
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
          masked={rawRow.json}
          nativePreview={rawRow.nativePreview}
          loadRaw={loadRaw}
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
                        {/* "Copy link" below is the one way to copy it. */}
                        {session.url ? <CodeBlock copy={false}>{session.url}</CodeBlock> : null}
                        <View style={{ flexDirection: "row", gap: t.space.sm }}>
                          {session.url ? (
                            <>
                              <Button label="Open sign-in" icon="ExternalLink" onPress={() => openLinkInBrowser(session.url)} />
                              <Button label="Copy link" onPress={() => void copyToClipboard(session.url).then(onCopied)} />
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

/**
 * What one agent loads here, one row per connector, with the per-workspace
 * switch its app actually has. Claude: `disabledMcpServers` for user and local
 * connectors, the `.mcp.json` approval lists for project ones. Codex: only the
 * connectors the hook injects can be left out. Anything else shows its state;
 * why there is no switch is under Technical details. State is read from the
 * config on every call, so a `/mcp disable` in a terminal shows up on the next
 * refresh.
 *
 * 0.19.2: plain rows (name, health, where it comes from); broken ones first.
 * Transport, file names and each switch's mechanics moved to Technical details.
 */
function AgentServers({
  data,
  loading,
  error,
  onToggle,
  toggling,
  toolsByName,
  health,
  signIn,
  projectName,
  onAddHere,
}: {
  data: z.output<typeof mcpAgentServers.output> | undefined;
  loading: boolean;
  error: unknown;
  onToggle: (name: string, enabled: boolean) => void;
  toggling: string | null;
  toolsByName: Map<string, McpServerTools> | null;
  health: ReadonlyMap<string, McpHealth> | null;
  signIn: (server: AgentServer) => React.ReactNode;
  /** 0.20.0: for "This project · <name>". */
  projectName: string;
  /** 0.20.0: opens Add on "This project" with this project picked; absent where the page can't be opened. */
  onAddHere?: () => void;
}) {
  const t = useTokens();
  // 0.19.2: a 401 is how a working sign-in connector answers the check, so the word comes from this chat's account.
  const word = (name: string, result: McpHealth): { status: Status; label: string } => {
    if (result.status !== "auth-required") return { status: healthStatus(result.status), label: healthWord(result.status) };
    const state = data?.account?.authStatus[name];
    if (data?.account?.needsAuth.includes(name) || state === "not-connected") return { status: "attention", label: "Needs sign-in" };
    return state === "connected" ? { status: "ok", label: "Signed in" } : { status: "neutral", label: "Uses sign-in" };
  };
  if (loading && !data) return <Loading label="Checking…" />;
  if (error && !data) return <ErrorText>{errorText(error)}</ErrorText>;
  if (!data) return null;
  const rank = (entry: AgentServer) => {
    const result = health?.get(entry.name);
    if (!result || !resultNeedsAttention(result)) return 2;
    return result.status === "down" || result.status === "binary-missing" ? 0 : 1;
  };
  // 0.20.0: what this project adds first, then what every project gets.
  const sorted = [...data.servers].sort((a, b) => rank(a) - rank(b) || scopeOrder(a.scope) - scopeOrder(b.scope) || a.name.localeCompare(b.name));
  const here = sorted.filter((entry) => entry.scope !== "user");
  const everywhere = sorted.filter((entry) => entry.scope === "user");
  const anySwitch = data.servers.some((entry) => entry.enabled.writable);
  const provider = data.scope?.provider ?? "";
  const row = (entry: AgentServer, index: number) => {
    const tools = toolsByName?.get(entry.name);
    const off = entry.enabled.state === "disabled";
    const result = health?.get(entry.name);
    const problem = result && resultNeedsAttention(result) ? result : null;
    const shadow = shadowLine(entry.scope, entry.shadows ?? [], provider);
    return (
      <Row
        key={entry.name}
        first={index === 0}
        tone={problem ? healthStatus(problem.status) : undefined}
        title={<Text numberOfLines={1} style={[t.text.bodyStrong, { opacity: off ? 0.6 : 1 }]}>{entry.name}</Text>}
        meta={
          <View style={{ gap: t.space.hair }}>
            <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: t.space.sm }}>
              {result?.builtIn ? <Tag label={BUILT_IN_LABEL} /> : result ? <StatusPill {...word(entry.name, result)} /> : null}
              <Text style={t.text.caption}>{off ? `Off in this project · ${sourceLabel(entry.scope, entry.configPath)}` : sourceLabel(entry.scope, entry.configPath)}</Text>
              {entry.enabled.state === "undecided" ? <Tag label="Asks when a chat starts" tone="attention" /> : null}
              {tools && tools.kind === "listed" ? <Text style={t.text.caption}>{toolsWord(tools)}</Text> : null}
            </View>
            {shadow ? <Text style={t.text.caption}>{shadow}</Text> : null}
          </View>
        }
        trailing={
          entry.enabled.writable ? (
            <Toggle
              label={`${entry.name} ${off ? "off" : "on"} in this project`}
              value={!off}
              loading={toggling === entry.name}
              disabled={toggling !== null}
              onChange={(next) => onToggle(entry.name, next)}
            />
          ) : problem && canOpenMcp() ? (
            <Button label="Fix" onPress={() => openMcp(entry.name)} />
          ) : undefined
        }
        expanded={signIn(entry)}
      />
    );
  };
  const group = (title: string, line: string, children: React.ReactNode, action?: React.ReactNode) => (
    <View style={{ gap: t.space.sm }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
        <View style={{ flex: 1, minWidth: 0, gap: t.space.hair }}>
          <Text style={t.text.bodyStrong}>{title}</Text>
          <Text style={t.text.caption}>{line}</Text>
        </View>
        {action}
      </View>
      {children}
    </View>
  );
  return (
    <View style={{ gap: t.space.row }}>
      {anySwitch ? <Text style={t.text.caption}>{`A switch changes what new chats in this project load. ${SWITCH_EFFECT_NOTE}`}</Text> : null}
      {group(
        thisProject(projectName),
        here.length > 0 ? `What this project adds: ${plural(here.length, "connector")}.` : data.projectIncluded ? "Nothing is set up just for this project." : data.projectNote ? `${data.projectNote}.` : "Nothing is set up just for this project.",
        here.length > 0 ? <Card padded={false}>{here.map(row)}</Card> : null,
        onAddHere ? <Button label="Add here" icon="Plus" variant="ghost" onPress={onAddHere} /> : undefined,
      )}
      {group(
        EVERYWHERE,
        everywhere.length > 0 || data.paseoTools ? "What every project gets." : "Nothing is set up everywhere for this chat's AI app.",
        everywhere.length > 0 || data.paseoTools ? (
          <Card padded={false}>
            {everywhere.map(row)}
            {data.paseoTools ? <PaseoToolsAgentRow info={data.paseoTools} providerLabel={providerName(provider)} first={everywhere.length === 0} /> : null}
          </Card>
        ) : null,
      )}
      {(data.pluginServers ?? []).length > 0
        ? group(
            "Added when this chat started",
            "By another plugin, for this chat only.",
            <Card padded={false}>
              {(data.pluginServers ?? []).map((entry, index) => (
                <PluginServerRow key={`plugin:${entry.name}`} entry={entry} first={index === 0} />
              ))}
            </Card>,
          )
        : null}
    </View>
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
          <Tag label="Added when the chat started" />
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
  // 0.20.0: Claude's "just for you" copies are read only here; the note says how to remove them in Claude Code.
  const local = (server.localIn ?? []).filter((entry) => destinations.some((dest) => dest.id === entry.destId));
  const everywhereCount = present.length + projectFiles.length;
  if (present.length === 0 && projectFiles.length === 0 && local.length === 0) return null;
  return (
    <View style={{ gap: t.space.sm }}>
      {local.length > 0 ? <LocalCopyNote name={server.name} local={local} /> : null}
      {present.length === 0 && projectFiles.length === 0 ? null : !armed ? (
        <View style={{ gap: t.space.sm }}>
          <Text style={t.text.body}>You'll see exactly what's removed before anything changes.</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: t.space.sm }}>
            {present.length > 1 ? <Button label="From one app…" variant="danger" disabled={pending} onPress={() => onArm({ scope: "one" })} /> : null}
            {present.length > 0 ? <Button label={present.length > 1 ? `From all ${plural(present.length, "app")}` : "From this app"} variant="danger" disabled={pending} onPress={() => onArm({ scope: present.length > 1 ? "all" : "one" })} /> : null}
            {projectFiles.length > 0 ? <Button label={`From all apps and project files (${everywhereCount})`} variant="danger" disabled={pending} onPress={() => onArm({ scope: "everywhere" })} /> : null}
          </View>
        </View>
      ) : (
        // Mounted per opening, so closing drops everything it chose (0.20.0).
        <RemoveConfirm server={server} destinations={destinations} projectFiles={projectFiles} scope={armed.scope} pending={pending} onClose={() => onArm(null)} onRemove={onRemove} />
      )}
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

/**
 * Claude Code's "just for you" copy (0.20.0): read only, because Claude Code
 * rewrites ~/.claude.json constantly and a plugin can't change it safely. The
 * note gives the command that removes it in Claude Code, with Copy, and Ask an
 * agent to run it in a chat you pick.
 */
function LocalCopyNote({ name, local }: { name: string; local: Array<{ destId: string; project: string }> }) {
  const t = useTokens();
  const projects = [...new Set(local.map((entry) => entry.project))];
  const commands = projects.map((project) => localRemoveCommand(name, project)).join("\n");
  const message = `Please remove the MCP connector "${name}" from Claude Code's "just for you" (local) scope. Run this, then check it's gone with: claude mcp list\n${commands}`;
  return (
    <Notice tone="attention">
      <View style={{ gap: t.space.sm }}>
        <Text style={t.text.body}>{`Claude Code's "just for you" copy stays. Remove it in Claude Code with claude mcp remove ${name} -s local, run in ${projects.length === 1 ? "that project's folder" : "each project's folder"}:`}</Text>
        <CodeBlock>{commands}</CodeBlock>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm }}>
          <AskAgentButton message={message} />
        </View>
      </View>
    </Notice>
  );
}

type HostModalComponent = React.FC<{ title: string; open: boolean; onOpenChange(open: boolean): void; children: React.ReactNode }> & {
  Content: React.ComponentType<{ children: React.ReactNode }>;
};
/** The app's dialog where it has one (chosen once, never per render); otherwise the confirm stays in the page. */
const HostModal = hostModal<HostModalComponent>(HostRN);

/**
 * The ask-first step of Remove (0.20.0): the app's own dialog, titled short
 * (the app cuts a long title; the first line says where from). One session
 * per opening holds the app picked and a single-use Confirm. On a phone the
 * app draws the dialog's content as a sheet outside this screen's tree, so the
 * tokens are handed in again, inside it.
 */
function RemoveConfirm({
  server,
  destinations,
  projectFiles,
  scope,
  pending,
  onClose,
  onRemove,
}: {
  server: McpServerRow;
  destinations: Destination[];
  projectFiles: { project: string; path: string }[];
  scope: RemoveScope;
  pending: boolean;
  onClose: () => void;
  onRemove: (plan: RemovePlan) => void;
}) {
  const t = useTokens();
  const session = useRef<RemoveSession | null>(null);
  session.current ??= openRemoveSession({ server, destinations, projectFiles, scope, onRemove });
  const [, redraw] = useState(0);
  const current = session.current;
  const plan = current.plan();
  const present = destinations.filter((dest) => server.presentIn.includes(dest.id));
  const body = (
    <View style={{ gap: t.space.row }}>
      {scope === "one" && present.length > 1 ? (
        <Segmented
          value={current.destId()}
          onChange={(destId) => {
            current.select(destId);
            redraw((count) => count + 1);
          }}
          options={present.map((dest) => ({ value: dest.id, label: dest.label }))}
        />
      ) : null}
      {plan ? (
        <View style={{ gap: t.space.sm }}>
          {plan.lines.map((line, index) => (
            <Text key={index} style={t.text.body}>{line}</Text>
          ))}
        </View>
      ) : (
        <Text style={t.text.body}>Nothing to remove there.</Text>
      )}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm }}>
        {plan ? <Button label={plan.confirmLabel} variant="danger" loading={pending} onPress={() => void current.confirm()} /> : null}
        <Button label="Cancel" variant="ghost" onPress={onClose} />
      </View>
    </View>
  );
  if (!HostModal) {
    // An app without a dialog: the confirm in the page, as before 0.20.0.
    return (
      <Notice tone="error">
        <View style={{ gap: t.space.sm }}>
          <Text style={t.text.bodyStrong}>{`Remove ${server.name}?`}</Text>
          {body}
        </View>
      </Notice>
    );
  }
  return (
    <HostModal title={`Remove ${server.name}?`} open onOpenChange={(open) => (open ? undefined : onClose())}>
      <HostModal.Content>
        <TokensProvider value={t}>{body}</TokensProvider>
      </HostModal.Content>
    </HostModal>
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
        {card.alsoIn ? <Text numberOfLines={2} style={{ ...TYPE.secondary, color: t.color.muted }}>{card.alsoIn}</Text> : null}
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
/** A broken connector in a sentence: what's wrong and what to do, without the check's raw message (0.19.2). */
function brokenLine(status: McpHealthStatus): string {
  return status === "binary-missing"
    ? "The program it needs isn't on this computer. Fix it by changing what it runs, or remove it if you don't use it."
    : "It didn't answer when checked. Fix its address or key, or remove it if you don't use it.";
}

function heroFor(status: Status, target: OverviewTarget, facts: { state: string; staleAt: string | null; servers: number; signIn: number }): { tone: Status; icon: string; action?: string } {
  if (facts.state === "error") return { tone: "error", icon: "CircleAlert", action: "RefreshCw" };
  if (facts.state === "loading") return { tone: "neutral", icon: "Loader", action: "RefreshCw" };
  if (facts.staleAt) return { tone: "attention", icon: "Clock", action: "RefreshCw" };
  if (facts.servers === 0) return { tone: "neutral", icon: "Plus", action: "Plus" };
  // Still checking (0.19.2): no verdict yet, so no alarm colour.
  if (status === "neutral") return { tone: "neutral", icon: "Loader", action: "Plug" };
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
      <McpBody
        key={host.id}
        theme={theme}
        layout={layout}
        host={host}
        addRequest={addServerRequest(params)}
        checkRequest={checkNowRequest(params)}
        tabParam={tabFromParams(params)}
        filterRequest={filterRequest(params)}
      />
    </TokensProvider>
  );
}

function McpBody({
  layout,
  host,
  addRequest,
  checkRequest,
  tabParam,
  filterRequest: filterAsked,
}: PluginSurfaceProps & { addRequest: string | null; checkRequest: string | null; tabParam: ScreenTab | null; filterRequest: { filter: ScreenFilter; at: string } | null }) {
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

  const [section, setSection] = useState<SectionId>(tabParam ?? (filterAsked ? "servers" : "overview"));
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>(filterAsked?.filter ?? "all");
  const [mode, setMode] = useState<Mode>("add");
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editTab, setEditTab] = useState<"fields" | "json">("fields");
  const [revealed, setRevealed] = useState(false);
  const [exportRevealed, setExportRevealed] = useState(false);
  const [renameTo, setRenameTo] = useState("");
  // 0.19.2: Fix and Remove on a broken connector's page open their fold-out.
  const [detailFocus, setDetailFocus] = useState<"apps" | "remove" | null>(null);
  // 0.15.0: "Copy to all my AI apps" opens its preview in place of the section.
  const [copyOpen, setCopyOpen] = useState(false);
  // 0.19.0: Help's "Save a backup" opens the backup fold-out at the bottom of the Connectors tab.
  const [extraOpen, setExtraOpen] = useState<"backup" | null>(null);
  // 0.12.0: "Add server" opens the catalogue gallery in place of the list.
  const [catalogOpen, setCatalogOpen] = useState(addRequest !== null);
  // 0.20.0: where Add starts: "This project" from a workspace or the Projects tab, "Everywhere" from Connectors.
  const [addStart, setAddStart] = useState<AddStart | null>(null);
  const openAdd = (start: AddStart) => {
    setAddStart(start);
    setCatalogOpen(true);
  };
  // The sidebar "+" (0.11): each press carries a new `at`, so the gallery opens again even while the page is open.
  useEffect(() => {
    if (addRequest === null) return;
    setCopyOpen(false);
    setSection("servers");
    setSelected(null);
    setCatalogOpen(true);
  }, [addRequest]);

  // The sidebar dot's popover (0.19.2): "Show them" opens Connectors on that filter, again on each press.
  const filterAt = filterAsked ? `${filterAsked.filter}@${filterAsked.at}` : null;
  useEffect(() => {
    if (!filterAsked) return;
    setCopyOpen(false);
    setCatalogOpen(false);
    setSection("servers");
    setSelected(null);
    setFilter(filterAsked.filter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterAt]);
  // The tab lives in the screen's params on Paseo 0.11, so the window title follows it (0.19.2).
  const shownTab = section === "transfer" ? "servers" : section;
  const paramTab = tabParam ?? (addRequest !== null || filterAsked ? "servers" : "overview");
  useEffect(() => {
    if (canSyncTab() && shownTab !== paramTab) syncTab(shownTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownTab]);

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
    setDetailFocus(null);
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
    const add = takePendingAdd();
    if (add) {
      setSection("servers");
      openAdd(add);
    }
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
    mutationFn: (input: FieldsSave & { destId: string }) =>
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

  // "Reveal to edit": the real definition for one destination, read only when asked and kept only by its editor.
  const loadRawJson = async (destId: string): Promise<{ json: string; version?: string } | null> => {
    const result = await callRawGet({ name: selected as string, reveal: true });
    const row = result.rows.find((entry) => entry.destId === destId && entry.found);
    return row ? { json: row.json, ...(row.version ? { version: row.version } : {}) } : null;
  };
  // "Reveal to edit" on the Fields tab: the real values for one destination, kept only by its form.
  const loadRawFields = async (destId: string): Promise<McpDefRow | null> => {
    const result = await callDefAll({ name: selected as string, reveal: true });
    return result.rows.find((row) => row.destId === destId && row.found) ?? null;
  };
  const putJson = async (destId: string, json: string, dryRun: boolean, version?: string): Promise<PutResult | null> => {
    try {
      const result = await callRawPut({ name: selected as string, destId, json, dryRun, ...(version ? { version } : {}) });
      if (!dryRun) report(result);
      return result;
    } catch (error) {
      fail(error);
      return null;
    }
  };

  // ------------------------------------------------------------ derived state

  const query = search.trim().toLowerCase();
  // 0.19.2: tools that come with the Codex app are listed on their own and never counted: not as broken, missing or to sign in to.
  const ownServers = servers.filter((server) => !server.builtIn && !health?.get(server.name)?.builtIn);
  const builtInServers = servers.filter((server) => !ownServers.includes(server));
  const gapServers = ownServers.filter((server) => server.presentIn.length < destinations.length);
  const isIssue = (server: McpServerRow) => {
    const entry = health?.get(server.name);
    return Boolean(entry && resultNeedsAttention(entry));
  };
  const issueServers = health ? ownServers.filter(isIssue) : [];
  const brokenServers = issueServers.filter((server) => {
    const status = health?.get(server.name)?.status;
    return status === "down" || status === "binary-missing";
  });
  const projectServers = authQuery.data?.projectServers ?? [];
  const projectGroups = [...projectServers.reduce((groups, entry) => {
    const names = groups.get(entry.project) ?? [];
    names.push(entry.name);
    groups.set(entry.project, names);
    return groups;
  }, new Map<string, string[]>()).entries()];
  const signInOf = (server: McpServerRow) => signInState(server.name, accounts);
  const signInServers = ownServers.filter((server) => signInOf(server) === "needs");
  // Your servers as the Add gallery's "already have" rules read them (shared/catalog.ts alreadyHave).
  const owned = useMemo(() => servers.map(ownedFromRow), [servers]);
  // The Servers gallery: cards, what the filter and search keep, and each pill's count (shared/servers.ts).
  const gallery = serverGallery({ servers: ownServers, destinations, health, accounts, authRead: Boolean(authQuery.data), known: KNOWN_SERVERS, filter, query, projectServers });
  const toolTotals = toolsQuery.data ? summarizeTools(toolsQuery.data.servers) : null;

  const server = selected ? servers.find((entry) => entry.name === selected) : undefined;
  const serverHealth = server ? health?.get(server.name) : undefined;
  const serverTools = server ? toolsByName?.get(server.name) : undefined;
  // 0.20.0: a "just for you" copy only has nothing to copy from, so nothing is "missing".
  const localOnly = Boolean(server && server.presentIn.length === 0 && (server.localIn?.length ?? 0) > 0);
  const missing = server && !localOnly ? destinations.filter((dest) => !server.presentIn.includes(dest.id)) : [];
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
    servers: ownServers.length,
    broken: brokenServers.length,
    warnings: issueServers.length - brokenServers.length,
    signIn: signInServers.length,
    gaps: gapServers.length,
    checking: !health || !authQuery.data || Boolean(authQuery.data.checking),
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

  // ---------------------------------------------------------------- sections

  const toServers = (filter: Filter) => () => go("servers", { server: null, filter });

  // "a, b, c and 2 more": which connectors a line is about, without a wall of names.
  const nameList = (list: McpServerRow[]) => {
    const head = list.slice(0, 3).map((entry) => entry.name).join(", ");
    return list.length > 3 ? `${head} and ${list.length - 3} more` : head;
  };
  const connectedCount = servers.filter((entry) => signInOf(entry) === "connected").length;

  // At a glance, inside the hero: three questions, each with the one link to where it is dealt with (the calm standard:
  // at most four rows). 0.19.2: every row says "Checking…" until its read is in, never a word that changes a moment later.
  const checking = { value: "Checking…", status: "busy" as Status, hint: null };
  const authSettled = Boolean(authQuery.data) && !(authQuery.data?.checking && signInServers.length === 0);
  const glance = (
    <View style={{ gap: t.space.xs }}>
      <StatusLine
        label="Health"
        {...(!health
          ? healthQuery.error && !healthQuery.isFetching
            ? { value: "unavailable", status: "neutral" as Status, hint: errorText(healthQuery.error) }
            : checking
          : ownServers.length === 0
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
          ? checking
          : ownServers.length === 0
            ? { value: "no connectors yet", status: "neutral" as Status, hint: `${plural(destinations.length, "AI app and account", "AI apps and accounts")} found on ${host.label}` }
            : gapServers.length > 0
              ? { value: `${plural(gapServers.length, "connector")} missing from some apps`, status: "attention" as Status, hint: nameList(gapServers), action: { label: "Show", onPress: toServers("gaps") } }
              : { value: "every app has every connector", status: "ok" as Status, hint: `${plural(ownServers.length, "connector")} in ${plural(destinations.length, "AI app and account", "AI apps and accounts")}` })}
      />
      <StatusLine
        label="Sign-in"
        {...(!authSettled
          ? authQuery.error && !authQuery.data
            ? { value: "unavailable", status: "neutral" as Status, hint: errorText(authQuery.error) }
            : checking
          : signInServers.length > 0
            ? { value: `${signInServers.length} need sign-in`, status: "attention" as Status, hint: nameList(signInServers), action: { label: "Show", onPress: toServers("sign-in") } }
            : connectedCount > 0
              ? { value: "all signed in", status: "ok" as Status, hint: `${plural(connectedCount, "connector")} you sign in to, across ${plural(accounts.length, "account")}` }
              : { value: "none needed", status: "neutral" as Status, hint: "No connector here asks you to sign in" })}
      />
    </View>
  );

  // The hero says the state in words, then three rows (each with its own link), one muted line and ONE button
  // (0.19.2: there were six ways to the same list). Teaching folds into one "New to connectors?" link; AI Router is one line.
  const hero = heroFor(headerPill.status, nextStep.target, overviewFacts);
  const checkedLine = healthQuery.data ? healthCheckedLabel(healthQuery.data) : null;
  const overview = (
    <View style={{ gap: t.space.section }}>
      <HeroCard tone={hero.tone} icon={hero.icon} title={nextStep.title} lead={nextStep.detail}>
        {matrixQuery.isError && !matrixQuery.data ? <ErrorText>{errorText(matrixQuery.error)}</ErrorText> : null}
        {glance}
        {checkedLine ? <Text style={t.text.caption}>{`Health ${checkedLine}`}</Text> : null}
        {overviewFacts.state === "loading" ? null : (
          <View style={{ flexDirection: "row" }}>
            <Button
              label={nextStep.label}
              variant="primary"
              icon={hero.action}
              loading={nextStep.target.section === "refresh" && matrixQuery.isFetching}
              onPress={() => goTo(nextStep.target)}
            />
          </View>
        )}
      </HeroCard>
      <View style={{ gap: t.space.sm }}>
        <QuietLine icon="Info">{WHAT_CONNECTORS_ARE}</QuietLine>
        <OverviewGuide apps={appNames(destinations)} open={ready && ownServers.length === 0} onAdd={() => go("servers", { server: null })} onCopy={() => setCopyOpen(true)} />
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
        { value: `${plural(ownServers.length, "connector")} across ${plural(destinations.length, "app account")}` },
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
          {ownServers.length === 0 ? (
            <EmptyState
              title="No connectors yet"
              body={`None of your AI apps on ${host.label} has a connector yet. Add one from the gallery and it shows here.`}
              action={<Button label="Add a connector" variant="primary" onPress={() => setCatalogOpen(true)} />}
            />
          ) : (
            <EmptyState
              title="No connector matches"
              body={noMatchLine(ownServers.length, search, filter)}
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
        ok ? toast.show("Sign-in link copied.", { variant: "success" }) : toast.show("Couldn't copy. The link above is selectable.", { variant: "warning" })
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
  const serverBuiltIn = Boolean(server?.builtIn || serverHealth?.builtIn);
  const serverBroken = !serverBuiltIn && (serverHealth?.status === "down" || serverHealth?.status === "binary-missing");
  const serverPane = server ? (
    <View style={{ gap: t.space.section }}>
      {back}
      <Card>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: t.space.sm }}>
          <Text style={[t.text.display, { flexShrink: 1 }]} numberOfLines={1}>
            {server.name}
          </Text>
          {serverBuiltIn ? (
            <StatusPill status="neutral" label="Built in" />
          ) : serverHealth ? (
            <StatusPill status={healthStatus(serverHealth.status)} label={healthWord(serverHealth.status)} />
          ) : null}
        </View>
        <Text style={t.text.body}>{serverBuiltIn ? `${BUILT_IN_LABEL} · In Codex` : `${kindWord} · ${appsWord}`}</Text>
        {/* 0.19.2: plain words here; the check's own message is under Technical details. */}
        {serverBuiltIn ? (
          <Text style={t.text.body}>{BUILT_IN_NOTE}</Text>
        ) : serverHealth && resultNeedsAttention(serverHealth) ? (
          <Text style={t.text.body}>{serverBroken ? brokenLine(serverHealth.status) : healthPlainNote(serverHealth.status)}</Text>
        ) : null}
        {serverBuiltIn ? null : (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm }}>
            {serverBroken ? (
              // A broken connector's main button fixes or removes it; adding it to more apps would spread the problem.
              <>
                <Button label="Fix" icon="Wrench" variant="primary" onPress={() => { setDetailFocus("apps"); setEditing(server.presentIn[0] ?? null); setEditTab("fields"); }} />
                <Button label="Remove" icon="Trash2" onPress={() => setDetailFocus("remove")} />
              </>
            ) : missing.length > 0 ? (
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
        )}
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
              : toast.show("Couldn't copy. The link above is selectable.", { variant: "warning" })
          }
        />
      ) : null}

      {/* Keyed by connector, so each page starts folded (a fold-out left open on one connector stayed open on the next). */}
      <Accordion key={server.name}>
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
        <AccordionItem
          key={`apps-${detailFocus === "apps" ? "focus" : ""}`}
          icon="Bot"
          title="Your AI apps"
          summary={serverBuiltIn ? "In Codex" : missing.length > 0 ? `${appsWord} · missing from ${plural(missing.length, "app")}` : appsWord}
          open={detailFocus === "apps" || (!serverBuiltIn && !serverBroken && missing.length > 0)}
        >
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
                  ) : serverBuiltIn ? (
                    <Tag label="Codex only" />
                  ) : localOnly ? (
                    <Tag label="Not in this app" />
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
                        onPut={(json, dryRun, version) => putJson(dest.id, json, dryRun, version)}
                        loadRaw={() => loadRawJson(dest.id)}
                        loadRawFields={() => loadRawFields(dest.id)}
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
{serverBuiltIn ? null : (
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
        )}
        <AccordionItem icon="SlidersHorizontal" title="Technical details" summary="Its address, saved keys, and copies to share">
          <Facts
            items={[
              server.detail ? { value: server.detail } : null,
              serverHealth?.note && serverHealth.status !== "ok" ? { value: `Last check: ${serverHealth.note}` } : null,
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
                      <CodeBlock copy={!revealed}>{rawRow.nativePreview}</CodeBlock>
                    </View>
                  ) : null;
                })}
            </View>
          ) : rawQuery.isFetching ? (
            <Loading label="Reading…" />
          ) : null}
        </AccordionItem>
        <AccordionItem key={`remove-${detailFocus === "remove" ? "focus" : ""}`} icon="Trash2" title="Remove" summary="From one app, or from all of them" tone="error" open={detailFocus === "remove"}>
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
      {builtInServers.length > 0 ? (
        <AccordionItem icon="Package" title={BUILT_IN_LABEL} summary={builtInServers.map((entry) => entry.name).join(", ")}>
          <Text style={t.text.body}>{BUILT_IN_NOTE}</Text>
          <Card padded={false} level={2}>
            {builtInServers.map((entry, index) => (
              <Row key={entry.name} first={index === 0} title={entry.name} meta={<Text style={t.text.caption}>{appsLine(entry.presentIn, destinations).line.split(" · ")[0]}</Text>} onPress={() => selectServer(entry.name)} />
            ))}
          </Card>
        </AccordionItem>
      ) : null}
      <AccordionItem icon="ChartColumn" title="Totals and last check" summary={`${plural(ownServers.length, "connector")} · ${plural(destinations.length, "app account")}`}>
        {summaryStrip}
      </AccordionItem>
    </Accordion>
  ) : null;

  const serversSection = server ? serverPane : catalogOpen ? (
    <CatalogGallery
      start={addStart}
      destinations={destinations}
      owned={owned}
      ownedReady={ready}
      onClose={() => {
        setCatalogOpen(false);
        setAddStart(null);
      }}
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
            <Button label="Add connector" icon="Plus" variant="primary" onPress={() => openAdd({ scope: "user" })} />
          </>
        }
      />
      {/* 0.20.0: where these live, once for the tab rather than on every card. */}
      <Text style={t.text.body}>{EVERYWHERE_LINE}</Text>
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
      <Toolbar actions={<Button label="Add to a project" icon="Plus" variant="primary" onPress={() => { setSection("servers"); openAdd({ scope: "project" }); }} />} />
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
              title={thisProject(project)}
              subtitle={names.join(", ")}
              meta={
                <View style={{ gap: t.space.hair }}>
                  <Facts items={[{ value: `${project} · .mcp.json` }, { value: plural(names.length, "connector") }]} />
                  {(() => {
                    // 0.20.0: a name this project shares with one set up everywhere.
                    const shared = names.filter((name) => ownServers.some((entry) => entry.name === name));
                    // Claude Code's order: your own "just for you" copy, then this project's, then everywhere's.
                    const ownHere = shared.filter((name) => ownServers.find((entry) => entry.name === name)?.localIn?.some((local) => local.project.split(/[\\/]/).pop() === project));
                    return shared.length > 0 ? (
                      <Text style={t.text.caption}>
                        {`Also set up everywhere: ${shared.join(", ")}. Claude Code uses this project's copy here${ownHere.length > 0 ? `, except where you have your own "just for you" copy (${ownHere.join(", ")}), which comes first` : ""}.`}
                      </Text>
                    ) : null;
                  })()}
                </View>
              }
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
  // 0.19.2: folded questions only, as in every plugin. How connectors work is one of them.
  const helpSection = (
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
      <AccordionItem icon="BookOpen" title={HOW_IT_WORKS_QUESTION}>
        <GuideParts apps={appNames(destinations)} onAdd={() => { go("servers", { server: null }); setCatalogOpen(true); }} onCopy={() => setCopyOpen(true)} />
      </AccordionItem>
    </Accordion>
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
          <Header
            title={MCP_NAME}
            status={headerPill}
            caption={ready ? `${plural(ownServers.length, "connector")} on ${host.label}` : `on ${host.label}`}
            // One Refresh, in the header (0.19.2, as in Memories): settings, health, sign-in and every connector's tool list.
            trailing={
              <Button
                label="Refresh"
                icon="RefreshCw"
                variant="ghost"
                loading={matrixQuery.isFetching || healthQuery.isFetching || authQuery.isFetching || toolsQuery.isFetching}
                onPress={() => {
                  refreshAll();
                  void toolsQuery.refetch();
                }}
              />
            }
          />
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
  caption = "Connectors for this project",
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
  const healthByName = useMemo(
    () => (healthQuery.data ? new Map(healthQuery.data.results.map((entry) => [entry.name, entry] as const)) : null),
    [healthQuery.data],
  );
  // What a chat here loads, by name (0.19.2: the switch list when it's read, so a connector switched off here
  // doesn't count), so problems split into "here" and "elsewhere" on the same basis as the list.
  const loaded = useMemo(() => {
    const list = agentServersQuery.data;
    if (list) {
      const names = new Set(list.servers.filter((entry) => entry.enabled.state !== "disabled").map((entry) => entry.name));
      for (const entry of list.pluginServers ?? []) names.add(entry.name);
      return names;
    }
    if (!data?.profile) return null;
    const names = new Set((pickLoad(data, providerId)?.servers ?? []).map((entry) => entry.name));
    for (const entry of data.profile.project) names.add(entry.name);
    return names;
  }, [agentServersQuery.data, data, providerId]);
  const account = agentServersQuery.data?.account ?? null;
  const problems = useMemo(() => {
    if (!healthQuery.data || !loaded) return null;
    const directory = workspace?.directory ?? "";
    const { issues, project } = splitIssues(healthQuery.data, directory);
    const broken = (entry: McpHealth) => entry.status === "down" || entry.status === "binary-missing";
    const here = issues.filter((entry) => loaded.has(entry.name) || (loaded.size === 0 && project.includes(entry))).sort((x, y) => Number(broken(y)) - Number(broken(x)) || x.name.localeCompare(y.name));
    const signIn = account ? [...loaded].filter((name) => (account.needsAuth.includes(name) || account.authStatus[name] === "not-connected") && !here.some((entry) => entry.name === name)).sort() : [];
    return { here, broken: here.filter(broken).length, signIn, elsewhere: issues.filter((entry) => !here.includes(entry)) };
  }, [healthQuery.data, loaded, account, workspace]);
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
          ok ? toast.show("Sign-in link copied.", { variant: "success" }) : toast.show("Couldn't copy. The link above is selectable.", { variant: "warning" })
        }
        bare
        onlyAccount={{ provider: account.provider, email: account.email }}
      />
    ) : null;
  const workspaceStale = workspaceQuery.isError && Boolean(data);
  // 0.19.2: the header says whether this chat's connectors work, "Checking…" until every read is in.
  const pill: { status: Status; label: string } = !workspace
    ? { status: "error", label: "Workspace unavailable" }
    : workspaceQuery.isError && !data
      ? { status: "error", label: "Host unavailable" }
      : !problems || (switchProvider !== "" && agentServersQuery.isLoading)
        ? { status: "neutral", label: "Checking…" }
        : problems.broken > 0
          ? { status: "error", label: `${problems.broken} broken` }
          : problems.here.length > 0
            ? { status: "attention", label: plural(problems.here.length, "warning") }
            : problems.signIn.length > 0
              ? { status: "attention", label: `${problems.signIn.length} need${problems.signIn.length === 1 ? "s" : ""} sign-in` }
              : { status: "ok", label: "All working" };

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
        <Button label="← Back" variant="ghost" onPress={() => setSelected(null)} />
      </View>
      <View style={{ gap: t.space.sm }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
          <Text style={[t.text.display, { flexShrink: 1 }]} numberOfLines={1}>{server.name}</Text>
          <ServerHealthTag name={server.name} />
        </View>
        <Text style={t.text.body}>{`This project's own connector · ${server.transport === "http" ? "on the web" : "runs on this computer"}`}</Text>
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
          ok ? toast.show("Sign-in link copied.", { variant: "success" }) : toast.show("Couldn't copy. The link above is selectable.", { variant: "warning" })
        }
      />
    </View>
  ) : data ? (
    <View style={{ gap: t.space.section }}>
      {workspaceStale ? (
        <StaleNote what="this workspace" at={readAt(workspaceQuery.dataUpdatedAt)} reason={errorText(workspaceQuery.error)} onRetry={refresh} />
      ) : null}
      {problems && (problems.here.length > 0 || problems.signIn.length > 0) ? (
        <Section title="Needs a look">
          <Card padded={false}>
            {problems.here.map((entry, index) => (
              <Row
                key={entry.name}
                first={index === 0}
                tone={healthStatus(entry.status)}
                title={entry.name}
                meta={
                  <View style={{ gap: t.space.hair }}>
                    <View style={{ flexDirection: "row" }}>
                      <StatusPill status={healthStatus(entry.status)} label={healthWord(entry.status)} />
                    </View>
                    <Text style={t.text.caption}>{healthPlainNote(entry.status)}</Text>
                  </View>
                }
                trailing={canOpenMcp() ? <Button label="Fix" variant="primary" onPress={() => openMcp(entry.name)} /> : undefined}
              />
            ))}
            {problems.signIn.map((name, index) => {
              const entry = agentServersQuery.data?.servers.find((candidate) => candidate.name === name) ?? null;
              const rows = entry ? authFor(entry.name, account, entry.inlineCredentials, entry.transport) : null;
              return (
                <Row
                  key={`sign-in:${name}`}
                  first={index === 0 && problems.here.length === 0}
                  tone="attention"
                  title={name}
                  meta={
                    <View style={{ flexDirection: "row" }}>
                      <StatusPill status="attention" label="Needs sign-in" />
                    </View>
                  }
                  trailing={!rows && canOpenMcp() ? <Button label="Sign in" onPress={() => openMcp(name)} /> : undefined}
                  expanded={rows}
                />
              );
            })}
          </Card>
        </Section>
      ) : null}
      {switchProvider ? (
        <Section
          title={agentId ? "Connectors this chat loads" : `Connectors a ${providerName(agentServersQuery.data?.scope?.provider ?? switchProvider)} chat here loads`}
          trailing={canOpenMcp() ? <Button label={`All ${MCP_NAME_LOWER}`} variant="ghost" onPress={() => openMcp()} /> : undefined}
        >
          <AgentServers
            data={agentServersQuery.data}
            loading={agentServersQuery.isLoading}
            error={agentServersQuery.error}
            onToggle={(name, enabled) => setEnabledMutation.mutate({ name, enabled })}
            toggling={setEnabledMutation.isPending ? setEnabledMutation.variables?.name ?? null : null}
            toolsByName={toolsByName}
            health={healthByName}
            signIn={(entry) => (problems?.signIn.includes(entry.name) ? null : authFor(entry.name, account, entry.inlineCredentials, entry.transport))}
            projectName={workspace?.name ?? data.workspace.name}
            onAddHere={canOpenMcp() ? () => openMcpAdd({ scope: "project", projectPath: data.workspace.projectRootPath || data.workspace.directory }) : undefined}
          />
        </Section>
      ) : null}
      <Accordion>
        {chatSection}
        {/* 0.20.0: when this chat loads the project's file, its connectors are in "This project" above; this fold is for when it doesn't. */}
        {agentServersQuery.data?.projectIncluded ? null : (
        <AccordionItem icon="FolderCode" title="This project's .mcp.json" summary={data.servers.length === 0 ? "None" : `${plural(data.servers.length, "connector")}, not loaded by this chat's AI app`}>
          {data.servers.length === 0 ? (
            <Text style={t.text.body}>{data.configPath ? "Its .mcp.json file is there but lists no connectors." : "This project has none. A project lists its own connectors in a file called .mcp.json in its top folder."}</Text>
          ) : (
            <Card padded={false} level={2}>
              {data.servers.map((entry, index) => (
                <Row key={entry.name} first={index === 0} title={entry.name} onPress={() => setSelected(entry.name)} trailing={<ServerHealthTag name={entry.name} />} />
              ))}
            </Card>
          )}
        </AccordionItem>
        )}
        {problems && problems.elsewhere.length > 0 ? (
          <AccordionItem icon="TriangleAlert" title="Problems elsewhere" summary={`${plural(problems.elsewhere.length, "connector")} this chat doesn't load`}>
            <Text style={t.text.body}>These don't affect this chat. They show as the dot on Connectors in the sidebar.</Text>
            <Card padded={false} level={2}>
              {problems.elsewhere.map((entry, index) => (
                <Row
                  key={entry.name}
                  first={index === 0}
                  title={entry.name}
                  meta={<View style={{ flexDirection: "row" }}><StatusPill status={healthStatus(entry.status)} label={healthWord(entry.status)} /></View>}
                  trailing={canOpenMcp() ? <Button label="Fix" onPress={() => openMcp(entry.name)} /> : undefined}
                />
              ))}
            </Card>
          </AccordionItem>
        ) : null}
        <AccordionItem icon="SlidersHorizontal" title="Technical details" summary="Files, programs running now, and how each switch works">
          {intro}
          <Facts items={[{ value: data.configPath || "No .mcp.json in this project" }, healthQuery.data ? { value: healthCheckedLabel(healthQuery.data, (iso) => new Date(iso).toLocaleString()) } : null]} />
          <LoadDetails data={data} providerId={providerId} added={agentId ? agentServersQuery.data?.pluginServers : undefined} />
          {agentServersQuery.data && agentServersQuery.data.servers.length > 0 ? (
            <View style={{ gap: t.space.xs }}>
              <Text style={t.text.label}>{agentServersQuery.data.scope ? `Settings: ${agentServersQuery.data.scope.label}` : "No settings found for this chat's AI app"}</Text>
              {agentServersQuery.data.servers.map((entry) => (
                <Text key={entry.name} style={t.text.caption}>{`${entry.name} (${entry.transport}): ${entry.enabled.reason}${entry.detail ? ` ${entry.detail}` : ""}`}</Text>
              ))}
              {!agentServersQuery.data.projectIncluded && agentServersQuery.data.projectNote ? <Text style={t.text.caption}>{agentServersQuery.data.projectNote}.</Text> : null}
              <Text style={t.text.label}>Where each comes from</Text>
              <CodeBlock>
                {agentServersQuery.data.servers
                  .map((entry) => `${entry.name}: ${scopeLabel(entry.scope, workspace?.name ?? data.workspace.name)} · ${homeRelative(entry.configPath, agentServersQuery.data?.home ?? "")}`)
                  .join("\n")}
              </CodeBlock>
            </View>
          ) : null}
          {data.servers.map((entry) => (
            <Text key={`project:${entry.name}`} style={t.text.caption}>{`${entry.name} (${entry.transport}, .mcp.json): ${entry.detail}`}</Text>
          ))}
        </AccordionItem>
      </Accordion>
    </View>
  ) : null;

  const pad = t.compact ? 16 : 24;
  return (
    <View style={{ flex: 1, backgroundColor: t.color.surface0 }}>
      <View style={{ padding: pad, paddingBottom: t.space.row, gap: t.space.row, width: "100%", maxWidth: t.maxWidth, alignSelf: "center" }}>
        <Header
          title={workspace?.name ?? MCP_NAME}
          status={pill}
          caption={caption}
          icon={agentId ? "Bot" : "FolderCode"}
          trailing={<Button label="Refresh" icon="RefreshCw" variant="ghost" loading={workspaceQuery.isFetching || healthQuery.isFetching} onPress={refresh} />}
        />
        {signInFocus && agentId ? (
          <SignInFocus
            server={signInFocus}
            entry={agentServersQuery.data?.servers.find((entry) => entry.name === signInFocus) ?? null}
            reading={agentServersQuery.isLoading}
            rows={(entry) => authFor(entry.name, agentServersQuery.data?.account ?? null, entry.inlineCredentials, entry.transport)}
            onDismiss={() => setSignInFocus(agentId, null)}
          />
        ) : null}
      </View>
      <Screen t={t} paddingTop={t.space.xs}>{body}</Screen>
    </View>
  );
}
