# TubeCut — Railway V4

Esta versão mantém as correções da V3 e adiciona suporte seguro a cookies do YouTube por variável de ambiente.

## O que já está incluído

- Deploy por Docker no Railway
- Node.js + yt-dlp + FFmpeg
- Preferência por H.264/AVC para reduzir CPU/RAM
- FFmpeg limitado a poucas threads
- Crop 9:16 otimizado
- Tamanho em MB exato/aproximado no seletor de qualidade
- Marca d'água compatível com Linux
- Limpeza de temporários
- `/api/health` com diagnóstico
- Cookies do YouTube via `YTDLP_COOKIES_B64`

## Configurar cookies no Railway

**Não coloque `cookies.txt` no GitHub.**

1. Exporte um `cookies.txt` no formato Netscape de uma sessão do YouTube. Recomenda-se usar uma conta separada só para o TubeCut, não sua conta Google principal.
2. No Windows PowerShell, na pasta onde está `cookies.txt`, execute:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("cookies.txt")) | Set-Clipboard
```

3. No Railway, abra o serviço TubeCut > **Variables** > **New Variable**.
4. Nome: `YTDLP_COOKIES_B64`
5. Valor: cole o texto Base64 copiado pelo PowerShell.
6. Salve e aguarde o novo deploy/restart.
7. Abra `/api/health`. Deve aparecer:

```json
"youtubeCookies": "configured"
```

Se aparecer `not-configured`, a variável não foi lida ou o Base64 não era válido.

## Segurança

- O valor da variável não é impresso nos logs.
- O arquivo de cookies é criado somente dentro do container em `temp/.youtube-cookies.txt` com permissão restrita.
- O arquivo não fica no GitHub.
- Cookies podem expirar/rotacionar; se o YouTube voltar a pedir login, exporte um arquivo novo e substitua a variável.

## Variáveis opcionais

- `MAX_CONCURRENT_JOBS=2`
- `FFMPEG_THREADS=2`
- `YTDLP_BIN=yt-dlp`
- `FFMPEG_BIN=ffmpeg`
