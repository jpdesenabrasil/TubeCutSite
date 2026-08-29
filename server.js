import express from "express";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";
const PUBLIC = path.join(process.cwd(), "public");
const TEMP = path.join(process.cwd(), "temp");

const MAX_CLIP_SECONDS = 15 * 60;
const CLEANUP_AFTER_MS = Number(process.env.CLEANUP_AFTER_MS || 20 * 60 * 1000);
const PROCESS_TIMEOUT_MS = Number(process.env.PROCESS_TIMEOUT_MS || 12 * 60 * 1000);
const INFO_TIMEOUT_MS = Number(process.env.INFO_TIMEOUT_MS || 45 * 1000);
const MAX_ACTIVE_JOBS = Number(process.env.MAX_ACTIVE_JOBS || 3);
const MAX_JOBS_PER_IP = Number(process.env.MAX_JOBS_PER_IP || 1);
const MIN_FREE_DISK_MB = Number(process.env.MIN_FREE_DISK_MB || 250);
const MAX_SOURCE_FILESIZE = process.env.MAX_SOURCE_FILESIZE || "700M";

app.set("trust proxy", 1); // Railway / reverse proxy
app.disable("x-powered-by");
app.use(express.json({ limit: "32kb", strict: true }));

// Security headers without extra dependencies.
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});

app.use(express.static(PUBLIC, {
  etag: true,
  maxAge: process.env.NODE_ENV === "production" ? "1h" : 0,
  dotfiles: "deny"
}));

await fs.mkdir(TEMP, { recursive: true });
// Anything left from a previous crash/redeploy is disposable.
await fs.rm(TEMP, { recursive: true, force: true }).catch(() => {});
await fs.mkdir(TEMP, { recursive: true });

const jobs = new Map();
const rateBuckets = new Map();

function clientIp(req) {
  return String(req.ip || req.socket?.remoteAddress || "unknown").slice(0, 128);
}

function rateLimit({ windowMs, max }) {
  return (req, res, next) => {
    const key = `${clientIp(req)}:${req.route?.path || req.path}`;
    const now = Date.now();
    let bucket = rateBuckets.get(key);
    if (!bucket || now >= bucket.resetAt) bucket = { count: 0, resetAt: now + windowMs };
    bucket.count += 1;
    rateBuckets.set(key, bucket);
    res.setHeader("RateLimit-Limit", String(max));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, max - bucket.count)));
    if (bucket.count > max) return res.status(429).json({ ok: false, error: "Muitas tentativas. Aguarde um pouco e tente novamente." });
    next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) if (now >= bucket.resetAt) rateBuckets.delete(key);
}, 5 * 60 * 1000).unref();

function cleanUrl(raw) {
  try {
    if (typeof raw !== "string" || raw.length > 2048) throw new Error();
    const u = new URL(raw.trim());
    if (u.protocol !== "https:") throw new Error();
    const host = u.hostname.toLowerCase().replace(/\.$/, "");
    const allowed = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtube-nocookie.com"]);
    if (!allowed.has(host)) throw new Error();
    if (u.username || u.password || u.port) throw new Error();

    // Keep only one video; discard playlist/mix/time tracking noise.
    ["list", "index", "start_radio", "si", "pp", "feature"].forEach(k => u.searchParams.delete(k));
    return u.toString();
  } catch {
    throw new Error("Informe uma URL HTTPS válida do YouTube.");
  }
}

function formatMB(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "N/A";
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function pickVideoFormats(info) {
  const heights = [1080, 720, 480, 360, 240, 144];
  const formats = info.formats || [];
  return heights.map(height => {
    const candidates = formats.filter(f => f.vcodec && f.vcodec !== "none" && Number(f.height) === height);
    if (!candidates.length) return { height, label: `${height}P`, size: null, filesize: null };
    candidates.sort((a, b) => {
      const score = f => (f.ext === "mp4" ? 10 : 0) + (f.vcodec?.startsWith("avc1") ? 8 : 0) + (f.acodec && f.acodec !== "none" ? 2 : 0);
      return score(b) - score(a);
    });
    const f = candidates[0];
    return { height, label: `${height}P`, ext: f.ext, format_id: f.format_id, filesize: f.filesize ?? f.filesize_approx ?? null, size: formatMB(f.filesize ?? f.filesize_approx) };
  });
}

function killChild(child) {
  if (!child || child.killed) return;
  try { child.kill("SIGTERM"); } catch {}
  setTimeout(() => { try { if (!child.killed) child.kill("SIGKILL"); } catch {} }, 2500).unref();
}

function runProcess(job, cmd, args, onLine, timeoutMs = PROCESS_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: process.env.HOME || os.homedir() }
    });
    if (job) job.child = child;
    let stderr = "", stdout = "";
    const timer = setTimeout(() => {
      killChild(child);
      reject(new Error("O processamento excedeu o tempo permitido e foi encerrado."));
    }, timeoutMs);
    timer.unref();

    child.stdout?.on("data", d => {
      const t = d.toString();
      stdout += t;
      if (stdout.length > 8_000_000) stdout = stdout.slice(-8_000_000);
      t.split(/\r?\n/).forEach(line => onLine?.(line, "stdout"));
    });
    child.stderr?.on("data", d => {
      const t = d.toString();
      stderr += t;
      if (stderr.length > 2_000_000) stderr = stderr.slice(-2_000_000);
      t.split(/\r?\n/).forEach(line => onLine?.(line, "stderr"));
    });
    child.once("error", err => { clearTimeout(timer); reject(err); });
    child.once("close", code => {
      clearTimeout(timer);
      if (job) job.child = null;
      if (job?.cancelled) return reject(new Error("Processamento cancelado."));
      code === 0 ? resolve({ stdout, stderr }) : reject(new Error((stderr || `Processo terminou com código ${code}`).slice(-4000)));
    });
  });
}

