import { useCallback, useMemo } from "react";
import { Text } from "react-native";
import { useSettings, type PluginSurfaceProps, type SettingsState } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import {
  HEALTH_INTERVAL_CHOICES,
  healthSettings,
  injectionSettings,
  type HealthSettings,
  type InjectionProvider,
  type InjectionSettings,
} from "../shared/settings";

type Ready = Extract<SettingsState<typeof injectionSettings.schema>, { status: "ready" }>;

/**
 * `providers` is an array, but two providers only have three useful states, so
 * the screen offers them as one select rather than a switch per provider.
 */
type ProviderChoice = "codex" | "claude" | "both";

const PROVIDER_CHOICES: readonly { label: string; value: ProviderChoice }[] = [
  { label: "Codex only", value: "codex" },
  { label: "Claude Code only", value: "claude" },
  { label: "Claude Code and Codex", value: "both" },
];

function toChoice(providers: readonly InjectionProvider[]): ProviderChoice {
  const claude = providers.includes("claude");
  const codex = providers.includes("codex");
  if (claude && codex) return "both";
  if (claude) return "claude";
  return "codex";
}

function fromChoice(choice: ProviderChoice): InjectionProvider[] {
  if (choice === "both") return ["claude", "codex"];
  return [choice];
}

export function describeInjection(values: InjectionSettings): string {
  if (!values.injectWorkspaceServers) return "Injection is off";
  const who = toChoice(values.providers);
  const target = who === "both" ? "Claude Code and Codex" : who === "claude" ? "Claude Code" : "Codex";
  return `Injecting into new ${target} agents${values.skipInlineCredentialServers ? ", skipping inline-credential servers" : ""}`;
}

function InjectionControls({ settings, theme }: { settings: Ready; theme: PluginSurfaceProps["theme"] }) {
  const muted = useMemo(() => ({ color: theme.colors.foregroundMuted, fontSize: 13 }), [theme]);
  const save = useCallback(
    (patch: Partial<InjectionSettings>) => {
      void settings.save({ ...settings.values, ...patch }, settings.revision);
    },
    [settings],
  );
  const { values } = settings;
  return (
    <>
      <SettingsSection title="Injection">
        <SettingsCard>
          <SettingsSwitch
            label="Inject workspace servers"
            hint="Add the workspace's .mcp.json servers to every new agent"
            value={values.injectWorkspaceServers}
            disabled={settings.saving}
            onValueChange={(injectWorkspaceServers) => save({ injectWorkspaceServers })}
          />
          <SettingsSelect
            label="Providers"
            hint="Which providers to inject for"
            value={toChoice(values.providers)}
            options={PROVIDER_CHOICES}
            disabled={settings.saving || !values.injectWorkspaceServers}
            onValueChange={(choice) => save({ providers: fromChoice(choice) })}
          />
          <SettingsSwitch
            label="Skip inline-credential servers"
            hint="Leave out servers whose .mcp.json entry carries tokens in env, headers, args, or the URL"
            value={values.skipInlineCredentialServers}
            disabled={settings.saving || !values.injectWorkspaceServers}
            onValueChange={(skipInlineCredentialServers) => save({ skipInlineCredentialServers })}
          />
        </SettingsCard>
        {settings.saveError ? (
          <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>
            {settings.saveError}
          </Text>
        ) : null}
      </SettingsSection>
      <SettingsSection title="How it works">
        <SettingsRow label="Status" hint={describeInjection(values)} />
        <Text style={muted}>
          When an agent is created, the plugin reads .mcp.json from the agent's working directory or its
          project root and adds each server to the agent's MCP configuration. Servers the agent already
          defines are left alone. Nothing is written to disk.
        </Text>
      </SettingsSection>
    </>
  );
}

export function InjectionSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(injectionSettings);
  const style = useMemo(() => ({ color: theme.colors.foreground }), [theme]);
  if (settings.status === "loading") return <Text style={style}>Loading settings…</Text>;
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="Injection">
        <Text style={style}>{settings.error}</Text>
        <SettingsAction label="Try again" actionLabel="Reload" onPress={settings.reload} />
        {settings.status === "invalid" ? (
          <SettingsAction label="Restore default settings" actionLabel="Reset" onPress={settings.reset} />
        ) : null}
      </SettingsSection>
    );
  }
  return <InjectionControls settings={settings} theme={theme} />;
}

