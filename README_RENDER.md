# Robô SEI NIAR - Render

Use este serviço no Render separado do site.

Variáveis obrigatórias:

- `ROBOT_MODE=simulation` para teste
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `RUN_INTERVAL_MINUTES=60`

Variáveis para o SEI real, quando habilitar:

- `SEI_URL`
- `SEI_USER`
- `SEI_PASSWORD`
- `SEI_UNIDADE`

No Render:

- Build Command: `npm install`
- Start Command: `npm start`
- Root Directory: vazio se os arquivos estiverem na raiz do repositório.

Rotas úteis:

- `/health`
- `/run`
