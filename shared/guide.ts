/**
 * The words that teach: the plugin's name, the tab labels, the Overview's
 * guide (what connectors are, how they work, how to use them, the words you'll
 * see) and the Help tab's questions. Pure text, so the tests can hold it to
 * plain English. 0.19.0 says "connector" where it said "server".
 */

/** What the plugin is called in the app: the sidebar row, the page and its panels (0.19.0; "Connectors (MCP)" in 0.18.4). */
export const MCP_NAME = "Connectors";
/** The same name inside a sentence or a longer title ("Open workspace connectors"). */
export const MCP_NAME_LOWER = "connectors";

/** The one line that says what a connector is, shown on Overview and in Help (0.19.0). */
export const WHAT_CONNECTORS_ARE = "Connectors are MCP servers: small add-ons that let your AI apps use your other apps, like GitHub, Notion or Linear.";

/** A tab: its short label and its Lucide icon. No intro block under the tab bar (0.19.0: the user found the stacked headers messy). */
export type TabMeta = {
  label: string;
  icon: string;
};

export const TABS_META = {
  overview: { label: "Overview", icon: "LayoutDashboard" },
  servers: { label: "Connectors", icon: "Plug" },
  projects: { label: "Projects", icon: "FolderCode" },
  guide: { label: "Help", icon: "CircleHelp" },
  // Not in the tab bar since 0.19.0: adding with a link, pasting setup instructions and backups
  // open from Add connector and Help, and the Connectors tab stays lit while they're open.
  transfer: { label: "Add with a link", icon: "Link" },
} as const satisfies Record<string, TabMeta>;

export type TabId = keyof typeof TABS_META;
export const TAB_ORDER: readonly TabId[] = ["overview", "servers", "projects", "guide"];

/** The one muted line at the top of Projects. */
export const PROJECTS_LINE = "This project: some projects come with their own connectors, in a file called .mcp.json. Anyone who opens the project gets them too, and Claude Code uses a project's copy there over one set up everywhere.";

// -------------------------------------------------------------- Overview guide

/** "What are connectors?": two plain sentences. */
export const WHAT_IS = [
  WHAT_CONNECTORS_ARE,
  "You add a connector once, here, and it goes into every AI app on this computer: Claude, Codex and the rest. Each app then signs in to it once, if it asks.",
] as const;

/** "How it works": four steps with icons and arrows. */
export const HOW_IT_WORKS = [
  { icon: "Plus", title: "You add a connector", text: "Pick an app from the gallery, or paste the setup instructions it gives you." },
  { icon: "Copy", title: "It goes into every AI app", text: "Claude, Codex and the others each get it, so whichever you chat with can use it." },
  { icon: "KeyRound", title: "You sign in once", text: "If the connector asks, each app signs in once, in your browser." },
  { icon: "MessageSquare", title: "Your assistant uses it", text: "In a chat, the assistant can now search, read and act in that app when you ask." },
] as const;

/** The note under the steps: why fewer connectors keep assistants quick. */
export const FEWER_IS_FASTER = {
  title: "Fewer is faster.",
  text: "At the start of every chat, each connector tells the assistant everything it can do. Keep only the ones you use, and your assistants start quicker.",
};

/** "How to use it": numbered steps for a first connector. */
export const HOW_TO_USE = [
  "Open Connectors and choose Add connector.",
  "Pick an app. Nothing changes until you've seen exactly what will be added and pressed Add.",
  "If its card says Needs sign-in, open it and choose Connect. Your browser opens the app's sign-in page.",
  "Start a chat and ask for something in that app, such as “find my open Linear issues”.",
] as const;

/** The box under the steps: Copy to all my AI apps. */
export const ADDED_TO_ONE_APP = {
  title: "Added a connector to only one app?",
  text: "Copy to all my AI apps puts every connector into each AI app and account that doesn't have it yet. You see the changes before anything is saved.",
};

