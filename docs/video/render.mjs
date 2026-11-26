import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "termclaw-film-"));
const localCli = join(
  root,
  "node_modules",
  "@remotion",
  "cli",
  "remotion-cli.js",
);

function run(program, args) {
  const result = spawnSync(program, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(program + " failed with status " + result.status);
}

try {
  const picture = join(scratch, "picture.mp4");
  const metadata = join(scratch, "chapters.txt");
  const timeline = JSON.parse(
    readFileSync(join(root, "timeline.json"), "utf8"),
  );
  const chapters = timeline.map(({ start, frames, title }) =>
    [
      "[CHAPTER]",
      "TIMEBASE=1/24",
      "START=" + start,
      "END=" + (start + frames),
      "title=" + title,
    ].join("\n"),
  );
  writeFileSync(
    metadata,
    [";FFMETADATA1", "title=TermClaw | Remote terminals and AI coding agents", ...chapters].join(
      "\n",
    ) + "\n",
  );
  run(process.execPath, [
    localCli,
    "render",
    "src/index.tsx",
    "TermClaw",
    picture,
    "--muted",
    "--crf=17",
    "--jpeg-quality=94",
  ]);
  run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    picture,
    "-i",
    "public/score.m4a",
    "-i",
    "TermClaw.en.srt",
    "-f",
    "ffmetadata",
    "-i",
    metadata,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-map",
    "2:s:0",
    "-map_metadata",
    "3",
    "-map_chapters",
    "3",
    "-c:v",
    "copy",
    "-c:a",
    "copy",
    "-c:s",
    "mov_text",
    "-metadata:s:a:0",
    "language=eng",
    "-metadata:s:s:0",
    "language=eng",
    "-disposition:s:0",
    "0",
    "-movflags",
    "+faststart",
    "TermClaw.mp4",
  ]);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
