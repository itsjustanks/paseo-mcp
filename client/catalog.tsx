/** Add from catalogue: the gallery behind "Add server", its install sheet, and "Copy as catalogue entry". */
import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery } from "@tanstack/react-query";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Image, Linking, Text, View } from "react-native";
import {
  CATALOG_CATEGORIES,
  CATEGORY_LABELS,
  cardMatches,
  alreadyHave,
  alreadyHaveLine,
  similarName,
  similarNameLine,
  hiddenLine,
  hideAdded,
  mcpCatalog,
  mcpCatalogEntry,
  mcpCatalogInstall,
  mcpCatalogPlan,
  searchSummary,
  type CatalogCard,
  type LibraryState,
  type OwnedServer,
} from "../shared/catalog";
import type { Destination, McpHealthStatus } from "../shared/contracts";
import { SETUP_CLIENT_LABELS, byoVendor, claudeRedirectUri, oauthClientProblems, setupTargetSupport, stepLinks, type CatalogSetup } from "../shared/setup";
import { healthPlainWord } from "../shared/servers";
import { plainError } from "../shared/errors";
import {
  Button,
  Card,
  CodeBlock,
  Disclosure,
  EmptyState,
  ErrorText,
  Field,
  Grid,
  Loading,
  Notice,
  Pills,
  Row,
  Section,
  Segmented,
  StatusPill,
  Tag,
  Toggle,
  Toolbar,
  alpha,
  copyToClipboard,
  useTokens,
  type Status,
} from "./ui";
import { LibrariesPanel, SecretField } from "./libraries";

type Project = { name: string; path: string; servers: number };

// ------------------------------------------------------------------- pieces

