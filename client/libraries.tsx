/** The gallery's Libraries panel: which libraries it reads, their state, and each one's write-only key. */
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import React, { useState } from "react";
import { Text, TextInput, View } from "react-native";
import { catalogSettings, mcpCatalogTeamAuth, type LibraryState } from "../shared/catalog";
import {
  DEFAULT_LIBRARIES,
  LIBRARIES_MAX,
  TEAM_LIBRARY_ID,
  librariesProblem,
  libraryIdFor,
  libraryLocation,
  type LibraryFormat,
  type LibrarySource,
} from "../shared/library-source";
import { plainError } from "../shared/errors";
import { Button, Card, ConfirmButton, ErrorText, Field, Loading, Row, Segmented, Tag, Toggle, useTokens, type Status } from "./ui";

const STATE: Record<LibraryState["state"], { label: string; tone: Status }> = {
  off: { label: "off", tone: "neutral" },
  loading: { label: "reading", tone: "busy" },
  searching: { label: "searching", tone: "busy" },
  ready: { label: "read", tone: "ok" },
  idle: { label: "waiting for a search", tone: "neutral" },
  error: { label: "can't read", tone: "attention" },
};

const KIND: Record<LibraryState["kind"], string> = {
  json: "JSON file at an address",
  registry: "Registry, searched as you type",
  file: "File on this host",
  invalid: "Not readable",
};

/** A masked one-line field; the value never shows on screen. */
export function SecretField({ label, value, onChangeText, hint, placeholder }: { label: string; value: string; onChangeText: (value: string) => void; hint?: string; placeholder?: string }) {
  const t = useTokens();
  return (
    <View style={{ gap: 4 }}>
      <Text style={t.text.label}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        secureTextEntry
        placeholder={placeholder ?? "Paste it here"}
        placeholderTextColor={t.color.placeholder}
        accessibilityLabel={label}
        autoCorrect={false}
        autoCapitalize="none"
        spellCheck={false}
        style={{
          borderWidth: 1,
          borderColor: t.color.border,
          borderRadius: t.radius.sm,
          backgroundColor: t.color.surface0,
          paddingVertical: t.compact ? 10 : 7,
          paddingHorizontal: 10,
          color: t.color.fg,
          minHeight: t.control.min,
          fontSize: t.compact ? 14 : 13,
        }}
      />
      {hint ? <Text style={t.text.caption}>{hint}</Text> : null}
    </View>
  );
}

/** A library's header value is write-only: the host keeps it in its own 0600 file and only says whether one is set. */
function LibraryKey({ library, onSaved }: { library: LibrarySource; onSaved: () => void }) {
  const t = useTokens();
  const callAuth = useRpc(mcpCatalogTeamAuth);
  const [value, setValue] = useState("");
  const status = useQuery({ queryKey: ["paseo-mcp", "catalog-team-auth", library.id], queryFn: () => callAuth({ action: "status", value: "", library: library.id }), retry: 1 });
  const change = useMutation({
    mutationFn: (action: "set" | "clear") => callAuth({ action, value: action === "set" ? value : "", library: library.id }),
    onSuccess: () => {
      setValue("");
      void status.refetch();
      onSaved();
    },
  });
  const isSet = status.data?.set === true;
  return (
    <View style={{ gap: t.space.sm }}>
      <SecretField
        label={`${library.headerName} value`}
        value={value}
        onChangeText={setValue}
        placeholder={isSet ? `Saved for ${status.data?.origin || "no site"}; type to replace` : "Bearer …"}
        hint="Sent only to the site of this library's address, never on a redirect; if the address moves to another site, the value is cleared. Kept on this host in a private file; it is never sent back to the app."
      />
      <View style={{ flexDirection: "row", gap: t.space.sm }}>
        <Button label="Save value" loading={change.isPending && change.variables === "set"} disabled={!value.trim()} onPress={() => change.mutate("set")} />
        {isSet ? <Button label="Clear value" variant="ghost" loading={change.isPending && change.variables === "clear"} onPress={() => change.mutate("clear")} /> : null}
      </View>
      {change.error ? <ErrorText>{plainError(change.error)}</ErrorText> : null}
    </View>
  );
}

/** The add form: a name, an address or a file, how to read it, and an optional header for a private address. */
function AddLibrary({ libraries, onAdd, saving }: { libraries: LibrarySource[]; onAdd: (library: LibrarySource) => void; saving: boolean }) {
  const t = useTokens();
  const [name, setName] = useState("");
  const [source, setSource] = useState("");
  const [format, setFormat] = useState<LibraryFormat>("auto");
  const [headerName, setHeaderName] = useState("");
  const location = source.trim() ? libraryLocation(source, format) : null;
  const draft: LibrarySource = { id: libraryIdFor(name || "library", libraries.map((library) => library.id)), name: name.trim(), source: source.trim(), format, enabled: true, headerName: headerName.trim() };
  const problem = location?.kind === "invalid" ? location.reason : librariesProblem([...libraries, draft]);
  const full = libraries.length >= LIBRARIES_MAX;
  return (
    <View style={{ gap: t.space.sm }}>
      <Field label="Name" value={name} onChangeText={setName} placeholder="Acme tools" />
      <Field
        label="Address or file"
        value={source}
        onChangeText={setSource}
        placeholder="https://raw.githubusercontent.com/you/mcp-library/main/servers.json"
        hint="A JSON file in the MCP Registry's shape (or a team catalogue), a registry address, or a file on this host. https only; plain http only on this machine."
      />
      <Segmented
        value={format}
        onChange={setFormat}
        options={[
          { value: "auto", label: "Detect" },
          { value: "json", label: "JSON file" },
          { value: "registry", label: "Registry" },
        ]}
      />
      {location && location.kind !== "invalid" ? <Text style={t.text.caption}>{`Read as: ${KIND[location.kind]}.`}</Text> : null}
      <Field label="Header name (private address only)" value={headerName} onChangeText={setHeaderName} placeholder="Authorization" hint="Its value is set after the library is added, and is write-only." />
      {problem ? <ErrorText>{problem}</ErrorText> : null}
      {full ? <Text style={t.text.caption}>{`${LIBRARIES_MAX} libraries is the most the gallery reads.`}</Text> : null}
      <View style={{ flexDirection: "row" }}>
        <Button
          label="Add library"
          variant="primary"
          loading={saving}
          disabled={!draft.name || !location || Boolean(problem) || full}
          onPress={() => {
            onAdd(draft);
            setName("");
            setSource("");
            setFormat("auto");
            setHeaderName("");
          }}
        />
      </View>
    </View>
  );
}

