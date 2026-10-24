// Ephemeral audio on disk. Audio lives in memory; when an engine needs a file, it goes into a
// private temp dir (0700) as a 0600 file and the whole dir is removed when the session ends,
// whatever the outcome. Only an explicit admin opt-in (voice.privacy.keepAudio + keepAudioDir)
// moves the WAV files to the keep dir instead.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EphemeralAudio } from "./types.js";
import { VOICE_SAMPLE_RATE } from "./types.js";

/** A canonical 44-byte WAV header for PCM16 mono at the session sample rate. */
export function wavHeader(dataBytes: number, sampleRate = VOICE_SAMPLE_RATE): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16); // fmt chunk size
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28); // byte rate
  h.writeUInt16LE(2, 32); // block align
  h.writeUInt16LE(16, 34); // bits per sample
  h.write("data", 36, "ascii");
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

export type EphemeralAudioOptions = {
  /** Parent for the private temp dir (default os.tmpdir()). */
  tmpRoot?: string;
  /** Admin opt-in: move WAV files here (0600) on dispose instead of deleting them. */
  keepDir?: string;
  /** Session id used to name kept files. */
  label: string;
};

export class EphemeralAudioDir implements EphemeralAudio {
  private dirPromise: Promise<string> | null = null;
  private counter = 0;
  private disposed = false;

  constructor(private readonly opts: EphemeralAudioOptions) {}

  /** The private dir, once something was written (tests). */
  async currentDir(): Promise<string | null> {
    return this.dirPromise ? await this.dirPromise : null;
  }

  private dir(): Promise<string> {
    if (this.disposed) {
      return Promise.reject(new Error("voice temp storage already released"));
    }
    this.dirPromise ??= fs
      .mkdtemp(path.join(this.opts.tmpRoot ?? os.tmpdir(), "kurahi-voice-"))
      .then(async (dir) => {
        await fs.chmod(dir, 0o700);
        return dir;
      });
    return this.dirPromise;
  }

  async writeWav(pcm: Buffer): Promise<string> {
    const dir = await this.dir();
    const file = path.join(dir, `audio-${++this.counter}.wav`);
    const handle = await fs.open(file, "wx", 0o600);
    try {
      await handle.writeFile(Buffer.concat([wavHeader(pcm.length), pcm]));
    } finally {
      await handle.close();
    }
    return file;
  }

  async outputBase(): Promise<string> {
    const dir = await this.dir();
    return path.join(dir, `out-${++this.counter}`);
  }

  /** Delete (or, with the admin opt-in, keep) everything this session put on disk. Idempotent. */
  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (!this.dirPromise) {
      return;
    }
    let dir: string;
    try {
      dir = await this.dirPromise;
    } catch {
      return;
    }
    try {
      if (this.opts.keepDir) {
        await fs.mkdir(this.opts.keepDir, { recursive: true, mode: 0o700 });
        const entries = await fs.readdir(dir);
        for (const name of entries.filter((n) => n.endsWith(".wav"))) {
          const dest = path.join(this.opts.keepDir, `${this.opts.label}-${name}`);
          await fs.copyFile(path.join(dir, name), dest);
          await fs.chmod(dest, 0o600);
        }
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
}
