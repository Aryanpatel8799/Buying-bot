/**
 * displayManager — allocates per-job Xvfb + x11vnc + noVNC slots.
 *
 * Architecture:
 *   - The VPS pre-installs three systemd templates (one-time admin step):
 *     `xvfb@.service`, `x11vnc@.service`, `novnc@.service`.
 *   - We pick a free display number from a configured pool and call
 *     `systemctl start xvfb@<N> x11vnc@<N> novnc@<N>`. Stops the same way.
 *   - Each display has predictable ports:
 *       VNC port  = 5900 + N
 *       noVNC port = 6000 + N
 *   - The public URL is constructed from `VNC_PUBLIC_HOST` (env) — defaults
 *     to "localhost", which still works for SSH-tunnel testing.
 *
 * Configuration (env vars in .env.local on the VPS):
 *   VNC_DISPLAY_POOL=100-129   # display numbers to draw from
 *   VNC_PUBLIC_HOST=187.127.153.76
 *
 * If VNC_DISPLAY_POOL is unset the manager is **disabled** — `allocate()`
 * returns null and callers fall back to the inherited DISPLAY env var (the
 * legacy single-display behaviour).
 */

import { execFile } from "child_process";
import { promisify } from "util";

const execFileP = promisify(execFile);

interface DisplaySlot {
  display: number;        // 100, 101, …
  displayString: string;  // ":100"
  vncPort: number;        // 6000
  noVncPort: number;      // 6100
  noVncUrl: string;       // http://<host>:6100/vnc.html
}

class DisplayManager {
  private pool: number[] = [];
  private inUse = new Set<number>();
  private publicHost: string;
  private enabled: boolean;

  constructor() {
    this.publicHost = process.env.VNC_PUBLIC_HOST || "localhost";
    const poolEnv = process.env.VNC_DISPLAY_POOL;
    if (!poolEnv) {
      this.enabled = false;
      return;
    }
    const m = poolEnv.match(/^(\d+)\s*-\s*(\d+)$/);
    if (!m) {
      console.warn(`[displayManager] VNC_DISPLAY_POOL must be "<low>-<high>", got "${poolEnv}" — disabling`);
      this.enabled = false;
      return;
    }
    const lo = parseInt(m[1], 10);
    const hi = parseInt(m[2], 10);
    if (!(lo > 0 && hi >= lo && hi < 1000)) {
      console.warn(`[displayManager] invalid pool range ${lo}-${hi} — disabling`);
      this.enabled = false;
      return;
    }
    for (let n = lo; n <= hi; n++) this.pool.push(n);
    this.enabled = true;
    console.log(`[displayManager] pool initialised: ${lo}-${hi} (${this.pool.length} slots), publicHost=${this.publicHost}`);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Pick the first free display, start its systemd services, return slot info. */
  async allocate(): Promise<DisplaySlot | null> {
    if (!this.enabled) return null;

    const free = this.pool.find((n) => !this.inUse.has(n));
    if (free === undefined) {
      console.warn(`[displayManager] pool exhausted (${this.pool.length} slots)`);
      return null;
    }

    this.inUse.add(free);
    const slot = this.makeSlot(free);

    try {
      await execFileP("systemctl", ["start", `xvfb@${free}`, `x11vnc@${free}`, `novnc@${free}`]);
      console.log(`[displayManager] allocated display :${free} → ${slot.noVncUrl}`);
      return slot;
    } catch (err) {
      this.inUse.delete(free);
      console.error(`[displayManager] failed to start services for :${free}:`, (err as Error).message);
      return null;
    }
  }

  /** Stop the systemd services for a display and mark it free. */
  async release(display: number | string | undefined | null): Promise<void> {
    if (!this.enabled || display == null) return;
    const n = typeof display === "string"
      ? parseInt(display.replace(/^:/, ""), 10)
      : display;
    if (!Number.isFinite(n) || !this.inUse.has(n)) {
      // Not ours, or already released — nothing to do.
      return;
    }
    try {
      await execFileP("systemctl", ["stop", `xvfb@${n}`, `x11vnc@${n}`, `novnc@${n}`]);
    } catch (err) {
      console.warn(`[displayManager] failed to stop :${n}:`, (err as Error).message);
    } finally {
      this.inUse.delete(n);
      console.log(`[displayManager] released display :${n}`);
    }
  }

  /**
   * Mark a display as in-use externally (e.g. read from the DB after a
   * Next.js restart). Used by startup cleanup to reconcile state.
   */
  markInUse(display: number): void {
    if (!this.enabled || !this.pool.includes(display)) return;
    this.inUse.add(display);
  }

  /**
   * Re-build a slot descriptor from a display number we know is allocated
   * (e.g. when reading it back from the DB after a restart).
   */
  makeSlot(display: number): DisplaySlot {
    return {
      display,
      displayString: `:${display}`,
      vncPort: 5900 + display,
      noVncPort: 6000 + display,
      noVncUrl: `http://${this.publicHost}:${6000 + display}/vnc.html`,
    };
  }
}

// Singleton — Next.js may hot-reload modules in dev; cache on globalThis.
const g = globalThis as unknown as { __displayManager?: DisplayManager };
export const displayManager: DisplayManager = g.__displayManager ?? new DisplayManager();
g.__displayManager = displayManager;

export type { DisplaySlot };
