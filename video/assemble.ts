/**
 * Assembles the demo video from the rendered 3D shots, the recorded app footage, the cards and the narration.
 * Narration: your takes in video/voice/<segment>.(wav|m4a|mp3) win; the Kokoro guide in video/out/vo/ fills gaps.
 * Every block is timed to its narration, so the edit re-times itself to whoever reads it.
 *   node video/assemble.ts   ->  video/out/exit-market-demo.mp4 (+ .srt, + -captioned.mp4)
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TOOLS = join(process.env.USERPROFILE ?? "", "tools", "ffmpeg-9.0.2-essentials_build", "bin");
const FFMPEG = process.env.FFMPEG ?? join(TOOLS, "ffmpeg.exe");
const FFPROBE = process.env.FFPROBE ?? join(TOOLS, "ffprobe.exe");
const OUT = "video/out";
const BLOCKS = `${OUT}/blocks`;
const FADE = 0.35;

/** A recorded clip or a still card. `from`/`to` trim page-load time; `hold` freezes the last frame. */
type Clip = { file: string; from?: number; to?: number; hold?: number };
type Visual =
  | { kind: "shot"; dir: string; minSeconds: number }
  | { kind: "clips"; files: Clip[]; tag: boolean }
  | { kind: "cards"; files: string[] };
const STILL_SECONDS = 2.5;
const MAX_SPEED = 1.6; // recordings are sped up at most this much; a longer block just outlasts its narration
type Overlay = { card: string; at: number; until?: number }; // fractions of the block's narration span
interface Block {
  id: string;
  voice: string[];
  lead: number;
  visual: Visual;
  overlays?: Overlay[];
}

const TIMELINE: Block[] = [
  { id: "intro", voice: ["01-lock", "02-stakes"], lead: 0.6, visual: { kind: "shot", dir: "shot1_lock", minSeconds: 20 },
    overlays: [{ card: "stakes-1", at: 0.36, until: 0.55 }, { card: "stakes-2", at: 0.56, until: 0.77 }, { card: "stakes-3", at: 0.78 }] },
  { id: "hook", voice: ["03-hook"], lead: 0.5, visual: { kind: "shot", dir: "shot2_hook", minSeconds: 16.4 },
    overlays: [{ card: "zero", at: 0.38, until: 0.95 }] },
  { id: "proof", voice: ["04-proof"], lead: 0.5, visual: { kind: "shot", dir: "shot3_proof", minSeconds: 16 } },
  { id: "sale", voice: ["05-sale"], lead: 0.4, visual: { kind: "clips", tag: true,
    files: [{ file: "capture/withdraw.mp4", from: 3.5, to: 14.5 }, { file: "cards/skip.png" }, { file: "capture/sell.mp4", from: 3.0, to: 22 }] } },
  { id: "gasless", voice: ["06-gasless"], lead: 0.4, visual: { kind: "clips", tag: true,
    files: [{ file: "capture/gasless-start.mp4", from: 5.0 }, { file: "capture/gasless-settled.mp4", from: 4.0 }] } },
  { id: "listing", voice: ["06b-listing"], lead: 0.4, visual: { kind: "clips", tag: true,
    files: [{ file: "capture/list.mp4", from: 3.0, to: 21 }, { file: "capture/buy-listing.mp4", from: 6.0, to: 21 }] } },
  { id: "vault", voice: ["07-vault"], lead: 0.4, visual: { kind: "shot", dir: "shot4_vault", minSeconds: 12.5 } },
  { id: "explorer", voice: ["08-explorer"], lead: 0.3, visual: { kind: "clips", tag: true, files: [{ file: "capture/explorer.mp4", from: -17.5, to: -5 }] } },
  { id: "depth", voice: ["09-depth"], lead: 0.4, visual: { kind: "cards", files: ["bold", "stylus", "quality"] } },
  { id: "close", voice: ["10-close"], lead: 0.3, visual: { kind: "shot", dir: "shot5_close", minSeconds: 12.5 } },
];

