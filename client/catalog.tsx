/** Add from catalogue: the gallery behind "Add server", its install sheet, and "Copy as catalogue entry". */
import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery } from "@tanstack/react-query";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Image, Linking, Pressable, Text, View } from "react-native";
import {
  CATALOG_CATEGORIES,
  CATEGORY_LABELS,
  cardMatches,
  mcpCatalog,
  mcpCatalogEntry,
  mcpCatalogInstall,
  mcpCatalogPlan,
  searchSummary,
  type CatalogCard,
  type LibraryState,
} from "../shared/catalog";
import type { Destination } from "../shared/contracts";
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
  Row,
  Section,
  Segmented,
  StatusPill,
  Tag,
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

/** Category filter: one row of pressable pills, "All" first. */
function Pills({ options, value, onChange }: { options: Array<{ value: string; label: string }>; value: string; onChange: (value: string) => void }) {
  const t = useTokens();
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.xs }}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(option.value)}
            hitSlop={t.control.hit}
            style={{
              paddingVertical: t.compact ? 7 : 4,
              paddingHorizontal: 10,
              borderRadius: t.radius.pill,
              borderWidth: 1,
              borderColor: active ? t.color.accentLine : t.color.border,
              backgroundColor: active ? t.color.accentWash : "transparent",
            }}
          >
            <Text style={{ fontSize: 12, fontWeight: "600", color: active ? t.color.accent : t.color.muted }}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const TRUST: Record<CatalogCard["trust"], { label: string; tone: Status }> = {
  official: { label: "Official", tone: "ok" },
  team: { label: "Team", tone: "busy" },
  library: { label: "Library", tone: "neutral" },
  community: { label: "Community", tone: "attention" },
};

function authWord(card: CatalogCard): string {
  if (card.entry.auth === "oauth") return "OAuth";
  if (card.entry.auth === "none") return "No auth";
  if (card.entry.auth === "unknown") return "Sign-in unclear";
  return "Key";
}

/** A registry namespace is a claim, shown as plain text, never as a badge. */
function publisherLine(card: CatalogCard): string {
  if (!card.entry.publisher) return "Unknown publisher";
  return card.shelf === "registry" ? `published as ${card.entry.publisher}` : card.entry.publisher;
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

function ServerCard({ card, onAdd, onAddByHand }: { card: CatalogCard; onAdd: () => void; onAddByHand: (name: string) => void }) {
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
        {card.added ? <Tag label="Added" tone="ok" /> : null}
        <Tag label={trust.label} tone={trust.tone} />
        <Tag label={card.entry.transport === "http" ? "Remote" : "Runs locally"} />
        <Tag label={authWord(card)} />
        {sourceLabel(card) !== trust.label ? <Tag label={sourceLabel(card)} /> : null}
      </View>
      {card.added ? <Text numberOfLines={1} style={t.text.caption}>{`Added ${card.added.label}${card.added.name !== card.entry.id ? ` as ${card.added.name}` : ""}.`}</Text> : null}
      {card.warning ? <Text style={[t.text.caption, { color: t.color.warning }]}>{card.warning}</Text> : null}
      {!card.installable ? <Text style={t.text.caption}>{card.blockedReason}</Text> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm, alignItems: "center" }}>
        {byHand ? (
          <Button label="Add by hand" variant="secondary" onPress={() => onAddByHand(card.entry.id)} />
        ) : (
          <Button label={card.added ? "Add to more" : "Add"} variant="secondary" disabled={!card.installable} onPress={onAdd} />
        )}
        {card.entry.docs ? <Button label={byHand && card.shelf === "registry" ? "Repository" : "Docs"} variant="ghost" onPress={() => void Linking.openURL(card.entry.docs)} /> : null}
      </View>
    </Card>
  );
}

// ------------------------------------------------------------------ gallery

