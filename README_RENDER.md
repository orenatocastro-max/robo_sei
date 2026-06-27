# Robô SEI NIAR v10.1 - Rotas de acionamento corrigidas

Esta versão corrige o teste manual no navegador e mantém compatibilidade com o botão do site.

## Rotas disponíveis

- `GET /` — mostra status básico do robô.
- `GET /health` — status técnico.
- `GET /run` ou `POST /run` — executa o robô. Usada pelo site v10.
- `GET /trigger` ou `POST /trigger` — rota alternativa para teste manual.

## Como atualizar no GitHub

Envie estes arquivos para a raiz do repositório do robô:

- `index.js`
- `package.json`
- `package-lock.json`
- `README_RENDER.md`
- `.env.example`

Depois, no Render:

`Manual Deploy > Clear build cache & deploy`

## Variáveis necessárias no Render

```env
ROBOT_MODE=simulation
SUPABASE_URL=https://xzdumqnipmomybsydmvf.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sua_secret_key
SEI_URL=link_do_sei
SEI_USER=seu_usuario
SEI_PASSWORD=sua_senha
SEI_UNIDADE=JP II
RUN_INTERVAL_MINUTES=60
ROBOT_TRIGGER_TOKEN=NIAR_CREG_ROBO_2026_9284
DEMAND_DOCUMENT_RECENCY_DAYS=3
ALERT_DOCUMENT_RECENCY_DAYS=7
```

Se `ROBOT_TRIGGER_TOKEN` estiver configurado, ao testar no navegador use:

`https://robo-sei.onrender.com/trigger?token=NIAR_CREG_ROBO_2026_9284`
