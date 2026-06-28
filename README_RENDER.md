# Robô SEI NIAR v11.7 - Login por coordenada e fallback robusto

Correção focada no login do SEI quando o botão **ACESSAR** não é encontrado como `button`, `input` ou texto comum.

## Mantém

- Login no SEI real (`ROBOT_MODE=sei`)
- Leitura robusta de documento
- Alerta fallback quando não conseguir ler o conteúdo
- Token `/trigger`

## Novidades v11.7

- Tenta clicar em `input`, `button`, `a`, `div`, `span`, `label` com texto/value/id/name parecido com ACESSAR/LOGIN/ENTRAR
- Tenta executar funções comuns de login no JavaScript da página
- Tenta submeter o formulário diretamente
- Tenta navegação por teclado `Tab + Enter`
- Tenta clique por coordenada aproximada abaixo do campo de unidade/senha
- Logs mais claros do método usado

## Start Command no Render

Mantenha:

```bash
npx playwright install chromium && node index.js
```

## Variáveis principais

```env
ROBOT_MODE=sei
SUPABASE_URL=https://xzdumqnipmomybsydmvf.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sua_secret_key
SEI_URL=link_login_sei
SEI_USER=usuario
SEI_PASSWORD=senha
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


## v11.7 - Login por clique calibrável

Se o SEI ainda não acionar o botão ACESSAR, adicione no Render:

```env
SEI_LOGIN_CLICK_X=640
SEI_LOGIN_CLICK_Y=430
```

Essas coordenadas são usadas como fallback para clicar visualmente no botão. Se não funcionar, confira no log `[SEI][DEBUG LOGIN ELEMENTOS]` as coordenadas dos elementos visíveis e ajuste X/Y.
