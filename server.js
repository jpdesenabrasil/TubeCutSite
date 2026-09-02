import express from "express";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const YTDLP_BIN = process.env.YTDLP_BIN || "yt-dlp";
const FFMPEG_BIN = process.env.FFMPEG_BIN || "ffmpeg";
const MAX_CONCURRENT_JOBS = Math.max(1, Number(process.env.MAX_CONCURRENT_JOBS || 2));
const PUBLIC = path.join(process.cwd(), "public");
const TEMP = path.join(process.cwd(), "temp");
const YTDLP_COOKIES_B64 = String(process.env.YTDLP_COOKIES_B64 || "").trim();
const COOKIE_FILE = path.join(TEMP, ".youtube-cookies.txt");

app.use(express.json({ limit: "1mb" }));
app.use(express.static(PUBLIC));
await fs.mkdir(TEMP, { recursive: true });

let cookiesConfigured = false;
if (YTDLP_COOKIES_B64) {
  try {
    const decoded = Buffer.from(YTDLP_COOKIES_B64.replace(/\s+/g, ""), "base64");
    const text = decoded.toString("utf8");
    if (!text.includes("# Netscape HTTP Cookie File") && !text.includes("youtube.com")) {
      throw new Error("conteúdo não parece um arquivo cookies.txt válido");
    }
    await fs.writeFile(COOKIE_FILE, decoded, { mode: 0o600 });
    cookiesConfigured = true;
    console.log("Cookies do YouTube: configurados via variável secreta.");
  } catch (err) {
    console.error("Cookies do YouTube: YTDLP_COOKIES_B64 inválida:", err.message);
  }
} else {
  console.log("Cookies do YouTube: não configurados.");
}

function ytDlpCookieArgs() {
  return cookiesConfigured ? ["--cookies", COOKIE_FILE] : [];
}

function friendlyYtDlpError(message) {
  const text = String(message || "");
  if (/Sign in to confirm you.?re not a bot|cookies-from-browser|cookies for the authentication|LOGIN_REQUIRED|account.*required/i.test(text)) {
    if (!cookiesConfigured) {
      return "O YouTube pediu autenticação ao servidor. Configure a variável secreta YTDLP_COOKIES_B64 no Railway e tente novamente.";
    }
    return "O YouTube recusou os cookies configurados. Eles podem ter expirado ou sido rotacionados; exporte cookies novos e atualize YTDLP_COOKIES_B64 no Railway.";
  }
  return text;
}

const jobs = new Map();
const CLEANUP_AFTER_MS = 30 * 60 * 1000;
let activeJobs = 0;

function cleanUrl(url) {
  try {
    const u = new URL(url);
    if (!["youtube.com","www.youtube.com","m.youtube.com","youtu.be","www.youtube-nocookie.com"].includes(u.hostname)) {
      throw new Error("Informe uma URL válida do YouTube.");
    }

    // Analisa somente o vídeo colado, mesmo quando o link veio de playlist/mix.
    u.searchParams.delete("list");
    u.searchParams.delete("index");
    u.searchParams.delete("start_radio");

    return u.toString();
  } catch {
    throw new Error("URL do YouTube inválida.");
  }
}

function formatMB(bytes, estimated = false) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "N/A";
  const mb = bytes / 1024 / 1024;
  const text = mb >= 100 ? `${mb.toFixed(0)} MB` : `${mb.toFixed(1)} MB`;
  return estimated ? `~${text}` : text;
}

function estimateFormatBytes(format, info) {
  const exact = Number(format?.filesize);
  if (Number.isFinite(exact) && exact > 0) return { bytes: exact, estimated: false };

  const approx = Number(format?.filesize_approx);
  if (Number.isFinite(approx) && approx > 0) return { bytes: approx, estimated: true };

  const duration = Number(info?.duration || 0);
  if (!Number.isFinite(duration) || duration <= 0) return { bytes: null, estimated: true };

  // yt-dlp bitrates are expressed in kbit/s. For video-only formats, add a
  // representative audio bitrate because the final MP4 will include audio too.
  let kbps = Number(format?.tbr || format?.vbr || 0);
  if (!Number.isFinite(kbps) || kbps <= 0) return { bytes: null, estimated: true };
  if (!format?.acodec || format.acodec === "none") kbps += 128;

  // Small container/metadata allowance so the estimate is less likely to understate.
  const bytes = (kbps * 1000 / 8) * duration * 1.02;
  return { bytes, estimated: true };
}