async function cleanupJob(job) {
  if (!job) return;
  killChild(job.child);
  job.child = null;
  await fs.rm(job.work, { recursive: true, force: true }).catch(() => {});
  jobs.delete(job.id);
}

async function hasEnoughDisk() {
  try {
    const stat = await fs.statfs(TEMP);
    const free = Number(stat.bavail) * Number(stat.bsize);
    return free >= MIN_FREE_DISK_MB * 1024 * 1024;
  } catch {
    return true;
  }
}

function activeJobsForIp(ip) {
  let n = 0;
  for (const job of jobs.values()) if (job.ip === ip && job.status === "running") n += 1;
  return n;
}

async function getVideoInfo(url) {
  const { stdout } = await runProcess(null, "yt-dlp", [
    "--force-ipv4",
    "--extractor-args", "youtube:player_client=web_embedded",
    "--no-playlist",
    "--socket-timeout", "20",
    "--retries", "2",
    "--extractor-retries", "2",
    "--dump-single-json",
    "--no-warnings",
    "--skip-download",
    url
  ], null, INFO_TIMEOUT_MS);
  return JSON.parse(stdout);
}

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/api/info", rateLimit({ windowMs: 60_000, max: 12 }), async (req, res) => {
  try {
    const url = cleanUrl(req.body?.url);
    const info = await getVideoInfo(url);
    res.json({ ok: true, title: info.title || "Vídeo", thumbnail: info.thumbnail || null, duration: Number(info.duration || 0), formats: pickVideoFormats(info) });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || "Não foi possível analisar o vídeo." });
  }
});

app.post("/api/jobs", rateLimit({ windowMs: 60_000, max: 6 }), async (req, res) => {
  try {
    const ip = clientIp(req);
    if ([...jobs.values()].filter(j => j.status === "running").length >= MAX_ACTIVE_JOBS) {
      return res.status(503).json({ ok: false, error: "Servidor ocupado no momento. Tente novamente em instantes." });
    }
    if (activeJobsForIp(ip) >= MAX_JOBS_PER_IP) {
      return res.status(429).json({ ok: false, error: "Você já possui um processamento em andamento." });
    }
    if (!(await hasEnoughDisk())) {
      return res.status(507).json({ ok: false, error: "Armazenamento temporário quase cheio. Tente novamente em instantes." });
    }

    const url = cleanUrl(req.body?.url);
    const start = Number(req.body?.start ?? 0);
    const end = Number(req.body?.end ?? 30);
    const height = Number(req.body?.height ?? 1080);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) throw new Error("Intervalo de corte inválido.");
    if (end - start > MAX_CLIP_SECONDS) throw new Error("O trecho máximo permitido é de 15 minutos.");
    if (![1080, 720, 480, 360, 240, 144].includes(height)) throw new Error("Resolução inválida.");

    // Revalidate server-side instead of trusting data from /api/info or the browser.
    const info = await getVideoInfo(url);
    const fullDuration = Number(info.duration || 0);
    if (fullDuration > 0 && (start >= fullDuration || end > fullDuration + 1)) throw new Error("O intervalo selecionado ultrapassa a duração do vídeo.");

    const outputMode = ["original", "vertical_crop", "vertical_blur"].includes(req.body?.outputMode) ? req.body.outputMode : "original";
    const cropPosition = ["left", "center", "right"].includes(req.body?.cropPosition) ? req.body.cropPosition : "center";
    const customName = String(req.body?.customName || "recorte").trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, "").slice(0, 80) || "recorte";
    const watermarkEnabled = Boolean(req.body?.watermarkEnabled);
    const watermarkText = String(req.body?.watermarkText || "").trim().slice(0, 80);
    const watermarkPosition = ["top-left", "top-right", "center", "bottom-left", "bottom-right"].includes(req.body?.watermarkPosition) ? req.body.watermarkPosition : "bottom-right";
    const watermarkSize = Math.max(18, Math.min(96, Number(req.body?.watermarkSize || 36)));
    const watermarkOpacity = Math.max(0.15, Math.min(1, Number(req.body?.watermarkOpacity || 0.7)));

    const id = crypto.randomBytes(18).toString("hex");
    const work = path.join(TEMP, id);
    await fs.mkdir(work, { recursive: true });
    const job = {
      id, ip, work, url, start, end, height, outputMode,
      watermarkEnabled, watermarkText, watermarkPosition, watermarkSize, watermarkOpacity, cropPosition, customName,
      stage: "Preparando", progress: 1, status: "running", cancelled: false, child: null,
      output: path.join(work, "recorte.mp4"), error: null, createdAt: Date.now()
    };
    jobs.set(id, job);
    res.json({ ok: true, jobId: id });

    processJob(job).catch(async err => {
      if (!job.cancelled) {
        job.status = "error";
        job.error = String(err?.message || "Erro no processamento").slice(0, 500);
        job.stage = "Erro";
      }
      setTimeout(() => cleanupJob(job), 60_000).unref();
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || "Não foi possível iniciar o processamento." });
  }
});

