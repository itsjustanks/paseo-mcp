// Startup and shutdown registry for server-only modules. A server module
// registers at import time; index.server.ts calls runStart() after wiring its
// handlers and returns runShutdown as the entry cleanup. Nothing under client/
// imports this file, so the app bundle never sees these tasks.

type Task = () => void;

const startTasks: Task[] = [];
const shutdownTasks: Task[] = [];

/** Run once the plugin is registered, off the startup path. Server modules only. */
export function onStart(task: Task): void {
  startTasks.push(task);
}

/** Run when the plugin is disabled or reloaded. Server modules only. */
export function onShutdown(task: Task): void {
  shutdownTasks.push(task);
}

function drain(tasks: Task[]): void {
  // Splice the list first: a task that throws must not strand the others, and a
  // second call (reload racing shutdown) must not run anything twice.
  for (const task of tasks.splice(0, tasks.length)) {
    try {
      task();
    } catch (error) {
      console.error("[paseo-mcp] lifecycle task failed", error);
    }
  }
}

export function runStart(): void {
  // Start tasks are warm-ups by definition, so they must not sit on the
  // registration path. A tick is enough to get off it.
  if (startTasks.length === 0) return;
  setTimeout(() => drain(startTasks), 0);
}

export function runShutdown(): void {
  drain(shutdownTasks);
}