function run(bin: string, args: string[]): string {
  const r = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${bin} ${args.slice(0, 6).join(" ")}… failed:\n${r.stderr.slice(-1500)}`);
  return r.stdout;
}

const duration = (file: string) =>
  Number(run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).trim());

function voiceFile(segment: string): string {
  for (const ext of ["wav", "m4a", "mp3"]) {
    const mine = `video/voice/${segment}.${ext}`;
    if (existsSync(mine)) return mine;
  }
  return `${OUT}/vo/${segment}.wav`;
}

/** Narration clips laid end to end after `lead`, with a short gap between segments. */
function placeVoice(block: Block) {
  let t = block.lead;
  return block.voice.map((segment) => {
    const file = voiceFile(segment);
    const len = duration(file);
    const placed = { segment, file, start: t, len };
    t += len + 0.25;
    return placed;
  });
}

function visualInputs(block: Block, target: number): { args: string[]; chain: string; length: number } {
  const v = block.visual;
  if (v.kind === "shot") {
    const frames = `${OUT}/shots/${v.dir}/frame_%04d.png`;
    return { args: ["-framerate", "30", "-i", frames], chain: `[0:v]tpad=stop_mode=clone:stop_duration=${target}`, length: target };
  }
  if (v.kind === "cards") {
    const each = target / v.files.length;
    // One still frame per card: zoompan expands each INPUT frame into `d` output frames.
    const args = v.files.flatMap((f) => ["-i", `${OUT}/cards/${f}.png`]);
    const zoomed = v.files.map((_, i) =>
      `[${i}:v]scale=2112:1188,zoompan=z='1+0.0006*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${Math.ceil(each * 30)}:s=1920x1080:fps=30,fade=t=in:d=0.3,fade=t=out:st=${(each - 0.3).toFixed(2)}:d=0.3[c${i}]`);
    return { args, chain: `${zoomed.join(";")};${v.files.map((_, i) => `[c${i}]`).join("")}concat=n=${v.files.length}:v=1:a=0`, length: target };
  }
  // clips: stills get STILL_SECONDS; recordings are trimmed, then sped up (at most MAX_SPEED) toward the narration
  const isStill = (c: Clip) => c.file.endsWith(".png");
  const spans = v.files.map((c) => {
    if (isStill(c)) return { from: 0, len: STILL_SECONDS };
    const full = duration(`${OUT}/${c.file}`);
    const at = (t: number | undefined, fallback: number) => (t === undefined ? fallback : t < 0 ? full + t : t); // negative = from the end
    const from = at(c.from, 0);
    return { from, len: at(c.to, full) - from };
  });
  const recorded = spans.reduce((a, s, i) => a + (isStill(v.files[i]) ? 0 : s.len), 0);
  const holds = v.files.reduce((a, c) => a + (c.hold ?? 0), 0);
  const stills = spans.reduce((a, s, i) => a + (isStill(v.files[i]) ? s.len : 0), 0) + holds;
  const speed = Math.min(MAX_SPEED, Math.max(1, recorded / Math.max(1, target + 2 - stills)));
  const args = v.files.flatMap((c) => (isStill(c) ? ["-loop", "1", "-t", String(STILL_SECONDS), "-framerate", "30", "-i", `${OUT}/${c.file}`] : ["-i", `${OUT}/${c.file}`]));
  const parts = v.files.map((c, i) => {
    const s = spans[i];
    const timing = isStill(c) ? "" : `trim=start=${s.from.toFixed(2)}:duration=${s.len.toFixed(2)},setpts=(PTS-STARTPTS)/${speed.toFixed(3)},`;
    const hold = c.hold ? `,tpad=stop_mode=clone:stop_duration=${c.hold}` : "";
    return `[${i}:v]${timing}fps=30,scale=1920:1080,setsar=1${hold}[p${i}]`;
  });
  const length = recorded / speed + stills;
  return { args, chain: `${parts.join(";")};${v.files.map((_, i) => `[p${i}]`).join("")}concat=n=${v.files.length}:v=1:a=0,tpad=stop_mode=clone:stop_duration=${Math.max(0, target - length).toFixed(2)}`, length: Math.max(target, length) };
}