// ---------------------------------------------------------------- health

type HealthReady = Extract<SettingsState<typeof healthSettings.schema>, { status: "ready" }>;

const INTERVAL_OPTIONS = HEALTH_INTERVAL_CHOICES.map((minutes) => ({
  label: minutes === 60 ? "Every hour" : `Every ${minutes} minutes`,
  value: String(minutes),
}));

export function describeHealth(values: HealthSettings): string {
  if (!values.backgroundChecks) return "Background checks are off; servers are probed only when you press Refresh";
  return `Probing every ${values.intervalMinutes} minutes${values.showComposerPill ? ", with an MCP chip on every agent's composer" : ""}`;
}

function HealthControls({ settings, theme }: { settings: HealthReady; theme: PluginSurfaceProps["theme"] }) {
  const muted = useMemo(() => ({ color: theme.colors.foregroundMuted, fontSize: 13 }), [theme]);
  const save = useCallback(
    (patch: Partial<HealthSettings>) => {
      void settings.save({ ...settings.values, ...patch }, settings.revision);
    },
    [settings],
  );
  const { values } = settings;
  // A hand-edited file may hold an interval the select does not list; show it as-is.
  const intervalOptions = INTERVAL_OPTIONS.some((option) => option.value === String(values.intervalMinutes))
    ? INTERVAL_OPTIONS
    : [...INTERVAL_OPTIONS, { label: `Every ${values.intervalMinutes} minutes`, value: String(values.intervalMinutes) }];
  return (
    <>
      <SettingsSection title="Health checks">
        <SettingsCard>
          <SettingsSwitch
            label="Check servers in the background"
            hint="Probe every MCP server on a timer, not only when Refresh is pressed"
            value={values.backgroundChecks}
            disabled={settings.saving}
            onValueChange={(backgroundChecks) => save({ backgroundChecks })}
          />
          <SettingsSelect
            label="Interval"
            hint="How often the host probes HTTP endpoints and looks for stdio binaries"
            value={String(values.intervalMinutes)}
            options={intervalOptions}
            disabled={settings.saving || !values.backgroundChecks}
            onValueChange={(choice) => save({ intervalMinutes: Number(choice) })}
          />
          <SettingsSwitch
            label="Composer chip"
            hint="Always show an MCP chip on each agent's composer: server count, then issues, sign-ins or the tool total; press it to open MCP management"
            value={values.showComposerPill}
            disabled={settings.saving}
            onValueChange={(showComposerPill) => save({ showComposerPill })}
          />
        </SettingsCard>
        {settings.saveError ? (
          <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>
            {settings.saveError}
          </Text>
        ) : null}
      </SettingsSection>
      <SettingsSection title="How it works">
        <SettingsRow label="Status" hint={describeHealth(values)} />
        <Text style={muted}>
          The host keeps the most recent result and every panel, pill and the MCP surface reads that cached
          verdict, so opening ten agents does not probe your servers ten times. Refresh and Check now always
          run a fresh probe. A server defined in an editor's global config is flagged as a user-level problem;
          one defined only by a project's .mcp.json is flagged against that project.
        </Text>
      </SettingsSection>
    </>
  );
}

export function HealthSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(healthSettings);
  const style = useMemo(() => ({ color: theme.colors.foreground }), [theme]);
  if (settings.status === "loading") return <Text style={style}>Loading settings…</Text>;
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="Health checks">
        <Text style={style}>{settings.error}</Text>
        <SettingsAction label="Try again" actionLabel="Reload" onPress={settings.reload} />
        {settings.status === "invalid" ? (
          <SettingsAction label="Restore default settings" actionLabel="Reset" onPress={settings.reset} />
        ) : null}
      </SettingsSection>
    );
  }
  return <HealthControls settings={settings} theme={theme} />;
}