export function CatalogGallery({
  destinations,
  onClose,
  onAddByHand,
  onInstalled,
  onOpenServer,
}: {
  destinations: Destination[];
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
  const shown = cards.filter((card) => (card.shelf === "registry" ? category === "all" || card.entry.category === category : cardMatches(card, query, category)));
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
        <ServerCard key={card.key} card={card} onAdd={() => setPicked(card)} onAddByHand={onAddByHand} />
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

      {catalogQuery.isLoading ? <Loading label="Reading the catalogue…" /> : null}
      {catalogQuery.error ? <ErrorText>{`Could not read the catalogue: ${plainError(catalogQuery.error)}`}</ErrorText> : null}

      {data && shown.length === 0 && data.registry.state !== "searching" ? (
        <Card>
          <EmptyState title="Nothing matches" body={summary} action={search ? <Button label="Clear search" onPress={() => setSearch("")} /> : undefined} />
        </Card>
      ) : data ? (
        <Text style={t.text.caption}>{summary}</Text>
      ) : null}

      {recommended.length > 0 ? (
        <Section title="Recommended">
          <Text style={t.text.caption}>Official servers shipped with the plugin, each address checked against the vendor's own docs. A library's copy that differs in any way (address, headers, version, arguments) shows under that library instead.</Text>
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
  // "Add to more": only the places that lack it are picked to start with.
  const missingEditors = destinations.filter((dest) => !added?.editors.includes(dest.id));
  const missingProjects = projects.filter((project) => !added?.projects.includes(project.path));
  const [scope, setScope] = useState<"user" | "project">(() => (added && missingEditors.length === 0 && missingProjects.length > 0 ? "project" : "user"));
  // Editors an agent can run by default; slots no provider is wired to start unticked.
  const [targets, setTargets] = useState<string[]>(() => {
    const wired = missingEditors.filter((dest) => dest.providerId);
    return (wired.length > 0 || !added ? wired : missingEditors).map((dest) => dest.id);
  });
  const [projectPath, setProjectPath] = useState((missingProjects[0] ?? projects[0])?.path ?? "");
  const [name, setName] = useState(added?.name ?? entry.id);
  const [values, setValues] = useState<Record<string, string>>({});
  const request = { key: card.key, scope, targets, projectPath, name: name.trim(), values };
  const debounced = useDebounced(request, 350);

  const planQuery = useQuery({
    queryKey: ["paseo-mcp", "catalog-plan", JSON.stringify(debounced)],
    queryFn: () => callPlan(debounced),
    enabled: Boolean(debounced.name),
    retry: 0,
  });
  const install = useMutation({
    // Bound to the preview on screen: the host refuses if the entry or the change moved since.
    mutationFn: () => callInstall({ ...request, planHash: planQuery.data?.planHash ?? "" }),
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
              <StatusPill status={tone} label={result.health.status === "auth-required" ? "needs sign-in" : result.health.status} />
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
              <Text style={t.text.body}>Set these where Claude Code starts before the server can sign in:</Text>
              <CodeBlock>{result.envToSet.map((entry) => `export ${entry.name}=…   # ${entry.label}`).join("\n")}</CodeBlock>
            </View>
          </Notice>
        ) : null}
        {result.oauth ? (
          <Card>
            <Text style={t.text.heading}>Sign in</Text>
            <Text style={t.text.body}>
              {scope === "user"
                ? "This server signs in with OAuth. Open it to connect each account."
                : "This server signs in with OAuth. Connect it from the workspace's MCP connections tab, or with /mcp in Claude Code."}
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

      <Section title="Where">
        <Segmented
          value={scope}
          onChange={setScope}
          options={[
            { value: "user", label: "My editors" },
            { value: "project", label: "One project" },
          ]}
        />
        {scope === "user" ? (
          <Card padded={false}>
            {destinations.length === 0 ? <EmptyState title="Nowhere to write" body="No editor config was found on this host." /> : null}
            {destinations.map((dest, index) => {
              const on = targets.includes(dest.id);
              return (
                <Row
                  key={dest.id}
                  first={index === 0}
                  selected={on}
                  onPress={() => setTargets((list) => (on ? list.filter((id) => id !== dest.id) : [...list, dest.id]))}
                  title={dest.label}
                  subtitle={dest.configPath}
                  trailing={added?.editors.includes(dest.id) ? <Tag label="has it" /> : on ? <Tag label="included" tone="ok" /> : <Tag label="skipped" />}
                />
              );
            })}
          </Card>
        ) : (
          <Card padded={false}>
            {projects.length === 0 ? <EmptyState title="No projects" body="Paseo has no registered project on this host." /> : null}
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
          <Field label="Name" value={name} onChangeText={setName} hint="What the editors call it. Letters, numbers, - and _." />
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
            <Text style={t.text.caption}>Keys are not asked for here: the project file gets a ${"{VAR}"} reference instead, shown below.</Text>
          ) : null}
          {entry.auth === "oauth" && inputs.length === 0 ? <Text style={t.text.caption}>No key needed: this server signs in with OAuth after it is added.</Text> : null}
          {entry.auth === "unknown" && inputs.length === 0 ? <Text style={t.text.caption}>The registry lists no key for this server. If it asks you to sign in once added, use Connect OAuth on its card.</Text> : null}
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
            <Text style={t.text.label}>Runs this command on this host</Text>
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
          label={scope === "user" ? `Add to ${targets.length} editor${targets.length === 1 ? "" : "s"}` : "Add to the project"}
          variant="primary"
          loading={install.isPending}
          disabled={!current || !plan?.ok}
          onPress={() => install.mutate()}
        />
        <Button label="Cancel" variant="ghost" onPress={onBack} />
      </View>
      {install.data && !install.data.ok ? <ErrorText>{install.data.message}</ErrorText> : null}
    </View>
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
