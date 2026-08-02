# Robô SEI v15.8

Ajustes desta versão:

- Mantém fila persistente/retomada da v15.
- Cria `alert_event_key` por processo + ID SEI + tipo + documento + setor gerador.
- Antes de criar alerta, verifica se a chave já existe em `processo_alertas`.
- Alerta com status `Ignorado` ou `Resolvido` não é recriado na próxima varredura.
- Novo documento/novo ID no mesmo processo continua gerando novo alerta.

Rode também o SQL `schema_v15_8_correcoes_demandas_robo_alertas.sql` no Supabase.
