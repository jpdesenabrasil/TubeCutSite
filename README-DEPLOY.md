# TubeCut V6 — Railway

Esta versão mantém a estratégia V5 que funcionou no Railway e adiciona as mudanças solicitadas.

## Novidades da V6

- Download passa a usar automaticamente: `TubeCut - Título do YouTube.mp4`.
- O histórico local de cortes é apagado toda vez que a página é atualizada/reaberta.
- Mantém fallback automático do YouTube da V5 (normal -> cookies -> mweb/PO Token).
- Mantém otimização de FFmpeg e estimativa de MB das versões anteriores.

## Hardening de segurança

- URLs aceitas somente para HTTP/HTTPS e hosts do YouTube permitidos.
- Validação estrita de intervalo, qualidade, modo de saída, watermark e nomes.
- Limite de 15 minutos por corte.
- Rate limit por IP nas rotas pesadas de análise e processamento.
- IDs de job aleatórios + token secreto por processamento para consultar/cancelar/baixar.
- Headers de segurança (CSP, frame deny, nosniff, referrer e permissions policy).
- Corpo JSON limitado a 32 KB.
- `X-Powered-By` desativado.
- Saídas de logs sensíveis reduzidas.
- Limite de captura de stdout/stderr dos processos.
- Timeout para yt-dlp e FFmpeg.
- Limpeza automática de jobs e diretórios temporários antigos, inclusive após reinício/crash.
- Cookies continuam somente em `YTDLP_COOKIES_B64`; não são gravados no GitHub.

## Railway

Mantenha a variável já criada:

`YTDLP_COOKIES_B64`

Variáveis opcionais:

- `MAX_CONCURRENT_JOBS=2`
- `MAX_ANALYSES_PER_15M=60`
- `MAX_JOBS_PER_HOUR=30`
- `FFMPEG_THREADS=2`

Depois do deploy, verifique:

`/api/health`

Deve retornar `"build":"v6-hardened"`.

## Importante

Nenhum serviço público pode ser garantido como 100% invulnerável. Esta versão aplica hardening importante no aplicativo, mas segurança real também depende do Railway, DNS/Cloudflare, atualizações das dependências, proteção da conta GitHub/Railway e monitoramento contínuo.

## V7 — segurança + apoio via Pix

- `/robots.txt`, `/sitemap.xml` e `/sitemap_index.xml` retornam 404 antes dos arquivos estáticos.
- Bloqueio adicional de caminhos comuns de sondagem (`/.env`, `/.git/*`, `/server.js`, `/package.json`).
- TRACE e CONNECT retornam 405.
- `/api/health` também possui rate-limit para evitar abuso de processos de diagnóstico.
- Popup minimalista de apoio aparece em todo carregamento/F5, com QR Code Pix e botão de copiar.
- O botão X fica bloqueado por 4 segundos e é liberado automaticamente depois.
- O QR Code fica em `public/pix-qrcode-bradesco.png`.
- Build esperado em `/api/health`: `v7-hardened-donation`.

Observação: segurança absoluta não existe. A V7 reduz superfície de ataque e abuso, mas mantenha Railway, dependências, cookies e credenciais atualizados e privados.
