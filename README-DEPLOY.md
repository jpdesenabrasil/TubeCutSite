# TubeCut Railway V5 — fallback automático + PO Token

Esta versão mantém todas as correções anteriores e muda a estratégia de acesso ao YouTube.

## O que mudou

1. Tenta primeiro o modo padrão **sem cookies**, parecido com a V1 que chegou a analisar vídeos no Railway.
2. Se o YouTube bloquear e `YTDLP_COOKIES_B64` estiver configurado, tenta novamente com cookies.
3. Se ainda houver bloqueio, tenta automaticamente o cliente `mweb` usando o **BgUtils PO Token Provider** local.
4. Instala `yt-dlp[default]`, incluindo o componente EJS, e usa Node.js 22 como runtime JavaScript para desafios atuais do YouTube.
5. Mantém: estimativa de MB, preferência por H.264, FFmpeg limitado, crop vertical otimizado, marca d'água e limpeza de temporários.

## Railway

Não remova a variável já criada:

- `YTDLP_COOKIES_B64` = seu cookies.txt convertido para Base64

O Dockerfile instala e inicia o PO Token Provider automaticamente. Não é necessária outra variável.

Depois do deploy, abra `/api/health`. A resposta deve incluir aproximadamente:

- `youtubeCookies: "configured"`
- `jsRuntime: "node"`
- `poTokenProvider: "bgutil-enabled"`
- `youtubeStrategy: "automatic-fallback"`

## Importante

O YouTube pode limitar IPs de datacenter independentemente do código. O fallback e o PO Token tornam o TubeCut mais robusto, mas nenhum método garante que todo IP do Railway será aceito permanentemente.
