-- Central Contratual v15 - melhorias contratos, documentos, processos avulsos e robô em fila
-- Seguro para rodar em base existente. Não apaga dados.

create extension if not exists pgcrypto;

-- Natureza do contrato e vínculos novos
alter table if exists public.contratos add column if not exists natureza text;

-- Documentos também podem pertencer a processos avulsos
alter table if exists public.documentos add column if not exists processo_monitorado_id uuid references public.processos_monitorados(id) on delete set null;
create index if not exists documentos_processo_monitorado_idx on public.documentos(processo_monitorado_id);

-- Histórico também pode pertencer a processo avulso
alter table if exists public.historico add column if not exists processo_monitorado_id uuid references public.processos_monitorados(id) on delete cascade;
create index if not exists historico_processo_monitorado_idx on public.historico(processo_monitorado_id);

-- Execuções do robô e controle de fila/retomada
create table if not exists public.robo_execucoes (
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
  lote_atual integer default 1,
  ultimo_item_key text,
  retomada_automatica boolean default false,
  created_at timestamptz default now()
);

create table if not exists public.robo_execucao_itens (
  id uuid primary key default gen_random_uuid(),
  execucao_id uuid references public.robo_execucoes(id) on delete cascade,
  item_nome text,
  numero_processo text,
  origem text,
  status text,
  mensagem text,
  documento text,
  movimentos integer default 0,
  alertas integer default 0,
  demandas integer default 0,
  item_key text,
  item_id uuid,
  ordem integer,
  inicio_item timestamptz,
  fim_item timestamptz,
  duracao_ms integer,
  created_at timestamptz default now()
);

alter table if exists public.robo_execucao_itens add column if not exists item_key text;
alter table if exists public.robo_execucao_itens add column if not exists item_id uuid;
alter table if exists public.robo_execucao_itens add column if not exists ordem integer;
alter table if exists public.robo_execucao_itens add column if not exists inicio_item timestamptz;
alter table if exists public.robo_execucao_itens add column if not exists fim_item timestamptz;
alter table if exists public.robo_execucao_itens add column if not exists duracao_ms integer;
alter table if exists public.robo_execucoes add column if not exists lote_atual integer default 1;
alter table if exists public.robo_execucoes add column if not exists ultimo_item_key text;
alter table if exists public.robo_execucoes add column if not exists retomada_automatica boolean default false;

create unique index if not exists idx_robo_execucao_itens_exec_item_key
  on public.robo_execucao_itens(execucao_id, item_key)
  where item_key is not null;

-- Campos de leitura segura / setor gerador
alter table if exists public.processo_movimentacoes add column if not exists setor_gerador text;
alter table if exists public.processo_movimentacoes add column if not exists setor_origem text;
alter table if exists public.processo_alertas add column if not exists setor_gerador text;
alter table if exists public.processo_alertas add column if not exists setor_origem text;
alter table if exists public.processo_movimentacoes add column if not exists tentativas_leitura jsonb;
alter table if exists public.processo_movimentacoes add column if not exists estrategia_leitura text;
alter table if exists public.processo_movimentacoes add column if not exists leitura_confirmada boolean default false;
alter table if exists public.processo_movimentacoes add column if not exists erro_leitura text;
alter table if exists public.processo_alertas add column if not exists tentativas_leitura jsonb;
alter table if exists public.processo_alertas add column if not exists estrategia_leitura text;
alter table if exists public.processo_alertas add column if not exists leitura_confirmada boolean default false;
alter table if exists public.processo_alertas add column if not exists erro_leitura text;
alter table if exists public.processo_alertas add column if not exists nivel_alerta text;
alter table if exists public.processo_alertas add column if not exists id_sei text;

-- Listas oficiais novas
insert into public.lista_opcoes (categoria, valor, ativo) values
('natureza','Contratualizado', true),
('natureza','Próprio', true),
('natureza','Pactuação', true),
('natureza','Contrato de Gestão', true)
on conflict (categoria, valor) do update set ativo = excluded.ativo;

alter table if exists public.robo_execucoes enable row level security;
alter table if exists public.robo_execucao_itens enable row level security;

drop policy if exists "robo_execucoes_select_auth" on public.robo_execucoes;
create policy "robo_execucoes_select_auth" on public.robo_execucoes for select to authenticated using (true);

drop policy if exists "robo_execucao_itens_select_auth" on public.robo_execucao_itens;
create policy "robo_execucao_itens_select_auth" on public.robo_execucao_itens for select to authenticated using (true);

notify pgrst, 'reload schema';
