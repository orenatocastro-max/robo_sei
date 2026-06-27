# Robô SEI NIAR - Render

Este projeto é o serviço separado que roda no Render e grava alertas no Supabase.

## Primeiro teste recomendado

Use `ROBOT_MODE=simulation`. Assim o robô não entra no SEI ainda; ele apenas valida:

Render → Supabase → Site → Aba Processos/Alertas

Depois que o alerta aparecer no site, a próxima etapa é mapear a consulta real do SEI com Playwright.

## Variáveis no Render

Configure em Environment:

```txt
SUPABASE_URL=https://xzdumqnipmomybsydmvf.supabase.co
SUPABASE_SERVICE_ROLE_KEY=service_role_key_do_supabase
SEI_URL=https://sei.sistemas.ro.gov.br/sei/
SEI_USER=usuario_do_sei
SEI_PASSWORD=senha_do_sei
ROBOT_MODE=simulation
CHECK_INTERVAL_MINUTES=60
```

Atenção: `SUPABASE_SERVICE_ROLE_KEY` nunca deve ir para o site, GitHub público ou Netlify.

## Configuração no Render

Tipo recomendado para teste: Web Service.

```txt
Build Command: npm install
Start Command: npm start
```

Depois acesse:

```txt
https://seu-servico.onrender.com/health
https://seu-servico.onrender.com/run
```

## Modo real

Troque `ROBOT_MODE=real` somente depois de mapearmos os seletores do SEI. O arquivo `index.js` já tem o local preparado para incluir Playwright.