function pickVideoFormats(info) {
  const heights = [1080, 720, 480, 360, 240, 144];
  const formats = info.formats || [];
  return heights.map(height => {
    const candidates = formats.filter(f => f.vcodec && f.vcodec !== "none" && Number(f.height) === height);
    if (!candidates.length) return { height, label:`${height}P`, size:null, filesize:null };
    candidates.sort((a,b) => {
      const score = f => (f.ext==="mp4"?10:0) + (f.vcodec?.startsWith("avc1")?8:0) + (f.acodec && f.acodec!=="none"?2:0);
      return score(b)-score(a);
    });
    const f = candidates[0];
    const sizeInfo = estimateFormatBytes(f, info);
    return {
      height, label:`${height}P`, ext:f.ext, format_id:f.format_id,
      filesize:sizeInfo.bytes,
      estimated:sizeInfo.estimated,
      size:formatMB(sizeInfo.bytes, sizeInfo.estimated)
    };
  });
}

function runProcess(job, cmd, args, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide:true });
    if (job) job.child = child;
    let stderr = "", stdout = "";

    child.stdout?.on("data", d => {
      const t = d.toString(); stdout += t;
      t.split(/\r?\n/).forEach(line => onLine?.(line, "stdout"));
    });
    child.stderr?.on("data", d => {
      const t = d.toString(); stderr += t;
      t.split(/\r?\n/).forEach(line => onLine?.(line, "stderr"));
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (job) job.child = null;
      if (job?.cancelled) return reject(new Error("Processamento cancelado."));
      if (code === 0) return resolve({stdout,stderr});
      if (signal === "SIGKILL") {
        return reject(new Error("O processo de vídeo foi encerrado pelo servidor por limite de memória/CPU. Tente uma resolução menor ou um trecho mais curto."));
      }
      const tail = stderr.trim().split(/\r?\n/).slice(-25).join("\n");
      reject(new Error(tail || `Processo terminou com código ${code}${signal ? ` (sinal ${signal})` : ""}`));
    });
  });
}

async function cleanupJob(job) {
  if (!job) return;
  await fs.rm(job.work, { recursive:true, force:true }).catch(()=>{});
  jobs.delete(job.id);
}

app.post("/api/info", async (req,res) => {
  try {
    const url = cleanUrl(req.body.url);
    const analysisPromise = runProcess(null, YTDLP_BIN, [
      "--force-ipv4",
      "--no-playlist",
      "--socket-timeout","20",
      "--retries","2",
      "--extractor-retries","2",
      "--dump-single-json",
      "--no-warnings",
      "--skip-download",
      ...ytDlpCookieArgs(),
      url
    ]);

    const {stdout} = await Promise.race([
      analysisPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("A análise demorou demais. Tente outro link ou tente novamente.")), 45000)
      )
    ]);

    const info = JSON.parse(stdout);
    res.json({
      ok:true,
      title:info.title || "Vídeo",
      thumbnail:info.thumbnail || null,
      duration:info.duration || 0,
      formats:pickVideoFormats(info)
    });
  } catch(err) {
    res.status(400).json({ok:false,error:friendlyYtDlpError(err.message)});
  }
});

app.post("/api/jobs", async (req,res) => {
  try {
    const url = cleanUrl(req.body.url);
    const start = Math.max(0, Number(req.body.start || 0));
    const end = Math.max(start + .1, Number(req.body.end || 30));
    const height = Number(req.body.height || 1080);
    const outputMode = ["original","vertical_crop","vertical_blur"].includes(req.body.outputMode) ? req.body.outputMode : "original";
    const cropPosition = ["left","center","right"].includes(req.body.cropPosition) ? req.body.cropPosition : "center";
    const customName = String(req.body.customName || "recorte").trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, "").slice(0, 80) || "recorte";

    const watermarkEnabled = Boolean(req.body.watermarkEnabled);
    const watermarkText = String(req.body.watermarkText || "").trim().slice(0, 80);
    const watermarkPosition = ["top-left","top-right","center","bottom-left","bottom-right"].includes(req.body.watermarkPosition)
      ? req.body.watermarkPosition
      : "bottom-right";
    const watermarkSize = Math.max(18, Math.min(96, Number(req.body.watermarkSize || 36)));
    const watermarkOpacity = Math.max(0.15, Math.min(1, Number(req.body.watermarkOpacity || 0.7)));

    if (end-start > 15*60) throw new Error("O trecho máximo permitido é de 15 minutos.");

    const id = crypto.randomBytes(10).toString("hex");
    const work = path.join(TEMP,id);
    await fs.mkdir(work,{recursive:true});
    const job = {
      id,work,url,start,end,height,outputMode,
      watermarkEnabled,watermarkText,watermarkPosition,watermarkSize,watermarkOpacity,cropPosition,customName,
      stage:"Preparando",progress:1,status:"running",cancelled:false,child:null,
      output:path.join(work,"recorte.mp4"), error:null
    };
    jobs.set(id,job);
    res.json({ok:true,jobId:id});

    processJob(job).catch(async err => {
      if (!job.cancelled) {
        job.status="error"; job.error=friendlyYtDlpError(err.message); job.stage="Erro";
      }
      setTimeout(()=>cleanupJob(job), 60_000);
    });
  } catch(err) {
    res.status(400).json({ok:false,error:err.message});
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
    case "top-left": return { x:String(pad), y:String(pad) };
    case "top-right": return { x:`w-text_w-${pad}`, y:String(pad) };
    case "center": return { x:"(w-text_w)/2", y:"(h-text_h)/2" };
    case "bottom-left": return { x:String(pad), y:`h-text_h-${pad}` };
    default: return { x:`w-text_w-${pad}`, y:`h-text_h-${pad}` };
  }
}