function useDebounced<T>(value: T, ms: number): T {
  const [held, setHeld] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setHeld(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return held;
}

const TRUST: Record<CatalogCard["trust"], { label: string; tone: Status }> = {
  official: { label: "Official", tone: "ok" },
  team: { label: "Team", tone: "busy" },
  library: { label: "Library", tone: "neutral" },
  community: { label: "Community", tone: "attention" },
};

function authWord(card: CatalogCard): string {
  if (card.entry.auth === "oauth") return "Sign in with your account";
  if (card.entry.auth === "none") return "No sign-in";
  if (card.entry.auth === "unknown") return "Sign-in unclear";
  return "Needs a key";
}

/** A registry namespace is a claim, shown as plain text, never as a badge. */
function publisherLine(card: CatalogCard): string {
  if (!card.entry.publisher) return "Unknown publisher";
  return card.shelf === "registry" ? `published as ${card.entry.publisher}` : card.entry.publisher;
}

/** The badge a "Needs setup" card wears, by kind (0.16.0). */
const SETUP_BADGE: Record<CatalogSetup["kind"], string> = {
  "byo-oauth": "Needs setup",
  "per-org": "Needs your address",
  "approved-clients": "Approved apps only",
  admin: "Admin setup",
};

/** What the card's add button says: a setup that the sheet can finish is "Set up". */
function addLabel(card: CatalogCard): string {
  if (card.added) return "Add to more";
  const kind = card.entry.setup?.kind;
  return kind === "byo-oauth" || kind === "per-org" ? "Set up" : "Add";
}

/** A server that only ships a package the plugin won't start in one click: shown with its docs, added by hand. */
function byHandOnly(card: CatalogCard): boolean {
  return card.shelf !== "recommended" && card.entry.transport === "stdio" && !card.installable;
}

/** Where a card came from, for its source tag. */
function sourceLabel(card: CatalogCard): string {
  return card.library?.name ?? (card.shelf === "recommended" ? "Recommended" : card.shelf === "team" ? "Team" : "Registry");
}

/** The card's icon: an https image from its library, shown at 20 px. Nothing is shown when there is none or it fails to load. */
function CardIcon({ url }: { url?: string }) {
  const [failed, setFailed] = useState(false);
  if (!url || failed || !/^https:\/\//i.test(url)) return null;
  return <Image source={{ uri: url }} accessibilityIgnoresInvertColors style={{ width: 20, height: 20, borderRadius: 4 }} onError={() => setFailed(true)} />;
}

function ServerCard({ card, have, similar, onAdd, onAddByHand }: { card: CatalogCard; have: { name: string } | null; similar: string | null; onAdd: () => void; onAddByHand: (name: string) => void }) {
  const t = useTokens();
  const trust = TRUST[card.trust];
  const byHand = byHandOnly(card);
  return (
    <Card>
      <View style={{ gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.xs }}>
          <CardIcon url={card.entry.iconUrl} />
          <Text numberOfLines={1} style={[t.text.heading, { flexShrink: 1 }]}>{card.entry.name}</Text>
        </View>
        <Text numberOfLines={1} style={t.text.caption}>{publisherLine(card)}{card.version ? ` · v${card.version}` : ""}</Text>
        {(card.shelf === "registry" || card.shelf === "library") && card.trust !== "official" ? <Text numberOfLines={2} style={t.text.caption}>{card.trustNote}</Text> : null}
      </View>
      <Text numberOfLines={2} style={[t.text.body, { color: t.color.muted, minHeight: t.compact ? 40 : 36 }]}>
        {card.entry.description || "No description."}
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.xs }}>
        {card.added ? <Tag label="Added" tone="ok" /> : have ? <Tag label="You have one" tone="ok" /> : null}
        <Tag label={trust.label} tone={trust.tone} />
        <Tag label={card.entry.transport === "http" ? "Web" : "On this computer"} />
        <Tag label={authWord(card)} />
        {card.entry.setup ? <Tag label={SETUP_BADGE[card.entry.setup.kind]} tone="attention" /> : null}
        {card.shelf !== "recommended" && sourceLabel(card) !== trust.label ? <Tag label={sourceLabel(card)} /> : null}
      </View>
      {have ? <Text numberOfLines={2} style={t.text.caption}>{alreadyHaveLine(card, have)}</Text> : null}
      {!have && similar ? <Text numberOfLines={2} style={t.text.caption}>{similarNameLine(card, similar)}</Text> : null}
      {card.warning ? <Text style={[t.text.caption, { color: t.color.warning }]}>{card.warning}</Text> : null}
      {card.entry.setup ? <Text style={t.text.caption}>{card.entry.setup.reason}</Text> : !card.installable ? <Text style={t.text.caption}>{card.blockedReason}</Text> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm, alignItems: "center" }}>
        {byHand ? (
          <Button label="Add by hand" variant="secondary" onPress={() => onAddByHand(card.entry.id)} />
        ) : card.entry.setup && !card.installable ? null : (
          <Button label={addLabel(card)} variant="secondary" disabled={!card.installable} onPress={onAdd} />
        )}
        {card.entry.setup ? <Button label="How to set it up" variant={card.installable ? "ghost" : "secondary"} onPress={() => void Linking.openURL(card.entry.setup?.guideUrl ?? "")} /> : null}
        {card.entry.docs && card.entry.docs !== card.entry.setup?.guideUrl ? <Button label={byHand && card.shelf === "registry" ? "Repository" : "Docs"} variant="ghost" onPress={() => void Linking.openURL(card.entry.docs)} /> : null}
      </View>
    </Card>
  );
}

// ------------------------------------------------------------------ gallery