function buildBlock(block: Block, index: number) {
  const voice = placeVoice(block);
  const spoken = voice.at(-1)!.start + voice.at(-1)!.len + 0.6;
  const min = block.visual.kind === "shot" ? block.visual.minSeconds : 0;
  const { args, chain, length } = visualInputs(block, Math.max(spoken, min));
  const total = Math.max(length, spoken, min);
  const inputs = [...args];
  let graph = `${chain},trim=duration=${total.toFixed(3)},setpts=PTS-STARTPTS[base]`;
  let last = "base";
  const inputCount = () => inputs.filter((a) => a === "-i").length;

  const span0 = voice[0].start;
  const span = voice.at(-1)!.start + voice.at(-1)!.len - span0;
  const overlays = [...(block.overlays ?? []), ...(block.visual.kind === "clips" && block.visual.tag ? [{ card: "live-tag", at: -1 }] : [])];
  for (const o of overlays) {
    inputs.push("-loop", "1", "-i", `${OUT}/cards/${o.card}.png`);
    const idx = inputCount() - 1;
    const from = o.at < 0 ? 0 : span0 + o.at * span;
    const to = o.until === undefined ? total : span0 + o.until * span;
    graph += `;[${idx}:v]format=rgba,fade=t=in:st=${from.toFixed(2)}:d=0.3:alpha=1,fade=t=out:st=${(to - 0.3).toFixed(2)}:d=0.3:alpha=1[o${idx}]` +
      `;[${last}][o${idx}]overlay=0:0:shortest=1[v${idx}]`;
    last = `v${idx}`;
  }
  graph += `;[${last}]fade=t=in:d=${FADE},fade=t=out:st=${(total - FADE).toFixed(3)}:d=${FADE},format=yuv420p[vout]`;

  const audioStart = inputCount();
  voice.forEach((v) => inputs.push("-i", v.file));
  const delayed = voice.map((v, i) => `[${audioStart + i}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${Math.round(v.start * 1000)}:all=1[a${i}]`);
  graph += `;${delayed.join(";")};${voice.map((_, i) => `[a${i}]`).join("")}amix=inputs=${voice.length}:normalize=0,apad,atrim=duration=${total.toFixed(3)}[aout]`;

  const file = `${BLOCKS}/${String(index).padStart(2, "0")}-${block.id}.mp4`;
  run(FFMPEG, ["-y", ...inputs, "-filter_complex", graph, "-map", "[vout]", "-map", "[aout]", "-t", total.toFixed(3),
    "-c:v", "libx264", "-crf", "17", "-preset", "medium", "-r", "30", "-c:a", "aac", "-b:a", "192k", file]);
  console.log(`${file}: ${total.toFixed(1)}s (voice: ${voice.map((v) => v.file).join(", ")})`);
  return { file, total, voice };
}

const CAPTION_CHARS = 62;

/** Splits narration into short caption phrases (sentence, then comma boundaries), each at most CAPTION_CHARS. */
function captionChunks(text: string): string[] {
  const chunks: string[] = [];
  for (const sentence of text.match(/[^.?!]+[.?!]+/g) ?? [text]) {
    let line = "";
    for (const part of sentence.trim().split(/(?<=,)\s+/)) {
      for (const word of part.split(/\s+/)) {
        if (line && (line + " " + word).length > CAPTION_CHARS) {
          chunks.push(line);
          line = word;
        } else {
          line = line ? `${line} ${word}` : word;
        }
      }
      if (line.length > CAPTION_CHARS * 0.6) {
        chunks.push(line);
        line = "";
      }
    }
    if (line) chunks.push(line);
  }
  return chunks;
}

/** One cue per phrase, timed across the clip in proportion to its length. */
function cuesFor(text: string, start: number, len: number): { from: number; to: number; text: string }[] {
  const chunks = captionChunks(text);
  const total = chunks.reduce((a, c) => a + c.length, 0);
  let t = start;
  return chunks.map((chunk) => {
    const span = (len * chunk.length) / total;
    const cue = { from: t, to: t + span, text: chunk };
    t += span;
    return cue;
  });
}

function srtTime(s: number) {
  const ms = Math.round(s * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

function main() {
  mkdirSync(BLOCKS, { recursive: true });
  const script = JSON.parse(readFileSync("video/script.json", "utf8")) as { segments: { id: string; text: string }[] };
  const text = new Map(script.segments.map((s) => [s.id, s.text]));
  let offset = 0;
  const cues: string[] = [];
  const built = TIMELINE.map((block, i) => {
    const b = buildBlock(block, i);
    for (const v of b.voice) {
      // v.len includes the narration's tail pause; captions end with the speech
      for (const cue of cuesFor(text.get(v.segment) ?? "", offset + v.start, Math.max(0.5, v.len - 0.6))) {
        cues.push(`${cues.length + 1}\n${srtTime(cue.from)} --> ${srtTime(cue.to)}\n${cue.text}\n`);
      }
    }
    offset += b.total;
    return b;
  });

  const list = `${BLOCKS}/blocks.txt`;
  writeFileSync(list, built.map((b) => `file '${b.file.split("/").pop()}'`).join("\n"));
  const final = `${OUT}/exit-market-demo.mp4`;
  run(FFMPEG, ["-y", "-f", "concat", "-safe", "0", "-i", list, "-c:v", "copy", "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-c:a", "aac", "-b:a", "192k", final]);
  writeFileSync(`${OUT}/exit-market-demo.srt`, cues.join("\n"));
  run(FFMPEG, ["-y", "-i", final, "-vf", `subtitles=${OUT}/exit-market-demo.srt:fontsdir=video/assets/fonts:force_style='FontName=Inter,FontSize=14,PrimaryColour=&H00FFFFFF,OutlineColour=&H50000000,BorderStyle=3,Outline=5,Shadow=0,MarginV=30'`,
    "-c:v", "libx264", "-crf", "17", "-preset", "medium", "-c:a", "copy", `${OUT}/exit-market-demo-captioned.mp4`]);
  console.log(`\n${final}: ${offset.toFixed(1)}s total (+ captioned version and .srt)`);
}

main();
