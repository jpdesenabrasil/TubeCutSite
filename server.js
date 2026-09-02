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
const MAX_CONCURRENT_JOBS_PER_IP = Math.max(1, Number(process.env.MAX_CONCURRENT_JOBS_PER_IP || 1));
const PUBLIC = path.join(process.cwd(), "public");
const TEMP = path.join(process.cwd(), "temp");
const YTDLP_COOKIES_B64 = String(process.env.YTDLP_COOKIES_B64 || "").trim();
const COOKIE_FILE = path.join(TEMP, ".youtube-cookies.txt");
const YTDLP_JS_RUNTIME = process.env.YTDLP_JS_RUNTIME || "node";
const PO_PROVIDER_ENABLED = String(process.env.YTDLP_PO_PROVIDER || "bgutil").toLowerCase() !== "off";
const MAX_SOURCE_REQUESTS_PER_15M = Math.max(10, Number(process.env.MAX_ANALYSES_PER_15M || 45));
const MAX_JOBS_PER_HOUR = Math.max(5, Number(process.env.MAX_JOBS_PER_HOUR || 20));
const MAX_STATUS_REQUESTS_PER_MIN = Math.max(20, Number(process.env.MAX_STATUS_REQUESTS_PER_MIN || 120));
const MAX_DOWNLOADS_PER_HOUR = Math.max(5, Number(process.env.MAX_DOWNLOADS_PER_HOUR || 40));
const MAX_DURATION_SECONDS = Math.max(30, Number(process.env.MAX_DURATION_SECONDS || 15 * 60));
const MAX_ANALYZE_URL_LENGTH = Math.max(50, Number(process.env.MAX_ANALYZE_URL_LENGTH || 1200));
const BODY_LIMIT = process.env.BODY_LIMIT || "24kb";
const ALLOWED_HEIGHTS = new Set([1080,720,480,360,240,144]);
const ALLOWED_HOSTS = new Set([
  "tubecut.com.br",
  "www.tubecut.com.br",
  "tubecutsite-production.up.railway.app"
]);

app.disable("x-powered-by");
app.set("trust proxy", 1);

function getOriginHost(req) {
  try {
    const origin = req.get("origin") || req.get("referer");
    if (!origin) return null;
    return new URL(origin).host.toLowerCase();
  } catch {
    return null;
  }
}

function getCanonicalHost(req) {
  return String(req.get("host") || "").toLowerCase().trim();
}

function enforceOrigin(req, res, next) {
  const method = String(req.method || "GET").toUpperCase();
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) return next();
  const originHost = getOriginHost(req);
  const host = getCanonicalHost(req);
  if (!originHost) {
    return res.status(403).json({ ok:false, error:"Origem não autorizada." });
  }
  if (!ALLOWED_HOSTS.has(originHost) || (host && !ALLOWED_HOSTS.has(host))) {
    return res.status(403).json({ ok:false, error:"Origem não autorizada." });
  }
  next();
}

app.use((req,res,next) => {
  const host = getCanonicalHost(req);
  if (host && !ALLOWED_HOSTS.has(host) && process.env.NODE_ENV === "production") {
    return res.status(421).type("text/plain").send("Misdirected Request");
  }

  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Origin-Agent-Cluster", "?1");
  res.setHeader("X-DNS-Prefetch-Control", "off");
  res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
  if (req.secure || String(req.get("x-forwarded-proto") || "").toLowerCase() === "https") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  }
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "img-src 'self' https: data:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self' 'unsafe-inline'",
      "connect-src 'self'",
      "font-src 'self' data:",
      "object-src 'none'",
      "media-src 'self' blob:",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "upgrade-insecure-requests"
    ].join('; ')
  );
  if (req.path.startsWith("/api/")) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  }
  next();
});
app.use(express.json({ limit: BODY_LIMIT, strict: true }));
app.use(enforceOrigin);