export function CatalogGallery({
  destinations,
  owned,
  onClose,
  onAddByHand,
  onInstalled,
  onOpenServer,
}: {
  destinations: Destination[];
  /** Your servers (0.15.0): a card you already have in any sense is hidden until asked for. */
  owned: readonly OwnedServer[];
  onClose: () => void;
  /** Opens the add-by-hand form, with the name filled in when one is given. */
  onAddByHand: (name?: string) => void;
  onInstalled: () => void;
  onOpenServer: (name: string) => void;
}) {
  const t = useTokens();
  const callCatalog = useRpc(mcpCatalog);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [picked, setPicked] = useState<CatalogCard | null>(null);
  // 0.15.0: servers you already have are left out unless asked for.
  const [showAdded, setShowAdded] = useState(false);
  const refresh = useRef<{ refresh?: "team" | "registry" | "both" | "libraries" | "all"; library?: string }>({});
  const query = useDebounced(search.trim(), 400);

  const catalogQuery = useQuery({
    queryKey: ["paseo-mcp", "catalog", query],
    queryFn: () => {
      const once = refresh.current;
      refresh.current = {};
      return callCatalog({ query, ...once });
    },
    // The host answers from memory and reads in the background; read again while it does.
    refetchInterval: (state) => (state.state.data?.libraries.some((library) => library.state === "loading" || library.state === "searching") ? 1500 : false),
    retry: 1,
  });
  const data = catalogQuery.data;
  const cards = data?.cards ?? [];
  const matching = cards.filter((card) => (card.shelf === "registry" ? category === "all" || card.entry.category === category : cardMatches(card, query, category)));
  const haves = useMemo(() => new Map(cards.map((card) => [card.key, alreadyHave(card, owned)] as const)), [cards, owned]);
  const similars = useMemo(() => new Map(cards.map((card) => [card.key, similarName(card, owned)] as const)), [cards, owned]);
  const { shown, hidden } = hideAdded(matching, showAdded, (card) => Boolean(haves.get(card.key)));
  const fromLibrary = (id: string) => shown.filter((card) => card.shelf !== "registry" && card.shelf !== "recommended" && card.library?.id === id);
  const fromRegistry = (id: string) => shown.filter((card) => card.shelf === "registry" && card.library?.id === id);
  const recommended = shown.filter((card) => card.shelf === "recommended");
  const libraries = data?.libraries ?? [];
  const documents = libraries.filter((library) => library.enabled && library.kind !== "registry");
  const registries = libraries.filter((library) => library.enabled && library.kind === "registry");
  const categories = useMemo(() => {
    const used = new Set(cards.map((card) => card.entry.category));
    return [{ value: "all", label: "All" }, ...CATALOG_CATEGORIES.filter((entry) => used.has(entry)).map((entry) => ({ value: entry, label: CATEGORY_LABELS[entry] ?? entry }))];
  }, [cards]);
  const summary = searchSummary({
    query,
    recommended: cards.filter((card) => card.shelf === "recommended").length,
    team: cards.filter((card) => card.shelf === "team").length,
    library: cards.filter((card) => card.shelf === "library").length,
    registrySearched: Boolean(data && data.registry.state !== "idle"),
    shown,
  });
  const summaryLine = [summary, hiddenLine(hidden)].filter(Boolean).join(" ");

  const again = (next: { refresh?: "team" | "registry" | "both" | "libraries" | "all"; library?: string }) => {
    refresh.current = next;
    void catalogQuery.refetch();
  };
  const refreshing = catalogQuery.isFetching ? refresh.current.library ?? "" : "";

  if (picked) {
    return (
      <InstallSheet
        card={picked}
        destinations={destinations}
        projects={data?.projects ?? []}
        onBack={() => {
          setPicked(null);
          void catalogQuery.refetch(); // an add changes which cards say "Added"
        }}
        onInstalled={onInstalled}
        onOpenServer={onOpenServer}
      />
    );
  }

  // Empty fillers keep a short last row at column width instead of one card stretched across.
  const grid = (list: CatalogCard[]) => (
    <Grid min={230}>
      {list.map((card) => (
        <ServerCard key={card.key} card={card} have={haves.get(card.key) ?? null} similar={similars.get(card.key) ?? null} onAdd={() => setPicked(card)} onAddByHand={onAddByHand} />
      ))}
      {t.compact ? null : [0, 1, 2].map((index) => <View key={`filler-${index}`} />)}
    </Grid>
  );

  const refusedList = (library: LibraryState) =>
    library.refused.length > 0 ? (
      <Disclosure title={`${library.refused.length} entr${library.refused.length === 1 ? "y" : "ies"} refused`}>
        {library.refused.map((entry) => (
          <Text key={entry.id} style={t.text.caption}>{`${entry.id}: ${entry.reason}`}</Text>
        ))}
      </Disclosure>
    ) : null;

  return (
    <View style={{ gap: t.space.lg }}>
      <Toolbar
        title="Add a server"
        subtitle="Pick one to add. Nothing is written until you review the change and press Add."
        actions={
          <>
            <Button label="Add by hand" onPress={() => onAddByHand()} />
            <Button label="Back to servers" variant="ghost" onPress={onClose} />
          </>
        }
      />
      <Field value={search} onChangeText={setSearch} placeholder={registries.length > 0 ? "Search the gallery and registries (e.g. jira)" : "Search the gallery (e.g. jira)"} />
      <Pills options={categories} value={category} onChange={setCategory} />
      <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
        <Text style={t.text.caption}>Show ones I already have</Text>
        <Toggle label="Show ones I already have" value={showAdded} onChange={setShowAdded} />
      </View>

      {catalogQuery.isLoading ? <Loading label="Reading the catalogue…" /> : null}
      {catalogQuery.error ? <ErrorText>{`Could not read the catalogue: ${plainError(catalogQuery.error)}`}</ErrorText> : null}

      {data && shown.length === 0 && data.registry.state !== "searching" ? (
        <Card>
          <EmptyState
            title={hidden > 0 ? "You already have every match" : "Nothing matches"}
            body={summaryLine}
            action={hidden > 0 ? <Button label="Show ones I already have" onPress={() => setShowAdded(true)} /> : search ? <Button label="Clear search" onPress={() => setSearch("")} /> : undefined}
          />
        </Card>
      ) : data ? (
        <Text style={t.text.caption}>{summaryLine}</Text>
      ) : null}

      {recommended.length > 0 ? (
        <Section title="Recommended">
          <Text style={t.text.caption}>Popular apps, each address checked against the maker's own instructions. Your own servers never leave this computer.</Text>
          {grid(recommended)}
        </Section>
      ) : null}

      {documents.map((library) => {
        const list = fromLibrary(library.id);
        return (
          <Section key={library.id} title={library.name} trailing={<Button label="Refresh" variant="ghost" loading={library.state === "loading"} onPress={() => again({ library: library.id })} />}>
            {library.note ? <Notice tone="attention">{library.note}</Notice> : null}
            {library.state === "loading" && library.count === 0 ? <Loading label={`Reading ${library.name}…`} /> : null}
            {list.length > 0 ? grid(list) : library.state === "ready" ? <Text style={t.text.caption}>{library.count === 0 ? `${library.name} has no usable entries.` : `No ${library.name} entry matches, or each is shown above.`}</Text> : null}
            {refusedList(library)}
          </Section>
        );
      })}

      {registries.map((library) =>
        library.state === "idle" ? null : (
          <Section key={library.id} title={library.name} trailing={<Button label="Search again" variant="ghost" loading={library.state === "searching"} onPress={() => again({ library: library.id })} />}>
            <Text style={t.text.caption}>
              Anyone can publish to a registry. Official means every address is one a recommended server uses, checked against the vendor's docs. Everything else is Community: the registry checks that a publisher owns the domain or GitHub account it publishes as, not who runs the service.
            </Text>
            {library.note ? <Notice tone="attention">{library.note}</Notice> : null}
            {library.state === "searching" ? <Loading label={`Searching ${library.name} for '${query}'…`} /> : null}
            {fromRegistry(library.id).length > 0 ? grid(fromRegistry(library.id)) : library.state === "ready" ? <Text style={t.text.caption}>{`No ${library.name} server matches '${query}' beyond the ones above.`}</Text> : null}
          </Section>
        ),
      )}
      {registries.length > 0 && search.trim().length === 1 ? <Text style={t.text.caption}>{`Type two letters or more to search ${registries.map((library) => library.name).join(" and ")} too.`}</Text> : null}

      <Card>
        <Disclosure title={`Libraries (${libraries.filter((library) => library.enabled).length} of ${libraries.length} on)`}>
          <LibrariesPanel states={libraries} refreshing={refreshing} onRefresh={(id) => again({ library: id })} onChanged={() => again({ refresh: "libraries" })} />
        </Disclosure>
      </Card>
    </View>
  );
}

