# TubeCut — deploy no Railway

## O que esta versão corrige
- Instala Node, FFmpeg e yt-dlp dentro do container.
- Usa `PORT` fornecida pelo Railway.
- Remove a dependência obrigatória da fonte Arial do Windows.
- Adiciona `/api/health` para verificar Node/yt-dlp/FFmpeg.
- Limita o número de jobs simultâneos via `MAX_CONCURRENT_JOBS`.
- Mantém arquivos temporários em `/app/temp` e remove após download/timeout.

## Railway
1. Envie este projeto ao GitHub.
2. No Railway: New Project > Deploy from GitHub Repo.
3. O Railway detectará `railway.json` e o `Dockerfile`.
4. Após o deploy, abra `https://SEU-PROJETO.up.railway.app/api/health`.
5. Deve aparecer `ok: true`, a versão do yt-dlp e a versão do FFmpeg.
6. Teste o TubeCut no domínio temporário do Railway antes de conectar o domínio próprio.

## Domínio tubecut.com.br
Quando o domínio temporário estiver funcionando:
Railway > serviço > Settings > Networking > Custom Domain > `tubecut.com.br`.
O Railway mostrará os registros DNS que devem ser criados no provedor do domínio.

## Observação importante
O domínio próprio não altera a forma como o YouTube enxerga a conexão do backend. Se uma requisição funcionar no PC e for recusada no servidor, o log do Railway deve ser consultado para identificar a mensagem específica retornada pelo yt-dlp/YouTube.
