# TubeCut — Railway deploy

## 1) Upload these files to the root of the GitHub repository
Dockerfile, start.sh, server.js, package.json, .dockerignore, .gitignore, .env.example and the public/ folder.

## 2) Railway
Create/deploy the service from the GitHub repository. Railway should detect the Dockerfile automatically.

After the build finishes, open Settings / Networking and Generate Domain.

Health check URL: `/health`

## 3) What this image includes
- Node 22
- FFmpeg
- current yt-dlp + yt-dlp EJS dependencies
- bgutil-ytdlp-pot-provider 1.3.1
- a local PO Token provider running inside the same container

The backend uses the `mweb` YouTube client and Node as the JS runtime.

## 4) If YouTube still says "Sign in to confirm you're not a bot"
This can be an IP/datacenter block. PO Tokens do not guarantee removal of an IP-level block.

The app supports an OPTIONAL Railway secret called `YTDLP_COOKIES_B64`.

Never upload cookies.txt to GitHub.

If you decide to use cookies, export a Netscape-format cookies.txt from a browser session you control, convert the file to Base64 locally, and paste only the Base64 value into Railway > Variables > YTDLP_COOKIES_B64.

PowerShell example (run on your PC, replacing the path):

`[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\\caminho\\cookies.txt"))`

The container recreates the cookies file at runtime with restricted permissions and deletes it on redeploy/shutdown with the temp directory.

Use cookies only when necessary. YouTube can challenge or restrict automated use of an authenticated account.

## 5) Storage cleanup
- only the selected clip interval is requested from yt-dlp;
- the source clip is deleted after FFmpeg finishes;
- the final file is deleted after download;
- failed/cancelled jobs are cleaned;
- expired jobs are cleaned automatically;
- temp storage is purged on container start/shutdown.

## 6) Recommended Railway variables
The defaults work without setting anything. For a small instance, keep `MAX_ACTIVE_JOBS=2` or `3`.