const BLOCKED_PUBLIC_PATHS = new Set([
  "/robots.txt", "/sitemap.xml", "/sitemap_index.xml",
  "/.env", "/.git", "/.git/config", "/server.js", "/package.json", "/package-lock.json",
  "/yarn.lock", "/pnpm-lock.yaml", "/dockerfile", "/railway.json", "/start.sh"
]);
app.use((req,res,next) => {
  const cleanPath = String(req.path || "").toLowerCase();
  if (BLOCKED_PUBLIC_PATHS.has(cleanPath) || cleanPath.startsWith("/.git/") || cleanPath.startsWith("/.well-known/")) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(404).type("text/plain").send("Not Found");
  }
  if (["TRACE","CONNECT"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST, HEAD, OPTIONS");
    return res.status(405).type("text/plain").send("Method Not Allowed");
  }
  next();
});

app.options("/{*splat}", (req,res) => {
  res.setHeader("Allow", "GET, POST, HEAD, OPTIONS");
  return res.sendStatus(204);
});

app.use(express.static(PUBLIC, {
  dotfiles:"deny",
  index:false,
  maxAge:"1h",
  etag:true,
  fallthrough:true,
  setHeaders(res, servedPath) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (servedPath.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-store");
    }
  }
}));
await fs.mkdir(TEMP, { recursive: true, mode: 0o700 });

const rateBuckets = new Map();
function rateLimit(windowMs, max, message) {
  return (req,res,next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const current = rateBuckets.get(key);
    if (!current || current.reset <= now) {
      rateBuckets.set(key,{count:1,reset:now+windowMs});
      return next();
    }
    current.count += 1;
    if (current.count > max) {
      res.setHeader("Retry-After", String(Math.ceil((current.reset-now)/1000)));
      return res.status(429).json({ok:false,error:message});
    }
    next();
  };
}
setInterval(() => {
  const now=Date.now();
  for (const [key,b] of rateBuckets) if (b.reset <= now) rateBuckets.delete(key);
}, 10*60*1000).unref();

const ipRunningJobs = new Map();
function incrementIpJob(ip) {
  const next = (ipRunningJobs.get(ip) || 0) + 1;
  ipRunningJobs.set(ip, next);
  return next;
}
function decrementIpJob(ip) {
  const next = Math.max(0, (ipRunningJobs.get(ip) || 0) - 1);
  if (next === 0) ipRunningJobs.delete(ip);
  else ipRunningJobs.set(ip, next);
}

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
  if (/The page needs to be reloaded|UNPLAYABLE/i.test(text)) {
    return "O YouTube recusou esta sessão/IP mesmo após as tentativas automáticas. Tente novamente em alguns minutos; se persistir, o IP do servidor pode estar temporariamente limitado pelo YouTube.";
  }
  if (/Sign in to confirm you.?re not a bot|cookies-from-browser|cookies for the authentication|LOGIN_REQUIRED|account.*required/i.test(text)) {
    if (!cookiesConfigured) {
      return "O YouTube pediu autenticação ao servidor. Configure a variável secreta YTDLP_COOKIES_B64 no Railway e tente novamente.";
    }
    return "O YouTube bloqueou a sessão mesmo com cookies. O TubeCut também tentou o modo PO Token automaticamente; tente novamente em alguns minutos.";
  }
  return text;
}

function commonYtDlpArgs() {
  return [
    "--force-ipv4",
    "--js-runtimes", YTDLP_JS_RUNTIME,
    "--no-playlist",
    "--socket-timeout", "20",
    "--retries", "2",
    "--extractor-retries", "2"
  ];
}

function isYoutubeAccessError(message) {
  return /Sign in to confirm you.?re not a bot|LOGIN_REQUIRED|The page needs to be reloaded|UNPLAYABLE|HTTP Error 403|forbidden|PO Token|player response/i.test(String(message || ""));
}

