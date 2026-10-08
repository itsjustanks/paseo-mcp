/**
 * "Ask an agent" (0.20.0), the way Hosts does it: the message is shown word
 * for word, the person picks one of their chats, and nothing is sent until
 * they press Send. A busy agent is steered, never interrupted. The plugin
 * itself runs nothing. Absent on an app without the Paseo session or a dialog.
 */
import * as pluginClient from "@getpaseo/plugin/client";
import * as HostRN from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery } from "@tanstack/react-query";
import React, { useRef, useState } from "react";
import { Text, View } from "react-native";
import { hostModal } from "../shared/host-features";
import { Button, Card, CodeBlock, ErrorText, Loading, Row, Tag, TokensProvider, useToast, useTokens } from "./ui";

type Chat = { id: string; title: string; status: string };
type AgentHandle = { send(text: string, options: { activeTurnBehavior: "steer" }): Promise<void> };
type AskPaseo = {
  agents: {
    list(input: unknown): Promise<{ entries?: Array<{ agent?: { id: string; title?: string | null; provider?: string; status?: string; archivedAt?: string | null } }> }>;
    ref(id: string): AgentHandle;
  };
};
type HostModalComponent = React.FC<{ title: string; open: boolean; onOpenChange(open: boolean): void; children: React.ReactNode }> & {
  Content: React.ComponentType<{ children: React.ReactNode }>;
};
const HostModal = hostModal<HostModalComponent>(HostRN);
const usePaseoHook = (pluginClient as unknown as { usePaseo?: () => unknown }).usePaseo;

/** The app's Paseo session, or null; the hook is called on every render, whatever it returns. */
function useOptionalPaseo(): AskPaseo | null {
  let paseo: unknown = null;
  try {
    paseo = usePaseoHook ? usePaseoHook() : null;
  } catch {
    paseo = null;
  }
  const candidate = paseo as Partial<AskPaseo> | null;
  return candidate && typeof candidate.agents?.list === "function" && typeof candidate.agents?.ref === "function" ? (candidate as AskPaseo) : null;
}

async function recentChats(paseo: AskPaseo): Promise<Chat[]> {
  const result = await paseo.agents.list({ scope: "active", sort: [{ key: "updated_at", direction: "desc" }], page: { limit: 30 } });
  return (result.entries ?? [])
    .map((entry) => entry.agent)
    .filter((agent): agent is NonNullable<typeof agent> => Boolean(agent && !agent.archivedAt && agent.status !== "closed"))
    .slice(0, 8)
    .map((agent) => ({ id: agent.id, title: agent.title || `${agent.provider ?? "Agent"} chat`, status: agent.status ?? "" }));
}

export function AskAgentButton({ message, label = "Ask an agent" }: { message: string; label?: string }) {
  const paseo = useOptionalPaseo();
  const [open, setOpen] = useState(false);
  if (!paseo || !HostModal) return null;
  return (
    <>
      <Button label={label} icon="Bot" onPress={() => setOpen(true)} />
      {/* Mounted per opening, so a closed sheet forgets the chat picked and its single send. */}
      {open ? <AskAgentSheet paseo={paseo} message={message} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function AskAgentSheet({ paseo, message, onClose }: { paseo: AskPaseo; message: string; onClose: () => void }) {
  const t = useTokens();
  const toast = useToast();
  const chats = useQuery({ queryKey: ["paseo-mcp", "ask-chats"], queryFn: () => recentChats(paseo), staleTime: 0 });
  const [picked, setPicked] = useState<string | null>(null);
  const used = useRef(false);
  const chosen = chats.data?.find((chat) => chat.id === picked) ?? null;
  const send = useMutation({
    mutationFn: async (chat: Chat) => {
      await paseo.agents.ref(chat.id).send(message, { activeTurnBehavior: "steer" });
      return chat;
    },
    onError: () => {
      used.current = false;
      toast.error("Couldn't send it. Try again, or copy the message instead.");
    },
  });
  const press = () => {
    if (!chosen || used.current) return;
    used.current = true;
    send.mutate(chosen);
  };
  const Modal = HostModal!;
  return (
    <Modal title={send.data ? "Sent" : "Ask an agent"} open onOpenChange={(open) => (open || send.isPending ? undefined : onClose())}>
      <Modal.Content>
        <TokensProvider value={t}>
          <View style={{ gap: t.space.row }}>
            {send.data ? (
              <>
                <Text style={t.text.body}>{`Sent to ${send.data.title}. ${send.data.status === "running" ? "It was working, so this was added to what it's doing." : "It will reply in its chat."}`}</Text>
                <View style={{ flexDirection: "row", gap: t.space.sm }}>
                  <Button label="Close" variant="primary" onPress={onClose} />
                </View>
              </>
            ) : (
              <>
                <Text style={t.text.body}>This goes to the chat you pick, word for word. Nothing is sent until you press Send.</Text>
                <CodeBlock>{message}</CodeBlock>
                {chats.isLoading ? <Loading label="Finding your chats…" /> : null}
                {chats.error ? <ErrorText>Couldn't list your chats. Copy the message above instead.</ErrorText> : null}
                {chats.data && chats.data.length === 0 ? <Text style={t.text.body}>No open chats. Start one, or copy the message above.</Text> : null}
                {chats.data && chats.data.length > 0 ? (
                  <Card padded={false}>
                    {chats.data.map((chat, index) => (
                      <Row
                        key={chat.id}
                        first={index === 0}
                        selected={chat.id === picked}
                        onPress={() => setPicked(chat.id)}
                        title={chat.title}
                        trailing={chat.id === picked ? <Tag label="Chosen" tone="ok" /> : chat.status === "running" ? <Tag label="Working now" /> : undefined}
                      />
                    ))}
                  </Card>
                ) : null}
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm }}>
                  <Button label="Send" variant="primary" disabled={!chosen} loading={send.isPending} onPress={press} />
                  <Button label="Cancel" variant="ghost" disabled={send.isPending} onPress={onClose} />
                </View>
              </>
            )}
          </View>
        </TokensProvider>
      </Modal.Content>
    </Modal>
  );
}