// ------------------------------------------------------------ install sheet

function InstallSheet({
  card,
  destinations,
  projects,
  onBack,
  onInstalled,
  onOpenServer,
}: {
  card: CatalogCard;
  destinations: Destination[];
  projects: Project[];
  onBack: () => void;
  onInstalled: () => void;
  onOpenServer: (name: string) => void;
}) {
  const t = useTokens();
  const toast = useToast();
  const callPlan = useRpc(mcpCatalogPlan);
  const callInstall = useRpc(mcpCatalogInstall);
  const entry = card.entry;
  const added = card.added;
  const setup = entry.setup;
  const byo = setup?.kind === "byo-oauth";
  // Needs setup (0.16.0): an app that can't take this server is shown, not picked.
  const support = (dest: Destination) => setupTargetSupport(setup, dest);
  const projectAllowed = !byo && !(setup?.kind === "approved-clients" && !setup.clients?.includes("claude"));
  // "Add to more": only the places that lack it are picked to start with.
  const missingEditors = destinations.filter((dest) => !added?.editors.includes(dest.id) && support(dest).ok);
  const missingProjects = projects.filter((project) => !added?.projects.includes(project.path));
  const [scope, setScope] = useState<"user" | "project">(() => (projectAllowed && added && missingEditors.length === 0 && missingProjects.length > 0 ? "project" : "user"));
  // Editors an agent can run by default; slots no provider is wired to start unticked.
  const [targets, setTargets] = useState<string[]>(() => {
    const wired = missingEditors.filter((dest) => dest.providerId);
    return (wired.length > 0 || !added ? wired : missingEditors).map((dest) => dest.id);
  });
  const [projectPath, setProjectPath] = useState((missingProjects[0] ?? projects[0])?.path ?? "");
  const [name, setName] = useState(added?.name ?? entry.id);
  const [values, setValues] = useState<Record<string, string>>({});
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  // The preview only learns whether a secret was typed; the secret itself crosses once, on install.
  const request = { key: card.key, scope, targets, projectPath, name: name.trim(), values, ...(byo ? { oauthClient: { clientId: clientId.trim(), hasSecret: Boolean(clientSecret.trim()) } } : {}) };
  const secretIssues = byo && clientSecret.trim() ? oauthClientProblems({ clientId: "-", clientSecret }).filter((issue) => /secret/i.test(issue)) : [];
  const debounced = useDebounced(request, 350);

  const planQuery = useQuery({
    queryKey: ["paseo-mcp", "catalog-plan", JSON.stringify(debounced)],
    queryFn: () => callPlan(debounced),
    enabled: Boolean(debounced.name),
    retry: 0,
  });
  const install = useMutation({
    // Bound to the preview on screen: the host refuses if the entry or the change moved since.
    mutationFn: () =>
      callInstall({
        ...request,
        oauthClient: byo ? { clientId: clientId.trim(), clientSecret: clientSecret.trim() } : undefined,
        planHash: planQuery.data?.planHash ?? "",
      }),
    onSuccess: (result) => {
      if (result.ok) {
        toast.show(result.message, { variant: "success" });
        onInstalled();
      } else toast.error(result.message.split("\n")[0] ?? "Refused.");
    },
    onError: (error) => toast.error(plainError(error)),
  });
  const plan = planQuery.data;
  const current = planQuery.data && JSON.stringify(debounced) === JSON.stringify(request);
  const inputs = (entry.inputs ?? []).filter((input) => scope === "user" || !input.secret);
  const result = install.data?.ok ? install.data : null;

  if (result) {
    const tone: Status = result.health ? (result.health.status === "ok" ? "ok" : result.health.status === "auth-required" ? "neutral" : "attention") : "neutral";
    return (
      <View style={{ gap: t.space.lg }}>
        <Toolbar title={`Added ${name.trim()}`} subtitle={result.message} actions={<Button label="Back to catalogue" variant="ghost" onPress={onBack} />} />
        <Card>
          <Text style={t.text.heading}>Health check</Text>
          {result.health ? (
            <View style={{ flexDirection: "row", gap: t.space.sm, alignItems: "center", flexWrap: "wrap" }}>
              <StatusPill status={tone} label={healthPlainWord(result.health.status as McpHealthStatus)} />
              <Text style={[t.text.body, { flexShrink: 1 }]}>{result.health.note || "The server answered."}</Text>
            </View>
          ) : (
            <Text style={t.text.body}>Not checked.</Text>
          )}
          {result.written.map((file) => (
            <Text key={file} style={t.text.caption}>{`Written: ${file}`}</Text>
          ))}
          {result.skipped.map((line) => (
            <Text key={line} style={[t.text.caption, { color: t.color.warning }]}>{line}</Text>
          ))}
          {result.budget ? <Text style={t.text.caption}>{result.budget}</Text> : null}
        </Card>
        {result.envToSet.length > 0 ? (
          <Notice tone="attention">
            <View style={{ gap: t.space.xs }}>
              <Text style={t.text.body}>Set these where Claude Code starts, before the server can connect:</Text>
              <CodeBlock>{result.envToSet.map((entry) => `export ${entry.name}=…   # ${entry.label}`).join("\n")}</CodeBlock>
            </View>
          </Notice>
        ) : null}
        {result.oauth ? (
          <Card>
            <Text style={t.text.heading}>Sign in</Text>
            <Text style={t.text.body}>
              {scope === "user"
                ? "This server asks you to sign in with your account. Open it to connect each app."
                : "This server asks you to sign in with your account. Connect it from the project workspace's MCP connections tab."}
            </Text>
            {scope === "user" ? (
              <View style={{ flexDirection: "row" }}>
                <Button label="Open server to connect" variant="primary" onPress={() => onOpenServer(name.trim())} />
              </View>
            ) : null}
          </Card>
        ) : null}
      </View>
    );
  }

  return (
    <View style={{ gap: t.space.lg }}>
      <Toolbar title={`Add ${entry.name}`} subtitle={`${publisherLine(card)} · ${card.trustNote}`} actions={<Button label="Back to catalogue" variant="ghost" onPress={onBack} />} />
      {card.warning ? <Notice tone="attention">{card.warning}</Notice> : null}
      {byo && setup ? (
        <ByoSetupSteps
          setup={setup}
          serverUrl={entry.url ?? ""}
          redirectUri={plan?.redirectUri || claudeRedirectUri()}
          clientId={clientId}
          clientSecret={clientSecret}
          secretIssues={secretIssues}
          onClientId={setClientId}
          onClientSecret={setClientSecret}
        />
      ) : null}
      {setup && !byo ? <Notice tone="attention">{setup.reason}</Notice> : null}

      <Section title="Where">
        {projectAllowed ? (
          <Segmented
            value={scope}
            onChange={setScope}
            options={[
              { value: "user", label: "My AI apps" },
              { value: "project", label: "One project" },
            ]}
          />
        ) : null}
        {scope === "user" ? (
          <Card padded={false}>
            {destinations.length === 0 ? <EmptyState title="No AI app found" body="None of Claude, Codex, Kimi or Grok is set up on this computer yet." /> : null}
            {destinations.map((dest, index) => {
              const on = targets.includes(dest.id);
              const can = support(dest);
              return (
                <Row
                  key={dest.id}
                  first={index === 0}
                  selected={on && can.ok}
                  onPress={can.ok ? () => setTargets((list) => (on ? list.filter((id) => id !== dest.id) : [...list, dest.id])) : undefined}
                  title={dest.label}
                  subtitle={can.ok ? dest.configPath : can.reason}
                  trailing={!can.ok ? <Tag label="can't take it" tone="attention" /> : added?.editors.includes(dest.id) ? <Tag label="has it" /> : on ? <Tag label="included" tone="ok" /> : <Tag label="skipped" />}
                />
              );
            })}
          </Card>
        ) : (
          <Card padded={false}>
            {projects.length === 0 ? <EmptyState title="No projects" body="Paseo doesn't know any project on this computer yet." /> : null}
            {projects.map((project, index) => (
              <Row
                key={project.path}
                first={index === 0}
                selected={project.path === projectPath}
                onPress={() => setProjectPath(project.path)}
                title={project.name}
                subtitle={`${project.path}/.mcp.json · ${project.servers} server${project.servers === 1 ? "" : "s"}`}
                trailing={project.path === projectPath ? <Tag label="chosen" tone="ok" /> : added?.projects.includes(project.path) ? <Tag label="has it" /> : null}
              />
            ))}
          </Card>
        )}
      </Section>

      <Section title="Details">
        <Card>
          <Field label="Name" value={name} onChangeText={setName} hint="What your AI apps call it. Letters, numbers, - and _." />
          {inputs.map((input) =>
            input.secret ? (
              <SecretField
                key={input.id}
                label={`${input.label}${input.required ? "" : " (optional)"}`}
                value={values[input.id] ?? ""}
                onChangeText={(value) => setValues((all) => ({ ...all, [input.id]: value }))}
                hint={input.hint}
              />
            ) : (
              <Field
                key={input.id}
                label={`${input.label}${input.required ? "" : " (optional)"}`}
                value={values[input.id] ?? ""}
                onChangeText={(value) => setValues((all) => ({ ...all, [input.id]: value }))}
                hint={input.hint}
              />
            ),
          )}
          {scope === "project" && (entry.inputs ?? []).some((input) => input.secret) ? (
            <Text style={t.text.caption}>Keys aren't asked for here: a project's file is often shared, so it gets a placeholder instead, shown below.</Text>
          ) : null}
          {setup?.kind === "per-org" ? <Text style={t.text.caption}>{`Only lowercase letters, numbers and -. The rest of the address stays as ${setup.urlTemplate ?? ""}.`}</Text> : null}
          {entry.auth === "oauth" && inputs.length === 0 && !byo ? <Text style={t.text.caption}>No key needed: you sign in with your account after it's added.</Text> : null}
          {entry.auth === "unknown" && inputs.length === 0 ? <Text style={t.text.caption}>No key is listed for this server. If it asks you to sign in once added, open it and choose Connect.</Text> : null}
        </Card>
      </Section>

      <Section title="The change">
        {planQuery.isFetching && !plan ? <Loading label="Working out the change…" /> : null}
        {plan?.clash ? (
          <Notice tone="attention">
            <View style={{ gap: t.space.sm }}>
              <Text style={t.text.body}>{`A server called '${name.trim()}' is already in ${plan.clash.files.join(", ")}. Nothing is replaced.`}</Text>
              <View style={{ flexDirection: "row", gap: t.space.sm }}>
                <Button label={`Use '${plan.clash.suggestion}'`} onPress={() => setName(plan.clash?.suggestion ?? name)} />
                <Button label="Skip" variant="ghost" onPress={onBack} />
              </View>
            </View>
          </Notice>
        ) : null}
        {plan?.issues.map((issue) => (
          <ErrorText key={issue}>{issue}</ErrorText>
        ))}
        {plan?.commandLine ? (
          <View style={{ gap: t.space.xs }}>
            <Text style={t.text.label}>Starts this program on this computer</Text>
            <Text selectable style={[t.text.mono, { color: t.color.fg }]}>{plan.commandLine}</Text>
          </View>
        ) : null}
        {plan?.previews.map((preview) => (
          <View key={preview.file} style={{ gap: t.space.xs }}>
            <Text style={t.text.label}>{`${preview.label} · ${preview.file}`}</Text>
            <CodeBlock copy={false}>{preview.text.trimEnd()}</CodeBlock>
          </View>
        ))}
        {plan && plan.envToSet.length > 0 ? (
          <Text style={t.text.caption}>{`Set before use: ${plan.envToSet.map((entry) => entry.name).join(", ")}.`}</Text>
        ) : null}
        {plan?.budget ? <Text style={t.text.caption}>{plan.budget}</Text> : null}
        {plan?.notes.map((note) => (
          <Text key={note} style={t.text.caption}>{note}</Text>
        ))}
        {planQuery.error ? <ErrorText>{plainError(planQuery.error)}</ErrorText> : null}
      </Section>

      <View style={{ flexDirection: "row", gap: t.space.sm }}>
        <Button
          label={scope === "user" ? `Add to ${targets.length} app${targets.length === 1 ? "" : "s"}` : "Add to the project"}
          variant="primary"
          loading={install.isPending}
          disabled={!current || !plan?.ok || secretIssues.length > 0}
          onPress={() => install.mutate()}
        />
        <Button label="Cancel" variant="ghost" onPress={onBack} />
      </View>
      {install.data && !install.data.ok ? <ErrorText>{install.data.message}</ErrorText> : null}
    </View>
  );
}

// ---------------------------------------------------- bring your own app

/**
 * The guided part of a bring-your-own-app sheet (0.16.0): the vendor's steps
 * with their links, the exact redirect address to register, the scopes to
 * add, then the client ID and the secret (masked; it goes to Claude Code's
 * secure store and is never shown again).
 */
function ByoSetupSteps({
  setup,
  serverUrl,
  redirectUri,
  clientId,
  clientSecret,
  secretIssues,
  onClientId,
  onClientSecret,
}: {
  setup: CatalogSetup;
  serverUrl: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
  secretIssues: string[];
  onClientId: (value: string) => void;
  onClientSecret: (value: string) => void;
}) {
  const t = useTokens();
  const apps = (setup.clients ?? []).map((id) => SETUP_CLIENT_LABELS[id]).join(" and ");
  const vendor = byoVendor(serverUrl)?.vendor ?? "";
  const host = (() => {
    try {
      return new URL(serverUrl).hostname;
    } catch {
      return serverUrl;
    }
  })();
  return (
    <Section title="Set it up" trailing={<Button label="Vendor's guide" variant="ghost" onPress={() => void Linking.openURL(setup.guideUrl)} />}>
      <Text style={t.text.caption}>{`${setup.reason} Works with ${apps || "no app here yet"}.`}</Text>
      <Card>
        {(setup.steps ?? []).map((step, index) => {
          const links = stepLinks(step);
          const words = links.reduce((text, link) => text.replace(link, "").trim(), step).replace(/:\s*$/, ".");
          return (
            <View key={step} style={{ flexDirection: "row", gap: t.space.sm, alignItems: "flex-start" }}>
              <Text style={[t.text.label, { minWidth: 18 }]}>{`${index + 1}.`}</Text>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={t.text.body}>{words}</Text>
                {links.map((link) => (
                  <Text key={link} accessibilityRole="link" numberOfLines={1} onPress={() => void Linking.openURL(link)} style={[t.text.caption, { color: t.color.accent }]}>
                    {link.replace(/^https:\/\//, "").replace(/\?.*$/, "")}
                  </Text>
                ))}
              </View>
            </View>
          );
        })}
      </Card>
      <View style={{ gap: t.space.xs }}>
        <Text style={t.text.label}>{`Redirect address · paste it into ${setup.redirectHint || "the redirect address field"}`}</Text>
        <CodeBlock>{redirectUri}</CodeBlock>
        <Text style={t.text.caption}>Exactly as shown. Claude Code listens there when you sign in.</Text>
      </View>
      {setup.scopes ? (
        <View style={{ gap: t.space.xs }}>
          <Text style={t.text.label}>Scopes to add</Text>
          <CodeBlock>{setup.scopes.split(" ").join("\n")}</CodeBlock>
        </View>
      ) : null}
      <Card>
        <Field label="Client ID" value={clientId} onChangeText={onClientId} placeholder="Paste the client ID" />
        <SecretField label="Client secret" value={clientSecret} onChangeText={onClientSecret} hint="Kept by Claude Code in its secure store, never in a config file, and never shown again." />
        {secretIssues.map((issue) => (
          <ErrorText key={issue}>{issue}</ErrorText>
        ))}
        <Text style={t.text.caption}>{`Used only to sign in to ${host}${vendor ? `, ${vendor}'s own server` : ""}. Paste it nowhere else.`}</Text>
      </Card>
    </Section>
  );
}

// ------------------------------------------------------------ copy as entry

/** On each server card: its definition as a secret-free catalogue entry, on the clipboard. */
export function CopyCatalogEntryButton({ name }: { name: string }) {
  const t = useTokens();
  const toast = useToast();
  const callEntry = useRpc(mcpCatalogEntry);
  const [fallback, setFallback] = useState("");
  const copy = useMutation({
    mutationFn: () => callEntry({ name }),
    onSuccess: (result) => {
      if (!result.ok) return toast.error(result.message);
      if (copyToClipboard(result.json)) {
        setFallback("");
        toast.show(`Copied ${name} as a catalogue entry. ${result.message}`, { variant: "success" });
      } else {
        setFallback(result.json);
        toast.show("No clipboard here; the entry is shown below to select.", { variant: "warning" });
      }
    },
    onError: (error) => toast.error(plainError(error)),
  });
  return (
    <>
      <Button label="Copy as catalogue entry" variant="ghost" loading={copy.isPending} onPress={() => copy.mutate()} />
      {fallback ? (
        <View style={{ width: "100%", gap: t.space.xs, borderLeftWidth: 2, borderLeftColor: alpha(t.color.muted, 0.3), paddingLeft: t.space.sm }}>
          <CodeBlock>{fallback.trimEnd()}</CodeBlock>
        </View>
      ) : null}
    </>
  );
}