function ytDlpStrategies() {
  const strategies = [];

  // V9: prefer the current mweb + dynamic PO-token path first. Railway/datacenter
  // IPs are more likely to be challenged by YouTube's default web flow.
  if (PO_PROVIDER_ENABLED) {
    strategies.push({
      name: "mweb-po-token",
      args: ["--extractor-args", "youtube:player_client=mweb"]
    });
  }

  // Keep the simple V1-style route as an immediate fallback.
  strategies.push({ name: "default-no-cookies", args: [] });

  // Embedded client can sometimes avoid a challenge affecting the normal web client.
  strategies.push({
    name: "web-embedded",
    args: ["--extractor-args", "youtube:player_client=web_embedded"]
  });

  // Cookies are intentionally last: if a session/IP is temporarily challenged, forcing
  // the same authenticated session first can make every request fail immediately.
  if (cookiesConfigured) {
    strategies.push({ name: "default-cookies", args: ytDlpCookieArgs() });
    if (PO_PROVIDER_ENABLED) {
      strategies.push({
        name: "mweb-po-token-cookies",
        args: ["--extractor-args", "youtube:player_client=mweb", ...ytDlpCookieArgs()]
      });
    }
  }
  return strategies;
}

async function runYtDlpWithFallback(job, taskArgs, url, onLine, timeoutMs = 0) {
  let lastError = null;
  const strategies = ytDlpStrategies();
  for (let i = 0; i < strategies.length; i++) {
    const strategy = strategies[i];
    try {
      console.log(`[yt-dlp] tentativa ${i + 1}/${strategies.length}: ${strategy.name}`);
      return await runProcess(job, YTDLP_BIN, [
        ...commonYtDlpArgs(),
        ...strategy.args,
        ...taskArgs,
        url
      ], onLine, timeoutMs);
    } catch (err) {
      lastError = err;
      console.warn(`[yt-dlp] falhou em ${strategy.name}: ${String(err.message || err).split(/\r?\n/).slice(-3).join(" | ")}`);
      if (job?.cancelled) throw err;
      if (!isYoutubeAccessError(err.message) || i === strategies.length - 1) throw err;
    }
  }
  throw lastError || new Error("Falha ao acessar o YouTube.");
}

const jobs = new Map();
const CLEANUP_AFTER_MS = 30 * 60 * 1000;
let activeJobs = 0;

function cleanUrl(url) {
  try {
    const raw = String(url || "").trim();
    if (!raw || raw.length > MAX_ANALYZE_URL_LENGTH) throw new Error("Informe uma URL válida do YouTube.");
    const u = new URL(raw);
    if (!["http:","https:"].includes(u.protocol) || u.port) throw new Error("Informe uma URL HTTP/HTTPS válida do YouTube.");
    if (!["youtube.com","www.youtube.com","m.youtube.com","youtu.be","www.youtube-nocookie.com"].includes(u.hostname)) {
      throw new Error("Informe uma URL válida do YouTube.");
    }
    u.username = "";
    u.password = "";
    u.hash = "";
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

  let kbps = Number(format?.tbr || format?.vbr || 0);
  if (!Number.isFinite(kbps) || kbps <= 0) return { bytes: null, estimated: true };
  if (!format?.acodec || format.acodec === "none") kbps += 128;

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

function runProcess(job, cmd, args, onLine, timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide:true, stdio:["ignore","pipe","pipe"] });
    if (job) job.child = child;
    let stderr = "", stdout = "", settled = false;
    const MAX_CAPTURE = 2 * 1024 * 1024;
    let timer = null;

    const appendLimited = (current, value) => (current + value).slice(-MAX_CAPTURE);
    const finish = fn => value => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (job) job.child = null;
      fn(value);
    };
    const doneResolve = finish(resolve), doneReject = finish(reject);

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try { child.kill("SIGTERM"); } catch {}
        setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000).unref?.();
        doneReject(new Error("O processamento excedeu o tempo máximo permitido pelo servidor."));
      }, timeoutMs);
      timer.unref?.();
    }

    child.stdout?.on("data", d => {
      const t = d.toString(); stdout = appendLimited(stdout,t);
      t.split(/\r?\n/).forEach(line => onLine?.(line, "stdout"));
    });
    child.stderr?.on("data", d => {
      const t = d.toString(); stderr = appendLimited(stderr,t);
      t.split(/\r?\n/).forEach(line => onLine?.(line, "stderr"));
    });
    child.on("error", doneReject);
    child.on("close", (code, signal) => {
      if (settled) return;
      if (job?.cancelled) return doneReject(new Error("Processamento cancelado."));
      if (code === 0) return doneResolve({stdout,stderr});
      if (signal === "SIGKILL") {
        return doneReject(new Error("O processo de vídeo foi encerrado pelo servidor por limite de memória/CPU. Tente uma resolução menor ou um trecho mais curto."));
      }
      const tail = stderr.trim().split(/\r?\n/).slice(-25).join("\n");
      doneReject(new Error(tail || `Processo terminou com código ${code}${signal ? ` (sinal ${signal})` : ""}`));
    });
  });
}

