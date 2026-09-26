/** "Copy to all my AI apps" (0.15.0): the preview, one row per server with a tick box, and the result per server and app. */
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import React, { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { COPY_ALL_EXPLAINER, COPY_ALL_LABEL, copySummary, mcpCopyAll, mcpCopyPlan } from "../shared/copy-all";
import { plainError } from "../shared/errors";
import { joinWords } from "../shared/servers";
import { Button, Card, Checkbox, EmptyState, ErrorText, Facts, Loading, Row, StatusPill, Toolbar, useTokens } from "./ui";

export function CopyAllPanel({ onClose, onCopied }: { onClose: () => void; onCopied: () => void }) {
  const t = useTokens();
  const callPlan = useRpc(mcpCopyPlan);
  const callCopy = useRpc(mcpCopyAll);
  const planQuery = useQuery({ queryKey: ["paseo-mcp", "copy-plan"], queryFn: () => callPlan({}), retry: 1, staleTime: 0 });
  const plan = planQuery.data;
  // Every server is ticked to start with; untick one to leave it out.
  const [left, setLeft] = useState<string[]>([]);
  useEffect(() => setLeft([]), [plan]);
  const chosen = (plan?.servers ?? []).filter((entry) => !left.includes(entry.name));
  const copy = useMutation({
    mutationFn: () => callCopy({ servers: chosen.map((entry) => ({ name: entry.name, targets: entry.targets.map((target) => target.id) })) }),
    onSuccess: () => onCopied(),
  });
  const result = copy.data;
  const places = chosen.reduce((sum, entry) => sum + entry.targets.length, 0);

  if (result) {
    return (
      <View style={{ gap: t.space.lg }}>
        <Toolbar title="Copied" subtitle={copySummary(result.results)} actions={<Button label="Done" variant="primary" onPress={onClose} />} />
        <Card padded={false}>
          {result.results.map((entry, index) => (
            <Row
              key={entry.name}
              first={index === 0}
              tone={entry.skipped.length > 0 ? "attention" : undefined}
              title={entry.name}
              meta={
                <View style={{ gap: t.space.xs, paddingTop: 2 }}>
                  {entry.written.length > 0 ? <StatusPill status="ok" label={`Copied to ${joinWords(entry.written)}`} /> : null}
                  {entry.skipped.map((skip) => (
                    <Text key={skip.label} style={[t.text.caption, { color: t.color.warning }]}>{`Not copied to ${skip.label}: ${skip.reason}.`}</Text>
                  ))}
                </View>
              }
            />
          ))}
        </Card>
        <Text style={t.text.caption}>A backup of each file was saved beside it before it changed. Sign-ins weren't copied: each app signs in on its own.</Text>
      </View>
    );
  }

  return (
    <View style={{ gap: t.space.lg }}>
      <Toolbar title={COPY_ALL_LABEL} subtitle={COPY_ALL_EXPLAINER} actions={<Button label="Cancel" variant="ghost" onPress={onClose} />} />
      {planQuery.isLoading ? <Loading label="Working out what's missing where…" /> : null}
      {planQuery.error ? <ErrorText>{`Couldn't work out what to copy: ${plainError(planQuery.error)}`}</ErrorText> : null}
      {plan && plan.servers.length === 0 ? (
        <Card>
          <EmptyState title="Nothing to copy" body="Every AI app and account on this computer already has every server." action={<Button label="Back" onPress={onClose} />} />
        </Card>
      ) : null}
      {plan && plan.servers.length > 0 ? (
        <>
          <Text style={t.text.caption}>{`Tick the servers to copy. ${plan.servers.length} ${plan.servers.length === 1 ? "is" : "are"} missing from at least one app.`}</Text>
          <Card padded={false}>
            {plan.servers.map((entry, index) => {
              const on = !left.includes(entry.name);
              return (
                <Row
                  key={entry.name}
                  first={index === 0}
                  selected={on}
                  title={
                    <Checkbox
                      label={`Copy ${entry.name}`}
                      checked={on}
                      onChange={(next) => setLeft((list) => (next ? list.filter((name) => name !== entry.name) : [...list, entry.name]))}
                    >
                      <View style={{ gap: 2 }}>
                        <Text style={t.text.bodyStrong}>{entry.name}</Text>
                        <Text style={t.text.caption}>{`Adds it to ${joinWords(entry.targets.map((target) => target.label))}`}</Text>
                        <Facts
                          items={[
                            { value: `from ${entry.from}` },
                            entry.savedKey ? { value: "includes its saved key", tone: "attention" } : null,
                          ]}
                        />
                        {entry.note ? <Text style={t.text.caption}>{entry.note}</Text> : null}
                        {(entry.blocked ?? []).map((skip) => (
                          <Text key={skip.label} style={[t.text.caption, { color: t.color.warning }]}>{`Not to ${skip.label}: ${skip.reason}.`}</Text>
                        ))}
                      </View>
                    </Checkbox>
                  }
                />
              );
            })}
          </Card>
          {plan.excluded.length > 0 ? (
            <Text style={t.text.caption}>{`Not copied: ${plan.excluded.map((entry) => `${entry.name} (${entry.reason})`).join(" ")}`}</Text>
          ) : null}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm }}>
            <Button
              label={`Copy ${chosen.length} server${chosen.length === 1 ? "" : "s"}`}
              variant="primary"
              loading={copy.isPending}
              disabled={chosen.length === 0}
              onPress={() => copy.mutate()}
            />
            <Button label="Cancel" variant="ghost" onPress={onClose} />
          </View>
          <Text style={t.text.caption}>{`${places} place${places === 1 ? "" : "s"} will change. Nothing is removed or replaced, and a backup of each file is saved first.`}</Text>
          {copy.error ? <ErrorText>{plainError(copy.error)}</ErrorText> : null}
        </>
      ) : null}
    </View>
  );
}
