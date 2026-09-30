/**
 * Frame-accurate page recording via the Chrome DevTools screencast: every painted frame is saved with its
 * timestamp, then ffmpeg rebuilds a constant-30fps H.264 clip with each frame held for its real duration.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CDPSession, Page } from "playwright-core";

const FFMPEG = process.env.FFMPEG ?? join(process.env.USERPROFILE ?? "", "tools", "ffmpeg-9.0.2-essentials_build", "bin", "ffmpeg.exe");

export interface Recording {
  stop(): Promise<string>;
}

export async function startRecording(page: Page, outFile: string): Promise<Recording> {
  const dir = resolve(`${outFile}.frames`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const frames: { file: string; ts: number }[] = [];
  const cdp: CDPSession = await page.context().newCDPSession(page);
  cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
    const file = join(dir, `${String(frames.length).padStart(6, "0")}.jpg`);
    writeFileSync(file, Buffer.from(data, "base64"));
    frames.push({ file, ts: metadata.timestamp ?? Date.now() / 1000 });
    await cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined);
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: 1920, maxHeight: 1080 });

  return {
    async stop() {
      await cdp.send("Page.stopScreencast").catch(() => undefined);
      const end = Date.now() / 1000;
      if (frames.length === 0) throw new Error("No frames captured");
      const list = frames
        .map((f, i) => `file '${f.file.replace(/\\/g, "/")}'\nduration ${((frames[i + 1]?.ts ?? end) - f.ts).toFixed(4)}`)
        .join("\n");
      const listFile = join(dir, "frames.ffconcat");
      writeFileSync(listFile, `ffconcat version 1.0\n${list}\nfile '${frames.at(-1)!.file.replace(/\\/g, "/")}'\n`);
      const args = ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-vf",
        "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p",
        "-c:v", "libx264", "-crf", "16", "-preset", "slow", resolve(outFile)];
      const run = spawnSync(FFMPEG, args, { encoding: "utf8" });
      if (run.status !== 0) throw new Error(`ffmpeg failed: ${run.stderr.slice(-800)}`);
      return resolve(outFile);
    },
  };
}