function escapeDrawtextText(text) {
  return String(text || "")
    .replace(/\\/g, "\\\\\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/%/g, "\\%")
    .replace(/\r?\n/g, " ");
}

function watermarkPositionExpr(position) {
  const pad = 38;
  switch (position) {
    case "top-left": return { x: String(pad), y: String(pad) };
    case "top-right": return { x: `w-text_w-${pad}`, y: String(pad) };
    case "center": return { x: "(w-text_w)/2", y: "(h-text_h)/2" };
    case "bottom-left": return { x: String(pad), y: `h-text_h-${pad}` };
    default: return { x: `w-text_w-${pad}`, y: `h-text_h-${pad}` };
  }
}

function buildWatermarkFilter(job) {
  if (!job.watermarkEnabled || !job.watermarkText) return null;
  const { x, y } = watermarkPositionExpr(job.watermarkPosition);
  const text = escapeDrawtextText(job.watermarkText);
  const opacity = Math.max(0.15, Math.min(1, Number(job.watermarkOpacity || 0.7)));
  const size = Math.max(18, Math.min(96, Number(job.watermarkSize || 36)));
  // Installed in the Docker image. Works on Railway/Linux and locally if this path exists.
  const font = process.env.TUBECUT_FONT_FILE || "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
  return [
    `drawtext=fontfile='${font}'`, `text='${text}'`, `fontcolor=white@${opacity}`, `fontsize=${size}`,
    `x=${x}`, `y=${y}`, "borderw=2", "bordercolor=black@0.65", "shadowcolor=black@0.55", "shadowx=2", "shadowy=2"
  ].join(":");
}

async function processJob(job) {
  const inputPattern = path.join(job.work, "source.%(ext)s");
  const clipDuration = job.end - job.start;
  job.stage = "Baixando trecho";
  job.progress = 3;

  // Critical storage protection: download only the selected section, not the entire source video.
  await runProcess(job, "yt-dlp", [
    "--force-ipv4",
    "--extractor-args", "youtube:player_client=web_embedded",
    "--newline",
    "--socket-timeout", "20",
    "--retries", "2",
    "--fragment-retries", "2",
    "--no-warnings",
    "--no-playlist",
    "--max-filesize", MAX_SOURCE_FILESIZE,
    "--download-sections", `*${job.start}-${job.end}`,
    "--force-keyframes-at-cuts",
    "-f", `bv*[height<=${job.height}][ext=mp4]+ba[ext=m4a]/b[height<=${job.height}][ext=mp4]/b[height<=${job.height}]`,
    "--merge-output-format", "mp4",
    "-o", inputPattern,
    job.url
  ], line => {
    const m = line.match(/\[download\]\s+([\d.]+)%/);
    if (m) job.progress = Math.min(70, 3 + Number(m[1]) * 0.67);
  });

  const entries = await fs.readdir(job.work);
  const source = entries.find(x => /^source\./.test(x) && !x.endsWith(".part"));
  if (!source) throw new Error("Não foi possível localizar o trecho baixado.");
  if (!(await hasEnoughDisk())) throw new Error("O servidor ficou sem espaço temporário suficiente.");

  job.stage = job.watermarkEnabled && job.watermarkText ? "Finalizando + marca d’água" : "Finalizando";
  job.progress = 72;
  const args = ["-y", "-i", path.join(job.work, source), "-t", String(clipDuration)];
  const watermarkFilter = buildWatermarkFilter(job);

  if (job.outputMode === "vertical_crop") {
    let xExpr = "(iw-ow)/2";
    if (job.cropPosition === "left") xExpr = "0";
    if (job.cropPosition === "right") xExpr = "iw-ow";
    let vf = `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:${xExpr}:0`;
    if (watermarkFilter) vf += "," + watermarkFilter;
    args.push("-vf", vf);
  } else if (job.outputMode === "vertical_blur") {
    let filter = "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=28:14[bg];" +
                 "[0:v]scale=1080:1920:force_original_aspect_ratio=decrease[fg];";
    filter += watermarkFilter ? `[bg][fg]overlay=(W-w)/2:(H-h)/2,${watermarkFilter}[v]` : "[bg][fg]overlay=(W-w)/2:(H-h)/2[v]";
    args.push("-filter_complex", filter, "-map", "[v]", "-map", "0:a?");
  } else if (watermarkFilter) {
    args.push("-vf", watermarkFilter);
  }

  args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-movflags", "+faststart", "-progress", "pipe:2", "-nostats", job.output);
  await runProcess(job, "ffmpeg", args, line => {
    const m = line.match(/^out_time_ms=(\d+)/);
    if (m) {
      const seconds = Number(m[1]) / 1_000_000;
      job.progress = Math.min(98, 72 + (seconds / Math.max(0.1, clipDuration)) * 26);
    }
  });

  // Remove the downloaded source immediately; only final output remains until download/expiry.
  await fs.rm(path.join(job.work, source), { force: true }).catch(() => {});
  job.progress = 100;
  job.stage = "Arquivo pronto";
  job.status = "done";
  setTimeout(() => cleanupJob(job), CLEANUP_AFTER_MS).unref();
}

app.get("/api/jobs/:id", rateLimit({ windowMs: 60_000, max: 180 }), (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: "Processamento não encontrado ou já limpo." });
  if (job.ip !== clientIp(req)) return res.status(404).json({ ok: false, error: "Processamento não encontrado." });
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, status: job.status, stage: job.stage, progress: Math.round(job.progress), error: job.error });
});