async function cleanupJob(job) {
  if (!job) return;
  await fs.rm(job.work, { recursive:true, force:true }).catch(()=>{});
  jobs.delete(job.id);
  decrementIpJob(job.creatorIp);
}

function assertString(v, label, maxLen=200) {
  const text = String(v || "").trim();
  if (!text) throw new Error(`${label} inválido.`);
  if (text.length > maxLen) throw new Error(`${label} inválido.`);
  return text;
}

app.post("/api/info", rateLimit(15*60*1000, MAX_SOURCE_REQUESTS_PER_15M, "Muitas análises em pouco tempo. Aguarde alguns minutos."), async (req,res) => {
  try {
    const rawUrl = assertString(req.body?.url, "URL", MAX_ANALYZE_URL_LENGTH);
    const url = cleanUrl(rawUrl);
    const analysisPromise = runYtDlpWithFallback(null, [
      "--dump-single-json",
      "--no-warnings",
      "--skip-download"
    ], url, null, 45_000);

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

app.post("/api/jobs", rateLimit(60*60*1000, MAX_JOBS_PER_HOUR, "Limite de processamentos atingido. Aguarde antes de iniciar novos cortes."), async (req,res) => {
  try {
    const creatorIp = String(req.ip || "unknown");
    if ((ipRunningJobs.get(creatorIp) || 0) >= MAX_CONCURRENT_JOBS_PER_IP) {
      throw new Error("Você já possui um processamento em andamento. Aguarde finalizar antes de iniciar outro.");
    }

    const url = cleanUrl(assertString(req.body?.url, "URL", MAX_ANALYZE_URL_LENGTH));
    const start = Number(req.body.start);
    const end = Number(req.body.end);
    const height = Number(req.body.height || 1080);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) throw new Error("Intervalo de tempo inválido.");
    if (!ALLOWED_HEIGHTS.has(height)) throw new Error("Qualidade de vídeo inválida.");
    const duration = end - start;
    if (duration > MAX_DURATION_SECONDS) throw new Error("O trecho máximo permitido é de 15 minutos.");

    const outputMode = ["original","vertical_crop","vertical_blur"].includes(req.body.outputMode) ? req.body.outputMode : "original";
    const cropPosition = ["left","center","right"].includes(req.body.cropPosition) ? req.body.cropPosition : "center";
    const videoTitle = sanitizeFilenamePart(req.body.videoTitle || "Vídeo", 160) || "Vídeo";

    const watermarkEnabled = Boolean(req.body.watermarkEnabled);
    const watermarkText = String(req.body.watermarkText || "").replace(/[\x00-\x1F\x7F]/g," ").trim().slice(0, 80);
    const watermarkPosition = ["top-left","top-right","center","bottom-left","bottom-right"].includes(req.body.watermarkPosition)
      ? req.body.watermarkPosition
      : "bottom-right";
    const watermarkSize = Math.max(18, Math.min(96, Number(req.body.watermarkSize || 36)));
    const watermarkOpacity = Math.max(0.15, Math.min(1, Number(req.body.watermarkOpacity || 0.7)));

    const id = crypto.randomBytes(10).toString("hex");
    const work = path.join(TEMP,id);
    await fs.mkdir(work,{recursive:true, mode: 0o700});
    const accessToken = crypto.randomBytes(24).toString("base64url");
    const job = {
      id,accessToken,work,url,start,end,height,outputMode,videoTitle,
      watermarkEnabled,watermarkText,watermarkPosition,watermarkSize,watermarkOpacity,cropPosition,
      stage:"Preparando",progress:1,status:"running",cancelled:false,child:null,
      output:path.join(work,"recorte.mp4"), error:null, createdAt:Date.now(), creatorIp
    };
    jobs.set(id,job);
    incrementIpJob(creatorIp);
    res.json({ok:true,jobId:id,jobToken:accessToken});

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

function sanitizeFilenamePart(value, maxBytes=160) {
  let text = String(value || "")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\x00-\x1F\x7F]/g, "")
    .replace(/[. ]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  while (Buffer.byteLength(text,"utf8") > maxBytes) text = Array.from(text).slice(0,-1).join("");
  return text.trim();
}

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

    await runYtDlpWithFallback(job,[
      "--newline",
      "--fragment-retries","2",
      "--no-warnings",
      "-f",`bv*[height<=${job.height}][ext=mp4][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=${job.height}][vcodec^=avc1]+ba/b[height<=${job.height}][ext=mp4][vcodec^=avc1]/bv*[height<=${job.height}][ext=mp4]+ba[ext=m4a]/b[height<=${job.height}]`,
      "--merge-output-format","mp4",
      "-o",inputPattern
    ], job.url, line => {
      const m=line.match(/\[download\]\s+([\d.]+)%/);
      if(m) job.progress = Math.min(70, 3 + Number(m[1]) * .67);
    }, 10*60*1000);

    const entries=await fs.readdir(job.work);
    const source=entries.find(x=>/^source\./.test(x));
    if(!source) throw new Error("Não foi possível localizar o vídeo processado.");

    job.stage=job.watermarkEnabled && job.watermarkText ? "Recortando + gravando marca d’água" : "Recortando"; job.progress=72;
    const duration = job.end-job.start;
    const args=["-y","-ss",String(job.start),"-i",path.join(job.work,source),"-t",String(duration)];

    const watermarkFilter = buildWatermarkFilter(job);

    if(job.outputMode==="vertical_crop") {
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

    await runProcess(job,FFMPEG_BIN,args,line=>{
      const m=line.match(/^out_time_ms=(\d+)/);
      if(m) {
        const seconds=Number(m[1])/1_000_000;
        job.progress=Math.min(98,72+(seconds/Math.max(.1,duration))*26);
      }
    }, 20*60*1000);

    job.progress=100; job.stage="Arquivo pronto"; job.status="done";
    setTimeout(()=>cleanupJob(job), CLEANUP_AFTER_MS);
  } finally {
    activeJobs = Math.max(0, activeJobs - 1);
  }
}

function authorizedJob(req,res) {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ok:false,error:"Processamento não encontrado ou já limpo."});
    return null;
  }
  const token = String(req.get("x-job-token") || req.query.token || "");
  const a=Buffer.from(token), b=Buffer.from(job.accessToken);
  const valid = a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a,b);
  if (!valid) {
    res.status(403).json({ok:false,error:"Acesso ao processamento negado."});
    return null;
  }
  return job;
}

