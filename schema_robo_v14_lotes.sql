-- Robô SEI v14 - suporte a varredura em lotes e retomada automática

create table if not exists robo_execucoes (
  id uuid primary key default gen_random_uuid(),
  inicio timestamptz,
  fim timestamptz,
  status text,
  modo text,
  processos_monitorados integer default 0,
  processos_verificados integer default 0,
  processos_erro integer default 0,
  alertas_gerados integer default 0,
  demandas_geradas integer default 0,
  mensagem text,
  created_at timestamptz default now()
);

create table if not exists robo_execucao_itens (
  id uuid primary key default gen_random_uuid(),
  execucao_id uuid references robo_execucoes(id) on delete cascade,
  item_nome text,
  numero_processo text,
  origem text,
  status text,
  mensagem text,
  documento text,
  movimentos integer default 0,
  alertas integer default 0,
  demandas integer default 0,
  created_at timestamptz default now()
);

alter table if exists robo_execucao_itens add column if not exists item_key text;
alter table if exists robo_execucao_itens add column if not exists item_id uuid;
alter table if exists robo_execucao_itens add column if not exists ordem integer;
alter table if exists robo_execucao_itens add column if not exists inicio_item timestamptz;
alter table if exists robo_execucao_itens add column if not exists fim_item timestamptz;
alter table if exists robo_execucao_itens add column if not exists duracao_ms integer;

alter table if exists robo_execucoes add column if not exists lote_atual integer default 1;
alter table if exists robo_execucoes add column if not exists ultimo_item_key text;
alter table if exists robo_execucoes add column if not exists retomada_automatica boolean default false;

create unique index if not exists idx_robo_execucao_itens_exec_item_key
  on robo_execucao_itens(execucao_id, item_key)
  where item_key is not null;

notify pgrst, 'reload schema';
