# Robô SEI NIAR v11.4 — Leitura robusta e validada do documento

Esta versão melhora a abertura/leitura do documento no SEI.

## Principais ajustes

- Tenta abrir o documento por várias estratégias:
  - texto exato da árvore;
  - nome do documento;
  - ID SEI;
  - link/âncora com texto;
  - item pai da árvore;
  - clique forçado com Playwright/JavaScript;
  - duplo clique;
  - href/link direto em nova página.
- Valida se o texto lido parece corresponder ao documento certo.
- Se a leitura não for confirmada, gera alerta mesmo assim, sem inventar assunto.
- Documento novo em processo monitorado gera alerta; a janela de data classifica como normal/informativo.
- Demanda automática continua restrita a documento recente e regra compatível.

## Render

Mantenha o Start Command:

```bash
npx playwright install chromium && node index.js
```

Variáveis principais:

```env
ROBOT_MODE=sei
SUPABASE_URL=https://xzdumqnipmomybsydmvf.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sua_secret_key
SEI_URL=link_do_sei
SEI_USER=seu_usuario
SEI_PASSWORD=sua_senha
SEI_UNIDADE=JP II
ROBOT_TRIGGER_TOKEN=NIAR_CREG_ROBO_2026_9284
DEMAND_DOCUMENT_RECENCY_DAYS=3
ALERT_DOCUMENT_RECENCY_DAYS=7
SEI_TIMEOUT_MS=45000
SEI_MAX_DOCUMENTS=40
SEI_READ_LAST_DOCUMENTS=1
SEI_HEADLESS=true
SEI_DEBUG=false
```

## Teste manual

```text
https://robo-sei.onrender.com/trigger?token=NIAR_CREG_ROBO_2026_9284
```
