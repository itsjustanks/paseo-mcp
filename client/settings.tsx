import { useCallback, useMemo } from "react";
import { Text } from "react-native";
import { useSettings, type PluginSurfaceProps, type SettingsState } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { injectionSettings, type InjectionProvider, type InjectionSettings } from "../shared/settings";

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