function buildWatermarkFilter(job) {
  if (!job.watermarkEnabled || !job.watermarkText) return null;

  const {x,y} = watermarkPositionExpr(job.watermarkPosition);
  const text = escapeDrawtextText(job.watermarkText);
  const opacity = Math.max(0.15, Math.min(1, Number(job.watermarkOpacity || 0.7)));
  const size = Math.max(18, Math.min(96, Number(job.watermarkSize || 36)));

  // Cross-platform font path. Docker installs DejaVu Sans in this location.
  // On Windows, set FFMPEG_FONTFILE=C\\:/Windows/Fonts/arial.ttf if desired.
  const font = String(process.env.FFMPEG_FONTFILE || "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:");

  return [
    `drawtext=fontfile='${font}'`,
    `text='${text}'`,
    `fontcolor=white@${opacity}`,
    `fontsize=${size}`,
    `x=${x}`,
    `y=${y}`,
    "borderw=2",
    "bordercolor=black@0.65",
    "shadowcolor=black@0.55",
    "shadowx=2",
    "shadowy=2"
  ].join(":");
}

async function processJob(job) {
  if (activeJobs >= MAX_CONCURRENT_JOBS) {
    throw new Error("Servidor ocupado no momento. Tente novamente em alguns instantes.");
  }
  activeJobs += 1;
  try {
  const inputPattern = path.join(job.work,"source.%(ext)s");
  job.stage="Baixando vídeo"; job.progress=3;

  await runProcess(job,YTDLP_BIN,[
    "--force-ipv4",
    "--newline",
    "--socket-timeout","20",
    "--retries","2",
    "--fragment-retries","2",
    "--no-warnings","--no-playlist",
    ...ytDlpCookieArgs(),
    // Prefer H.264/AVC when YouTube offers it. AV1 decoding + 1080p60 re-encoding
    // is substantially heavier and can exceed small cloud-instance limits.
    "-f",`bv*[height<=${job.height}][ext=mp4][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=${job.height}][vcodec^=avc1]+ba/b[height<=${job.height}][ext=mp4][vcodec^=avc1]/bv*[height<=${job.height}][ext=mp4]+ba[ext=m4a]/b[height<=${job.height}]`,
    "--merge-output-format","mp4",
    "-o",inputPattern,
    job.url
  ], line => {
    const m=line.match(/\[download\]\s+([\d.]+)%/);
    if(m) job.progress = Math.min(70, 3 + Number(m[1]) * .67);
  });

  const entries=await fs.readdir(job.work);
  const source=entries.find(x=>/^source\./.test(x));
  if(!source) throw new Error("Não foi possível localizar o vídeo processado.");

  job.stage=job.watermarkEnabled && job.watermarkText ? "Recortando + gravando marca d’água" : "Recortando"; job.progress=72;
  const duration = job.end-job.start;
  const args=["-y","-ss",String(job.start),"-i",path.join(job.work,source),"-t",String(duration)];

  const watermarkFilter = buildWatermarkFilter(job);

  console.log("");
  console.log("========== TUBECUT WATERMARK ==========");
  console.log("Ativada:", job.watermarkEnabled);
  console.log("Texto:", job.watermarkText || "(vazio)");
  console.log("Posicao:", job.watermarkPosition);
  console.log("Tamanho:", job.watermarkSize);
  console.log("Opacidade:", job.watermarkOpacity);
  console.log("Filtro:", watermarkFilter || "(nenhum)");
  console.log("=======================================");
  console.log("");

  if(job.outputMode==="vertical_crop") {
    // Crop to 9:16 FIRST, then scale. This avoids creating a huge ~3413x1920
    // intermediate frame from a 1920x1080 source and dramatically reduces RAM/CPU.
    const cropX = job.cropPosition === "left"
      ? "0"
      : job.cropPosition === "right"
        ? "iw-ih*9/16"
        : "(iw-ih*9/16)/2";
    let vf = `crop=ih*9/16:ih:${cropX}:0,scale=1080:1920:flags=fast_bilinear`;
    if (watermarkFilter) vf += "," + watermarkFilter;
    args.push("-vf", vf);
  } else if(job.outputMode==="vertical_blur") {
    let filter = "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=28:14[bg];" +
                 "[0:v]scale=1080:1920:force_original_aspect_ratio=decrease[fg];";
    if (watermarkFilter) {
      filter += `[bg][fg]overlay=(W-w)/2:(H-h)/2,${watermarkFilter}[v]`;
    } else {
      filter += "[bg][fg]overlay=(W-w)/2:(H-h)/2[v]";
    }
    args.push("-filter_complex",filter,"-map","[v]","-map","0:a?");
  } else if (watermarkFilter) {
    args.push("-vf", watermarkFilter);
  }

  // Keep ffmpeg predictable on low-cost cloud instances. Without a cap x264 may
  // spawn dozens of threads (the Railway log showed 48), which can cause OOM/SIGKILL.
  args.push(
    "-c:v","libx264",
    "-preset","veryfast",
    "-crf","21",
    "-threads",String(Math.max(1, Number(process.env.FFMPEG_THREADS || 2))),
    "-c:a","aac","-b:a","128k",
    "-movflags","+faststart",
    "-progress","pipe:2","-nostats",
    job.output
  );

  console.log("FFmpeg args:", args.join(" "));
  await runProcess(job,FFMPEG_BIN,args,line=>{
    const m=line.match(/^out_time_ms=(\d+)/);
    if(m) {
      const seconds=Number(m[1])/1_000_000;
      job.progress=Math.min(98,72+(seconds/Math.max(.1,duration))*26);
    }
  });

  job.progress=100; job.stage="Arquivo pronto"; job.status="done";
  setTimeout(()=>cleanupJob(job), CLEANUP_AFTER_MS);
  } finally {
    activeJobs = Math.max(0, activeJobs - 1);
  }
}

