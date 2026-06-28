# Robô SEI NIAR v11.1 - Correção Render/Playwright

Esta versão corrige o erro de build no Render:

```
npm error Exit handler never called!
```

## Configuração no Render

Use exatamente estes comandos:

```
Build Command: npm install && npx playwright install chromium
Start Command: npm start
Root Directory: vazio
```

## Variáveis principais

```
ROBOT_MODE=sei
SUPABASE_URL=https://xzdumqnipmomybsydmvf.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sua_secret_key
SEI_URL=link_da_tela_de_login_do_SEI
SEI_USER=seu_usuario
SEI_PASSWORD=sua_senha
SEI_UNIDADE=JP II
RUN_INTERVAL_MINUTES=60
ROBOT_TRIGGER_TOKEN=NIAR_CREG_ROBO_2026_9284
DEMAND_DOCUMENT_RECENCY_DAYS=3
ALERT_DOCUMENT_RECENCY_DAYS=7
SEI_TIMEOUT_MS=45000
SEI_MAX_DOCUMENTS=40
SEI_READ_LAST_DOCUMENTS=1
SEI_HEADLESS=true
SEI_DEBUG=false
```

## Como testar

Após o deploy ficar Live, abra:

```
https://robo-sei.onrender.com/trigger?token=NIAR_CREG_ROBO_2026_9284
```

O retorno deve mostrar:

```
"mode": "sei"
```

Se der erro, envie o print dos Logs do Render.


## v11.2 - correção WebSocket no Render
Esta versão adiciona a dependência `ws` e configura o Supabase Realtime para Node 20 no Render, corrigindo o erro:

`Node.js 20 detected without native WebSocket support.`

Após substituir os arquivos no GitHub, mantenha o Start Command:

`npx playwright install chromium && node index.js`

Depois rode no Render: Manual Deploy > Clear build cache & deploy.
