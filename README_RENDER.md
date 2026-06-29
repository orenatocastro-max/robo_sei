# Robô SEI NIAR v14 — Varredura em lotes e retomada automática

Esta versão evita travamento por tempo longo no Render. O robô processa os processos monitorados em lotes, registra os processos já verificados e retoma automaticamente até concluir a varredura.

## Mantém
- Login no SEI real;
- leitura robusta dos documentos;
- alerta fallback quando não conseguir ler o conteúdo;
- regra de setor gerador do documento;
- registro de execuções do robô.

## Novas variáveis recomendadas no Render

```env
ROBOT_BATCH_SIZE=5
ROBOT_TIME_BUDGET_MINUTES=10
ROBOT_SELF_RESUME_DELAY_SECONDS=30
ROBOT_EXECUTION_STALE_MINUTES=30
```

Sugestão inicial: deixar 5 processos por lote e 10 minutos por execução. Se o Render estiver estável, pode aumentar para 8 ou 10.

## Start Command

Mantenha:

```bash
npx playwright install chromium && node index.js
```

## SQL

Rode no Supabase o arquivo `schema_robo_v14_lotes.sql`. Ele não apaga dados; só adiciona colunas para registrar retomada/lotes.

## Rotas

- `/trigger?token=...` executa ou retoma a varredura;
- `/reset-lock?token=...` libera a trava local do processo Node, caso fique preso em `already-running`.

