# Robô SEI NIAR v11.9 - leitura segura e alerta limpo

Melhorias:
- descarta texto da árvore do processo como se fosse documento;
- só confirma leitura quando encontra sinais confiáveis de documento;
- assunto específico só é gerado quando houver padrão confiável como `Assunto:`, `Referência:` ou conteúdo confirmado;
- se não conseguir ler, gera alerta seguro sem inventar assunto;
- salva `nivel_alerta`, `leitura_confirmada`, `estrategia_leitura`, `erro_leitura` e `tentativas_leitura`.

Start Command no Render:

```bash
npx playwright install chromium && node index.js
```

Mantenha `ROBOT_MODE=sei` para SEI real.

## v12.0.0

Correções:
- Filtra candidatos para considerar apenas documentos SEI com padrão `Tipo ... (ID)`.
- Evita classificar `SESAU-GECONT - GERÊNCIA DE CONTRATOS` como documento do tipo Contrato.
- Alerta passa a sair com título no padrão: `Tipo do documento (ID) inserido no processo ...`.
- Continua salvando assunto/resumo quando a leitura for confiável.
