# TubeCut — Deploy no Railway

## 1. Suba esta pasta para um repositório GitHub
Não envie `.env`, `temp/` nem `node_modules/`.

## 2. Railway
1. New Project → Deploy from GitHub Repo.
2. Selecione o repositório do TubeCut.
3. O Railway detectará o `Dockerfile` automaticamente.
4. Em Settings → Networking → Generate Domain.
5. Teste `https://SEU-DOMINIO/health` e confirme `{ "ok": true }`.

## 3. Variáveis opcionais
Você pode ajustar em Variables:
- `MAX_ACTIVE_JOBS=3`
- `MAX_JOBS_PER_IP=1`
- `MIN_FREE_DISK_MB=250`
- `MAX_SOURCE_FILESIZE=700M`
- `CLEANUP_AFTER_MS=1200000`
- `PROCESS_TIMEOUT_MS=720000`

`PORT` é fornecida automaticamente pelo Railway. Não fixe `PORT` no painel.

## Proteções já incluídas
- apenas URLs HTTPS dos hosts oficiais do YouTube;
- sem `shell: true` ao executar yt-dlp/FFmpeg;
- limite de 15 minutos validado no servidor;
- duração novamente validada no backend antes do job;
- baixa somente o trecho escolhido, não o vídeo inteiro;
- limite de tamanho para o arquivo baixado;
- limite global e por IP de jobs simultâneos;
- rate limit nas APIs;
- timeouts para análise/processamento;
- verificação de espaço livre;
- arquivos temporários aleatórios por job;
- arquivo-fonte apagado imediatamente após o encode;
- resultado apagado após download ou expiração;
- limpeza em cancelamento, erro, desligamento e reinício;
- headers de segurança e CSP;
- job vinculado ao IP que o criou.

## Observação importante
A hospedagem pública de um downloader de YouTube pode consumir banda/CPU rapidamente e pode estar sujeita aos termos do YouTube e do provedor de hospedagem. Use apenas para conteúdo que você tenha direito de baixar/processar e confira os termos do serviço antes de abrir ao público.