app.get("/api/jobs/:id", rateLimit(60*1000, MAX_STATUS_REQUESTS_PER_MIN, "Muitas consultas ao andamento. Aguarde alguns segundos."), (req,res) => {
  const job=authorizedJob(req,res); if(!job) return;
  res.json({ok:true,status:job.status,stage:job.stage,progress:Math.round(job.progress),error:job.error});
});

app.post("/api/jobs/:id/cancel", rateLimit(60*1000, 15, "Muitos cancelamentos em pouco tempo."), async (req,res) => {
  const job=authorizedJob(req,res); if(!job) return;
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

app.get("/api/jobs/:id/file", rateLimit(60*60*1000, MAX_DOWNLOADS_PER_HOUR, "Muitos downloads em pouco tempo. Aguarde antes de tentar novamente."), (req,res) => {
  const job=authorizedJob(req,res); if(!job) return;
  if(job.status!=="done") return res.status(404).send("Arquivo ainda não está pronto.");
  const safeTitle = sanitizeFilenamePart(job.videoTitle || "Vídeo", 160) || "Vídeo";
  const filename = `TubeCut - ${safeTitle}.mp4`;
  res.setHeader("X-Content-Type-Options","nosniff");
  res.setHeader("Cache-Control", "no-store, private");
  res.download(job.output,filename,err=>{
    if(err && !res.headersSent) res.status(500).send("Não foi possível enviar o arquivo.");
    cleanupJob(job);
  });
});

async function cleanupStaleTempDirs() {
  const now=Date.now();
  const entries=await fs.readdir(TEMP,{withFileTypes:true}).catch(()=>[]);
  for(const entry of entries) {
    if(!entry.isDirectory()) continue;
    const full=path.join(TEMP,entry.name);
    try {
      const stat=await fs.stat(full);
      if(now-stat.mtimeMs > 60*60*1000) await fs.rm(full,{recursive:true,force:true});
    } catch {}
  }
}
await cleanupStaleTempDirs();
setInterval(cleanupStaleTempDirs,10*60*1000).unref();

setInterval(async()=>{
  const now=Date.now();
  for(const job of jobs.values()) {
    try {
      const stat=await fs.stat(job.work);
      if(now-stat.mtimeMs > CLEANUP_AFTER_MS) await cleanupJob(job);
    } catch {}
  }
},5*60*1000).unref();

app.get("/api/health", rateLimit(60*1000, 10, "Muitas verificações em pouco tempo."), async (req,res) => {
  try {
    const [ytdlp, ffmpeg] = await Promise.all([
      runProcess(null, YTDLP_BIN, ["--version"]),
      runProcess(null, FFMPEG_BIN, ["-version"])
    ]);
    res.json({
      ok:true,
      service:"TubeCut",
      build:"v9-youtube-resilience",
      ytdlp:ytdlp.stdout.trim().split(/\r?\n/)[0] || "ok",
      ffmpeg:ffmpeg.stdout.trim().split(/\r?\n/)[0] || "ok",
      youtubeCookies:cookiesConfigured ? "configured" : "not-configured",
      jsRuntime:YTDLP_JS_RUNTIME,
      poTokenProvider:PO_PROVIDER_ENABLED ? "bgutil-enabled" : "disabled",
      youtubeStrategy:"automatic-fallback",
      activeJobs,
      maxConcurrentJobs:MAX_CONCURRENT_JOBS,
      maxConcurrentJobsPerIp:MAX_CONCURRENT_JOBS_PER_IP
    });
  } catch (err) {
    res.status(503).json({ok:false,error:err.message});
  }
});

app.get("/", (req,res)=>res.sendFile(path.join(PUBLIC,"index.html"), {headers:{"Cache-Control":"no-store"}}));
app.use((req,res)=>res.status(404).type("text/plain").send("Not Found"));
app.use((err,req,res,next)=>{
  console.error("Erro interno:", err?.message || err);
  if(res.headersSent) return next(err);
  res.status(err?.type === "entity.too.large" ? 413 : 500).json({ok:false,error:"Não foi possível concluir a solicitação."});
});

const server = app.listen(PORT,()=>console.log(`Servidor rodando em http://localhost:${PORT}`));
server.headersTimeout = 30_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 100;
