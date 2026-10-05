/**
 * The words that teach (0.17.0, the shared design standard of our Paseo
 * plugins): each tab's plain intro and "What you can do here", and the
 * Overview's guide — what MCP servers are, how it works, how to use it, and
 * the words you'll see. Pure text, so the tests can hold it to plain English.
 */

/** What the plugin is called in the app: the sidebar row, the page and its panels (0.18.4). */
export const MCP_NAME = "Connectors (MCP)";
/** The same name inside a sentence or a longer title ("Open workspace connectors (MCP)"). */
export const MCP_NAME_LOWER = "connectors (MCP)";

export type TabIntro = {
  /** The tab bar's short label. */
  label: string;
  /** A Lucide icon name, drawn by the Paseo app. */
  icon: string;
  /** The tab's own title, above its intro. */
  title: string;
  /** One or two plain sentences on what the tab is for. */
  summary: string;
  /** "What you can do here": two to four short lines. */
  canDo: readonly string[];
};

export const TAB_INTROS = {
  overview: {
    label: "Overview",
    icon: "LayoutDashboard",
    title: "Overview",
    summary: "Whether your servers are working and in every AI app, the one thing to do next, and a short guide to how it all fits together.",
    canDo: [
      "See at a glance whether every server works and is signed in",
      "Do the next step that fixes the most",
      "Copy your servers into every AI app in one go",
      "Learn what MCP servers are and how to use them",
    ],
  },
  servers: {
    label: "Servers",
    icon: "Server",
    title: "Your servers",
    summary: "Every server you have, one card each. A card's settings button opens that server: what it can do, who's signed in, and where it's set up.",
    canDo: [
      "Search, or show only the ones that need you",
      "Open a server to see its tools, sign in, change or remove it",
      "Add a server from a gallery of popular apps",
      "Turn Paseo's own built-in tools on or off",
    ],
  },
  projects: {
    label: "Projects",
    icon: "FolderCode",
    title: "Project servers",
    summary: "Some projects bring their own servers, listed in a file inside the project. Anyone who opens that project gets them too.",
    canDo: [
      "See which projects bring their own servers, and which ones",
      "Find where to sign in to them: that project's workspace",
    ],
  },
  transfer: {
    label: "Import & Export",
    icon: "ArrowLeftRight",
    title: "Import and export",
    summary: "Add a server by hand, paste the setup text from a server's instructions, or save every server to a backup file.",
    canDo: [
      "Type a server's web address, or the program it runs",
      "Paste the setup text a server's instructions give you",
      "Save every server to a file, with keys hidden unless you choose",
    ],
  },
  guide: {
    label: "Guide & Setup",
    icon: "BookOpen",
    title: "Guide and setup",
    summary: "Five steps from a server's instructions to every AI app on this computer, and what to do when something doesn't work.",
    canDo: [
      "Follow the steps to add your first server",
      "Find out why a sign-in didn't finish, and finish it",
      "Fix a server that isn't installed or isn't answering",
    ],
  },
} as const satisfies Record<string, TabIntro>;

export type TabId = keyof typeof TAB_INTROS;
export const TAB_ORDER: readonly TabId[] = ["overview", "servers", "projects", "transfer", "guide"];

// -------------------------------------------------------------- Overview guide

/** "What are MCP servers?": the first sentence is the explainer every tab links back to. */
export const WHAT_IS = [
  "MCP servers connect your AI assistants to the apps you already use, like Notion, Supabase or Linear, so an assistant can read and act in them.",
  "You add a server once, here, and this copies it to every AI app on this computer: Claude, Codex and the rest. Each app then signs in to it once, if it asks.",
] as const;

/** "How it works": four steps with icons and arrows. */
export const HOW_IT_WORKS = [
  { icon: "Plus", title: "You add a server", text: "Pick an app from the gallery, or paste the setup text from its instructions." },
  { icon: "Copy", title: "It goes into every AI app", text: "Claude, Codex and the others each get it, so whichever you chat with can use it." },
  { icon: "KeyRound", title: "You sign in once", text: "If the server asks, each app signs in once, in your browser." },
  { icon: "MessageSquare", title: "Your assistant uses it", text: "In a chat, the assistant can now search, read and act in that app when you ask." },
] as const;

/** The note under the steps: why fewer servers keep assistants quick. */
export const FEWER_IS_FASTER = {
  title: "Fewer is faster.",
  text: "At the start of every chat, each server tells the assistant about everything it can do. Keep only the servers you use, and your assistants start quicker.",
};

/** "How to use it": numbered steps for a first server. */
export const HOW_TO_USE = [
  "Open Servers and choose Add server.",
  "Pick an app, or paste the setup text from its instructions. Nothing changes until you've seen exactly what will be added and pressed Add.",
  "If its card says Needs sign-in, open it and choose Connect. Your browser opens the app's sign-in page.",
  "Start a chat and ask for something in that app, such as “find my open Linear issues”.",
] as const;

/** The box under the steps: Copy to all my AI apps. */
export const ADDED_TO_ONE_APP = {
  title: "Added a server to only one app?",
  text: "Copy to all my AI apps puts every server into each AI app and account that doesn't have it yet. You see the changes before anything is written.",
};

/** "Words you'll see": one plain line for each word the panel uses. */
export const WORDS = [
  { icon: "Plug", term: "MCP server", text: "A small connector for one app. It tells your AI assistant what it can do there and does it when asked." },
  { icon: "Wrench", term: "Tool", text: "One thing a server can do, such as “search pages” or “create an issue”. Your assistant picks the tool it needs." },
  { icon: "Bot", term: "AI app", text: "An assistant you chat with in Paseo, such as Claude or Codex. Each keeps its own list of servers, and this keeps them in step." },
  { icon: "Globe", term: "On the web, or on this computer", text: "Some servers live on the web and are added by their address. Others are a small program that runs here while an assistant needs it." },
  { icon: "KeyRound", term: "Sign-in", text: "Some servers ask you to sign in, so the assistant acts as you. Each AI app and account signs in once." },
  { icon: "Key", term: "Saved key", text: "A password-like code some servers use instead of a sign-in. It's stored in that app's settings file." },
  { icon: "FolderCode", term: "Project server", text: "A server a project brings with it, in a file inside the project. Anyone who opens the project gets it." },
  { icon: "HeartPulse", term: "Health check", text: "A quick test that a server answers. Working, Not working and Not installed are its results." },
] as const;
