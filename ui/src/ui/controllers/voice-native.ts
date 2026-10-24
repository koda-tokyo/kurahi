import type { VoiceCapture, VoiceHost } from "./voice";

/**
 * Native desktop capture commands. The transport is injected by the desktop shell; this module
 * never reaches for a global IPC object or browser media access.
 *
 * Pull model: the bridge reads one chunk at a time and only reads again after the gateway write
 * resolved, so the native side buffers at most its own bounded queue (backpressure by design).
 */
export type NativeVoiceTransport = {
  // Whether a microphone and the capture commands exist; false keeps push-to-talk disabled.
  available: () => Promise<boolean>;
  // Open a capture handle (PCM16 LE, mono, 16 kHz). Each call returns a distinct handle id.
  open: () => Promise<string>;
  // Next base64 chunk, waiting while capture runs; null once the handle is stopped and drained.
  read: (handle: string) => Promise<string | null>;
  // Stop capturing; buffered audio stays readable until read returns null.
  stop: (handle: string) => Promise<void>;
  // Stop, discard buffers and release the microphone. Idempotent; unknown handles are ignored.
  cancel: (handle: string) => Promise<void>;
};

export function nativeVoiceCapture(transport: NativeVoiceTransport): () => VoiceCapture {
  return () => {
    let handle: string | null = null;
    let cancelled = false;
    let pump: Promise<void> = Promise.resolve();
    const discard = (id: string) => {
      void transport.cancel(id).catch(() => {});
    };
    return {
      async start(write, failed) {
        const id = await transport.open();
        if (cancelled) {
          // Cancelled during startup: release the handle that just opened.
          discard(id);
          return;
        }
        handle = id;
        pump = (async () => {
          try {
            for (;;) {
              const chunk = await transport.read(id);
              if (cancelled || chunk === null) {
                return;
              }
              await write(chunk);
            }
          } catch {
            if (!cancelled) {
              cancelled = true;
              discard(id);
              failed();
            }
          }
        })();
      },
      async stop() {
        if (cancelled || handle === null) {
          return;
        }
        await transport.stop(handle);
        // Resolve only after the final chunk has been written.
        await pump;
      },
      cancel() {
        if (cancelled) {
          return;
        }
        cancelled = true;
        if (handle !== null) {
          discard(handle);
        }
      },
    };
  };
}

/** Install native capture only when the desktop shell reports it available. */
export async function installNativeVoice(
  host: Pick<VoiceHost, "voiceCapture">,
  transport: NativeVoiceTransport | null,
) {
  if (!transport) {
    return false;
  }
  let ok = false;
  try {
    ok = await transport.available();
  } catch {
    ok = false;
  }
  host.voiceCapture = ok ? nativeVoiceCapture(transport) : null;
  return ok;
}