app.get("/api/jobs/:id", (req,res) => {
  const job=jobs.get(req.params.id);
  if(!job) return res.status(404).json({ok:false,error:"Processamento não encontrado ou já limpo."});
  res.json({ok:true,status:job.status,stage:job.stage,progress:Math.round(job.progress),error:job.error});
});

app.post("/api/jobs/:id/cancel", async (req,res) => {
  const job=jobs.get(req.params.id);
  if(!job) return res.status(404).json({ok:false,error:"Processamento não encontrado."});
  job.cancelled=true; job.status="cancelled"; job.stage="Cancelado";
  if(job.child) {
    try { job.child.kill("SIGTERM"); } catch {}
    if(process.platform==="win32" && job.child.pid) {
      spawn("taskkill",["/PID",String(job.child.pid),"/T","/F"],{windowsHide:true});
    }
  }
  await cleanupJob(job);
  res.json({ok:true});
});

app.get("/api/jobs/:id/file", (req,res) => {
  const job=jobs.get(req.params.id);
  if(!job || job.status!=="done") return res.status(404).send("Arquivo ainda não está pronto.");
  const suffix=job.outputMode==="original"?`${job.height}p`:"1080x1920";
  const safeName = (job.customName || "recorte").replace(/[<>:"/\\|?*\x00-\x1F]/g, "").slice(0,80) || "recorte";
  res.download(job.output,`${safeName}-${suffix}.mp4`,()=>cleanupJob(job));
});

setInterval(async()=>{
  const now=Date.now();
  for(const job of jobs.values()) {
    try {
      const stat=await fs.stat(job.work);
      if(now-stat.mtimeMs > CLEANUP_AFTER_MS) await cleanupJob(job);
    } catch {}
  }
},5*60*1000).unref();

app.get("/api/health", async (req,res) => {
  try {
    const [ytdlp, ffmpeg] = await Promise.all([
      runProcess(null, YTDLP_BIN, ["--version"]),
      runProcess(null, FFMPEG_BIN, ["-version"])
    ]);
    res.json({
      ok:true,
      service:"TubeCut",
      ytdlp:ytdlp.stdout.trim().split(/\r?\n/)[0] || "ok",
      ffmpeg:ffmpeg.stdout.trim().split(/\r?\n/)[0] || "ok",
      youtubeCookies:cookiesConfigured ? "configured" : "not-configured",
      activeJobs,
      maxConcurrentJobs:MAX_CONCURRENT_JOBS
    });
  } catch (err) {
    res.status(503).json({ok:false,error:err.message});
  }
});

app.get("/", (req,res)=>res.sendFile(path.join(PUBLIC,"index.html")));
app.listen(PORT,()=>console.log(`Servidor rodando em http://localhost:${PORT}`));
