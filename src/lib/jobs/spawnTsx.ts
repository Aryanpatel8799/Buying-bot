import { spawn, SpawnOptions, ChildProcess } from "child_process";
import path from "path";

const TSX_CLI = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");

/**
 * Spawn a TypeScript script via the local tsx CLI, using the current Node
 * binary. Avoids `npx` / `shell: true` so it works cross-platform (and in
 * particular fixes `spawn npx ENOENT` on Windows).
 */
export function spawnTsx(scriptPath: string, args: string[], options: SpawnOptions = {}): ChildProcess {
  return spawn(process.execPath, [TSX_CLI, scriptPath, ...args], {
    cwd: process.cwd(),
    ...options,
  });
}