/** "Words you'll see": one plain line for each word the page uses. */
export const WORDS = [
  { icon: "Plug", term: "Connector", text: "An add-on for one app, also called an MCP server. It tells your AI assistant what it can do there and does it when asked." },
  { icon: "Wrench", term: "Tool", text: "One thing a connector can do, such as “search pages” or “create an issue”. Your assistant picks the tool it needs." },
  { icon: "Bot", term: "AI app", text: "An assistant you chat with in Paseo, such as Claude or Codex. Each keeps its own list of connectors, and this keeps them in step." },
  { icon: "Globe", term: "On the web, or on this computer", text: "Most connectors live on the web and are added by a link. Some are a small program that runs here while an assistant needs it." },
  { icon: "KeyRound", term: "Sign-in", text: "Some connectors ask you to sign in, so the assistant acts as you. Each AI app and account signs in once." },
  { icon: "Key", term: "Saved key", text: "A password-like code some connectors use instead of a sign-in. It's stored in that app's settings file." },
  { icon: "FolderCode", term: "Project connector", text: "A connector that comes with a project. Anyone who opens the project gets it." },
  { icon: "HeartPulse", term: "Health check", text: "A quick test that a connector answers. Working, Not working and Not installed are its results." },
] as const;

// ---------------------------------------------------------------------- Help

/** Where a Help answer's button goes. */
export type HelpTarget =
  | { to: "filter"; filter: "sign-in" | "issues" | "gaps" }
  | { to: "copy" }
  | { to: "projects" }
  | { to: "add" }
  | { to: "backup" };

export type HelpQuestion = {
  icon: string;
  question: string;
  /** One to three short paragraphs. `{host}` becomes the computer's name. */
  answer: readonly string[];
  action?: { label: string; target: HelpTarget };
};

/** Help's last question, which holds the whole guide (0.19.2: Help is folded questions only). */
export const HOW_IT_WORKS_QUESTION = `How do ${MCP_NAME_LOWER} work?`;

/** The Help tab: plain questions, each folded until opened. */
export const HELP_QUESTIONS: readonly HelpQuestion[] = [
  {
    icon: "Plus",
    question: "How do I add a connector?",
    answer: [
      "Open Connectors and choose Add connector, then pick an app from the gallery. You see exactly what will change before anything is added.",
      "Not in the gallery? Choose Add with a link and paste the link from the app's setup instructions, or paste the instructions themselves.",
    ],
    action: { label: "Add a connector", target: { to: "add" } },
  },
  {
    icon: "KeyRound",
    question: "A connector says “Needs sign-in”",
    answer: [
      "Open it and choose Connect. Your browser opens that app's sign-in page. Each AI app and account signs in once.",
    ],
    action: { label: "Show the ones that need sign-in", target: { to: "filter", filter: "sign-in" } },
  },
  {
    icon: "Globe",
    question: "The sign-in page won't load, or says “localhost”",
    answer: [
      "Sign-in happens on the computer running Paseo ({host}), which may not be the one in front of you.",
      "If the browser ends up on a page that won't load, copy that page's full address. Then open the connector, paste it into the box under the account, and choose Finish connection.",
    ],
  },
  {
    icon: "TriangleAlert",
    question: "A connector says “Not working” or “Not installed”",
    answer: [
      "Not working: it didn't answer. Open it to see what went wrong, and check its link or key.",
      "Not installed: it's a small program that isn't on {host} yet. Its setup instructions say how to install it.",
    ],
    action: { label: "Show the ones that need attention", target: { to: "filter", filter: "issues" } },
  },
  {
    icon: "Copy",
    question: "A connector is missing from one of my AI apps",
    answer: [
      "Copy to all my AI apps puts every connector into each app and account that doesn't have it yet. You see the changes first.",
      "Sign-ins aren't copied: each app still signs in to each connector once.",
    ],
    action: { label: "Copy to all my AI apps", target: { to: "copy" } },
  },
  {
    icon: "FolderCode",
    question: "What are project connectors?",
    answer: [
      "Some projects come with their own connectors, listed in a file inside the project. You sign in to them from that project's workspace, in its Workspace connectors tab.",
    ],
    action: { label: "See projects", target: { to: "projects" } },
  },
  {
    icon: "Archive",
    question: "How do I back up my connectors?",
    answer: [
      "Save a backup puts every connector from every AI app into one file on {host}. Keys are left out unless you choose to include them.",
    ],
    action: { label: "Save a backup", target: { to: "backup" } },
  },
];
