# TubeCut V9 — YouTube Resilience

Mantém toda a segurança/Pix da V8 e reforça a compatibilidade com mudanças recentes do YouTube.

## Mudanças da V9
- yt-dlp passa a instalar o canal nightly oficial (`pip --pre`)
- bgutil PO-token provider é construído do branch atual do repositório em vez de ficar preso em 1.3.1
- nova ordem de fallback:
  1. `mweb + PO Token`
  2. modo simples sem cookies (estilo V1)
  3. `web_embedded`
  4. cookies
  5. `mweb + PO Token + cookies`
- cookies ficam por último para evitar insistir primeiro em uma sessão temporariamente bloqueada
- todas as proteções da V8 permanecem

## Verificação
Depois do deploy, acesse `/api/health` e confirme:
`"build":"v9-youtube-resilience"`

Não apague `YTDLP_COOKIES_B64` do Railway.
