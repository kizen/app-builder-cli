/**
 * Best-effort system-clipboard copy with no third-party dependency. Used by the
 * `encrypt` command so the user can paste the envelope without the terminal's
 * soft-wrapping turning into real line breaks in the copied text.
 *
 * Only the encrypted envelope (ciphertext) is ever copied — never a plaintext
 * secret — so writing it to the clipboard is safe.
 */
import { spawn } from 'node:child_process';
import { platform } from 'node:process';

interface ClipboardCommand {
  cmd: string;
  args: string[];
}

/**
 * Clipboard tools to try, in order, for the current platform. Linux/other has
 * several candidates (Wayland first, then X11) since none is guaranteed.
 */
function clipboardCommands(): ClipboardCommand[] {
  if (platform === 'darwin') {
    return [{ cmd: 'pbcopy', args: [] }];
  }

  if (platform === 'win32') {
    return [{ cmd: 'clip', args: [] }];
  }

  return [
    // wl-copy (Wayland) intentionally WITHOUT --foreground: the default forks a
    // background process that keeps serving the selection after this CLI exits.
    // --foreground would instead tie the selection to our process, so the 2s
    // kill-timeout below would terminate it and wipe the clipboard.
    { cmd: 'wl-copy', args: [] },
    { cmd: 'xclip', args: ['-selection', 'clipboard'] },
    { cmd: 'xsel', args: ['--clipboard', '--input'] },
  ];
}

/** How long to wait for a clipboard tool before giving up. Encryption has
 * already succeeded by the time we copy, so a tool that hangs (some Linux
 * xclip/xsel setups can) must never freeze the CLI — it just falls back. */
const CLIPBOARD_TIMEOUT_MS = 2000;

/** Pipes `text` into one clipboard command. Resolves false (never rejects) on
 * any failure — a missing tool (ENOENT), a non-zero exit, a broken pipe, or a
 * tool that doesn't exit within the timeout. */
function runClipboardCommand(text: string, { cmd, args }: ClipboardCommand): Promise<boolean> {
  return new Promise((resolve) => {
    let child;

    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    } catch {
      // Spawn threw synchronously (e.g. invalid command) — nothing to clean up.
      resolve(false);

      return;
    }

    const spawned = child;
    let settled = false;

    function finish(ok: boolean): void {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      resolve(ok);
    }

    const timer = setTimeout(() => {
      spawned.kill();
      finish(false);
    }, CLIPBOARD_TIMEOUT_MS);

    // Don't let a pending clipboard timer keep the process alive on its own.
    timer.unref();

    spawned.on('error', () => {
      finish(false);
    });
    spawned.on('close', (code) => {
      finish(code === 0);
    });
    spawned.stdin.on('error', () => {
      finish(false);
    });

    try {
      spawned.stdin.end(text);
    } catch {
      finish(false);
    }
  });
}

/**
 * Copies `text` to the system clipboard, returning whether it succeeded. Tries
 * each platform candidate until one works; returns false if none is available.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  for (const command of clipboardCommands()) {
    if (await runClipboardCommand(text, command)) {
      return true;
    }
  }

  return false;
}
