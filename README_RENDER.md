# Robô SEI NIAR v11.3 - alerta mesmo sem leitura do documento

Correções:
- Movimentação nova gera alerta mesmo quando o robô não consegue clicar/ler o documento.
- A leitura do documento apenas enriquece o alerta com assunto/resumo; não bloqueia o alerta.
- Regras de setor e tipo agora aceitam múltiplos valores separados por vírgula, ponto e vírgula ou quebra de linha.
- Corrigida interpretação de data brasileira com horário, evitando bloquear alerta por recência.

Render:
- Start Command: `npx playwright install chromium && node index.js`
- Root Directory: vazio
- ROBOT_MODE=sei

Após substituir os arquivos no GitHub, rode no Render:
Manual Deploy > Clear build cache & deploy
