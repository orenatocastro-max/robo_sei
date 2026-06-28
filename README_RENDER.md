# Robô SEI NIAR v11 — leitura real do SEI

Esta versão adiciona o modo real `ROBOT_MODE=sei` usando Playwright.

## O que faz

- Acessa o SEI com usuário/senha/unidade.
- Pesquisa o processo monitorado.
- Lê a árvore de documentos.
- Abre o último documento localizado.
- Tenta extrair texto do documento.
- Gera assunto identificado, resumo e trecho lido.
- Salva movimentação e alerta no Supabase.
- Mantém as regras de recência:
  - demanda: documentos até 3 dias;
  - alerta: documentos até 7 dias;
  - primeira leitura não gera demanda.

## Variáveis obrigatórias no Render

```env
ROBOT_MODE=sei
SUPABASE_URL=https://xzdumqnipmomybsydmvf.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sua_secret_key_do_supabase
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

## Build/Start no Render

- Build command: `npm install`
- Start command: `npm start`
- Root directory: vazio, se os arquivos estiverem na raiz do GitHub.

## Como testar

Depois do deploy, abra:

```text
https://robo-sei.onrender.com/health
```

Para executar manualmente:

```text
https://robo-sei.onrender.com/trigger?token=NIAR_CREG_ROBO_2026_9284
```

## Observação importante

Esta versão depende do layout real do SEI. Se o SEI mudar ou algum seletor não for encontrado, o log do Render vai dizer em qual etapa falhou.

Se o login falhar, o robô para para evitar captcha.