/**
 * Every library the gallery reads, in the settings order (a name clash goes
 * to the more trusted library: libraryTrustRank), each with its state, a switch, Refresh and Remove. Changes save at
 * once through Paseo's settings, which the host reads on its next catalogue
 * read.
 */
export function LibrariesPanel({ states, onChanged, onRefresh, refreshing }: { states: LibraryState[]; onChanged: () => void; onRefresh: (id: string) => void; refreshing: string }) {
  const t = useTokens();
  const settings = useSettings(catalogSettings);
  const [adding, setAdding] = useState(false);
  if (settings.status === "loading") return <Loading label="Reading the library settings…" />;
  if (settings.status !== "ready") return <ErrorText>{`Could not read the library settings: ${"error" in settings ? settings.error : "unknown"}`}</ErrorText>;
  const libraries = settings.values.libraries;
  const save = (next: LibrarySource[]) =>
    void settings.save({ libraries: next }, settings.revision).then((ok) => {
      if (ok) onChanged();
    });
  const missingDefaults = DEFAULT_LIBRARIES.filter((library) => !libraries.some((entry) => entry.id === library.id));

  return (
    <View style={{ gap: t.space.md }}>
      <Text style={t.text.body}>
        Libraries are lists of MCP servers the gallery reads. Each server in one is a template: values you fill in (keys, tokens) are asked for when you add it, never stored in a library. When two list the same server name, the more trusted one wins: Team, then libraries you added, then the default public ones (order below only matters within each group). The recommended servers shipped with the plugin always show.
      </Text>
      <Card padded={false}>
        {libraries.map((library, index) => {
          const state = states.find((entry) => entry.id === library.id);
          const pill = STATE[library.enabled ? state?.state ?? "loading" : "off"];
          const location = libraryLocation(library.source, library.format);
          const readable = location.kind === "json" || location.kind === "file";
          return (
            <Row
              key={library.id}
              first={index === 0}
              title={library.name}
              subtitle={state?.source ?? library.source}
              meta={
                <View style={{ gap: t.space.xs }}>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.xs }}>
                    <Tag label={pill.label} tone={pill.tone} />
                    <Tag label={KIND[location.kind]} />
                    {library.enabled && state && state.state !== "idle" && state.state !== "off" ? <Tag label={`${state.count} server${state.count === 1 ? "" : "s"}`} /> : null}
                    {library.id === TEAM_LIBRARY_ID ? <Tag label="Team" tone="busy" /> : null}
                  </View>
                  {library.enabled && state?.note ? <Text style={[t.text.caption, { color: t.color.warning }]}>{state.note}</Text> : null}
                  {library.enabled && state?.fetchedAt ? <Text style={t.text.caption}>{`Read ${new Date(state.fetchedAt).toLocaleString()}`}</Text> : null}
                </View>
              }
              trailing={
                <>
                  <Toggle label={`Read ${library.name}`} value={library.enabled} loading={settings.saving} onChange={(enabled) => save(libraries.map((entry) => (entry.id === library.id ? { ...entry, enabled } : entry)))} />
                  {library.enabled && readable ? <Button label="Refresh" variant="ghost" loading={refreshing === library.id} onPress={() => onRefresh(library.id)} /> : null}
                  <ConfirmButton label="Remove" confirmLabel={`Remove ${library.name}`} variant="ghost" onConfirm={() => save(libraries.filter((entry) => entry.id !== library.id))} />
                </>
              }
              expanded={library.enabled && library.headerName && /^https:\/\//i.test(library.source.trim()) ? <LibraryKey library={library} onSaved={onChanged} /> : undefined}
            />
          );
        })}
      </Card>
      {settings.saveError ? <ErrorText>{settings.saveError}</ErrorText> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm }}>
        {!adding ? <Button label="Add a library" onPress={() => setAdding(true)} /> : <Button label="Cancel" variant="ghost" onPress={() => setAdding(false)} />}
        {missingDefaults.length > 0 ? (
          <Button label={`Add back ${missingDefaults.map((library) => library.name).join(" and ")}`} variant="ghost" onPress={() => save([...libraries, ...missingDefaults])} />
        ) : null}
      </View>
      {adding ? (
        <Card>
          <AddLibrary
            libraries={libraries}
            saving={settings.saving}
            onAdd={(library) => {
              setAdding(false);
              save([...libraries, library]);
            }}
          />
        </Card>
      ) : null}
    </View>
  );
}