app.post("/api/jobs/:id/cancel", rateLimit({ windowMs: 60_000, max: 20 }), async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.ip !== clientIp(req)) return res.status(404).json({ ok: false, error: "Processamento não encontrado." });
  job.cancelled = true;
  job.status = "cancelled";
  job.stage = "Cancelado";
  await cleanupJob(job);
  res.json({ ok: true });
});

app.get("/api/jobs/:id/file", rateLimit({ windowMs: 60_000, max: 10 }), (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.ip !== clientIp(req) || job.status !== "done") return res.status(404).send("Arquivo ainda não está pronto.");
  const suffix = job.outputMode === "original" ? `${job.height}p` : "1080x1920";
  const safeName = (job.customName || "recorte").replace(/[<>:"/\\|?*\x00-\x1F]/g, "").slice(0, 80) || "recorte";
  res.setHeader("Cache-Control", "no-store");
  let cleaned = false;
  const cleanOnce = async () => { if (!cleaned) { cleaned = true; await cleanupJob(job); } };
  res.download(job.output, `${safeName}-${suffix}.mp4`, err => {
    cleanOnce();
    if (err && !res.headersSent) res.status(500).send("Falha ao enviar o arquivo.");
  });
  res.once("close", cleanOnce);
});

setInterval(async () => {
  const now = Date.now();
  for (const job of [...jobs.values()]) {
    if (now - job.createdAt > CLEANUP_AFTER_MS + PROCESS_TIMEOUT_MS) await cleanupJob(job);
  }
}, 5 * 60 * 1000).unref();

app.get("/", (_req, res) => res.sendFile(path.join(PUBLIC, "index.html")));
app.use((req, res) => res.status(404).json({ ok: false, error: "Rota não encontrada." }));

const server = app.listen(PORT, HOST, () => console.log(`TubeCut online em ${HOST}:${PORT}`));

async function shutdown(signal) {
  console.log(`${signal}: encerrando TubeCut e limpando temporários...`);
  server.close();
  for (const job of [...jobs.values()]) await cleanupJob(job);
  await fs.rm(TEMP, { recursive: true, force: true }).catch(() => {});
  process.exit(0);
}
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
