-- =========================================================
-- CENTRAL CONTRATUAL / NIAR - SQL v15.8
-- Correções: demandas, não monitorados, ativar monitoramento,
-- alertas tratados sem duplicidade e cache do Supabase.
-- Pode rodar no SQL Editor. Não apaga dados.
-- =========================================================

create extension if not exists pgcrypto;

-- =========================================================
-- 1) CONTRATOS - colunas usadas pelo sistema atual
-- =========================================================
alter table if exists public.contratos
  add column if not exists ativo boolean default true,
  add column if not exists natureza text default 'Contratualizado',
  add column if not exists processo text,
  add column if not exists prestador text,
  add column if not exists numero_contrato text,
  add column if not exists monitorar_sei boolean default false,
  add column if not exists setor_alerta text default 'GECONT, GPACC, PGE',
  add column if not exists tipo_documento_alerta text,
  add column if not exists gerar_alerta_sei boolean default true,
  add column if not exists gerar_demanda_sei boolean default true,
  add column if not exists updated_at timestamptz default now();

update public.contratos set ativo = true where ativo is null;
update public.contratos set natureza = 'Contratualizado' where natureza is null or trim(natureza) = '';
update public.contratos set monitorar_sei = false where monitorar_sei is null;
update public.contratos set setor_alerta = 'GECONT, GPACC, PGE' where setor_alerta is null or trim(setor_alerta) = '';
update public.contratos set gerar_alerta_sei = true where gerar_alerta_sei is null;
update public.contratos set gerar_demanda_sei = true where gerar_demanda_sei is null;

-- =========================================================
-- 2) DEMANDAS - corrige salvamento e permissões
-- =========================================================
create table if not exists public.demandas (
  id uuid primary key default gen_random_uuid(),
  contrato_id uuid,
  processo_avulso_id uuid,
  titulo text not null,
  descricao text,
  observacao text,
  prazo text,
  status text default 'Aberta',
  prioridade text default 'Média',
  responsavel text,
  origem text default 'manual',
  criado_por uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.demandas
  add column if not exists contrato_id uuid,
  add column if not exists processo_avulso_id uuid,
  add column if not exists titulo text,
  add column if not exists descricao text,
  add column if not exists observacao text,
  add column if not exists prazo text,
  add column if not exists status text default 'Aberta',
  add column if not exists prioridade text default 'Média',
  add column if not exists responsavel text,
  add column if not exists origem text default 'manual',
  add column if not exists criado_por uuid,
  add column if not exists created_at timestamptz default now(),
  add column if not exists updated_at timestamptz default now();

update public.demandas set status = 'Aberta' where status is null or trim(status) = '';
update public.demandas set prioridade = 'Média' where prioridade is null or trim(prioridade) = '';
update public.demandas set origem = 'manual' where origem is null or trim(origem) = '';
update public.demandas set created_at = now() where created_at is null;
update public.demandas set updated_at = now() where updated_at is null;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_demandas_updated_at on public.demandas;
create trigger trg_demandas_updated_at
before update on public.demandas
for each row execute function public.set_updated_at();

alter table public.demandas enable row level security;
drop policy if exists demandas_select on public.demandas;
create policy demandas_select on public.demandas for select to authenticated using (true);
drop policy if exists demandas_insert on public.demandas;
create policy demandas_insert on public.demandas for insert to authenticated with check (true);
drop policy if exists demandas_update on public.demandas;
create policy demandas_update on public.demandas for update to authenticated using (true) with check (true);
drop policy if exists demandas_delete on public.demandas;
create policy demandas_delete on public.demandas for delete to authenticated using (true);

grant select, insert, update, delete on public.demandas to authenticated;
create index if not exists idx_demandas_contrato_id on public.demandas(contrato_id);
create index if not exists idx_demandas_processo_avulso_id on public.demandas(processo_avulso_id);
create index if not exists idx_demandas_status on public.demandas(status);

-- =========================================================
-- 3) PROCESSOS MONITORADOS / AVULSOS
-- =========================================================
create table if not exists public.processos_monitorados (
  id uuid primary key default gen_random_uuid(),
  numero_processo text,
  assunto text,
  tipo text,
  interessado text,
  observacao text,
  contrato_id uuid,
  monitoramento_ativo boolean default true,
  setor_interesse text default 'GECONT, GPACC, PGE',
  tipo_documento_interesse text,
  gerar_alerta boolean default true,
  gerar_demanda boolean default true,
  ultimo_monitoramento text,
  ultima_movimentacao text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.processos_monitorados
  add column if not exists numero_processo text,
  add column if not exists assunto text,
  add column if not exists tipo text,
  add column if not exists interessado text,
  add column if not exists observacao text,
  add column if not exists contrato_id uuid,
  add column if not exists monitoramento_ativo boolean default true,
  add column if not exists setor_interesse text default 'GECONT, GPACC, PGE',
  add column if not exists tipo_documento_interesse text,
  add column if not exists gerar_alerta boolean default true,
  add column if not exists gerar_demanda boolean default true,
  add column if not exists ultimo_monitoramento text,
  add column if not exists ultima_movimentacao text,
  add column if not exists created_at timestamptz default now(),
  add column if not exists updated_at timestamptz default now();

update public.processos_monitorados set monitoramento_ativo = true where monitoramento_ativo is null;
update public.processos_monitorados set setor_interesse = 'GECONT, GPACC, PGE' where setor_interesse is null or trim(setor_interesse) = '';
update public.processos_monitorados set gerar_alerta = true where gerar_alerta is null;
update public.processos_monitorados set gerar_demanda = true where gerar_demanda is null;

alter table public.processos_monitorados enable row level security;
drop policy if exists processos_monitorados_select on public.processos_monitorados;
create policy processos_monitorados_select on public.processos_monitorados for select to authenticated using (true);
drop policy if exists processos_monitorados_insert on public.processos_monitorados;
create policy processos_monitorados_insert on public.processos_monitorados for insert to authenticated with check (true);
drop policy if exists processos_monitorados_update on public.processos_monitorados;
create policy processos_monitorados_update on public.processos_monitorados for update to authenticated using (true) with check (true);
drop policy if exists processos_monitorados_delete on public.processos_monitorados;
create policy processos_monitorados_delete on public.processos_monitorados for delete to authenticated using (true);
grant select, insert, update, delete on public.processos_monitorados to authenticated;

-- =========================================================
-- 4) VIEW: contratos e processos não monitorados
-- Não usa c.nome nem c.razao_social.
-- Exclui Rede Própria/Próprio da cobrança de monitoramento.
-- =========================================================
drop view if exists public.vw_nao_monitorados;

create or replace view public.vw_nao_monitorados as
select
  'contrato'::text as origem,
  c.id::text as referencia_id,
  coalesce(c.numero_contrato::text, 's/n') as numero,
  coalesce(nullif(c.prestador::text, ''), nullif(c.numero_contrato::text, ''), 'Contrato sem identificação') as titulo,
  coalesce(c.processo::text, '') as processo,
  coalesce(c.natureza::text, '') as natureza,
  'Contrato ativo'::text as situacao,
  case when coalesce(c.processo::text, '') = '' then 'Sem número de processo SEI informado' else 'Monitoramento SEI desativado' end as motivo,
  case when coalesce(c.processo::text, '') <> '' then true else false end as pode_ativar
from public.contratos c
where coalesce(c.ativo, true) = true
  and lower(coalesce(c.situacao::text, 'ativo')) not in ('inativo','encerrado','vencido')
  and coalesce(c.monitorar_sei, false) = false
  and lower(coalesce(c.natureza::text, '')) not in ('proprio','próprio','propria','própria','rede propria','rede própria')

union all

select
  'avulso'::text as origem,
  p.id::text as referencia_id,
  coalesce(p.numero_processo::text, 's/n') as numero,
  coalesce(nullif(p.assunto::text, ''), nullif(p.interessado::text, ''), nullif(p.numero_processo::text, ''), 'Processo avulso sem identificação') as titulo,
  coalesce(p.numero_processo::text, '') as processo,
  'Processo avulso'::text as natureza,
  'Processo avulso'::text as situacao,
  case when coalesce(p.numero_processo::text, '') = '' then 'Sem número de processo SEI informado' else 'Monitoramento SEI desativado' end as motivo,
  case when coalesce(p.numero_processo::text, '') <> '' then true else false end as pode_ativar
from public.processos_monitorados p
where coalesce(p.monitoramento_ativo, false) = false;

grant select on public.vw_nao_monitorados to authenticated;

-- =========================================================
-- 5) RPC: botão Ativar monitoramento
-- =========================================================
create or replace function public.ativar_monitoramento_sei_padrao(
  p_origem text,
  p_id uuid,
  p_setores text default 'GECONT, GPACC, PGE'
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
begin
  if lower(coalesce(p_origem, '')) = 'contrato' then
    update public.contratos
       set monitorar_sei = true,
           setor_alerta = coalesce(nullif(p_setores, ''), 'GECONT, GPACC, PGE'),
           gerar_alerta_sei = true,
           gerar_demanda_sei = true,
           updated_at = now()
     where id = p_id
       and coalesce(processo, '') <> '';
    get diagnostics v_count = row_count;
    return v_count > 0;
  end if;

  update public.processos_monitorados
     set monitoramento_ativo = true,
         setor_interesse = coalesce(nullif(p_setores, ''), 'GECONT, GPACC, PGE'),
         gerar_alerta = true,
         gerar_demanda = true,
         updated_at = now()
   where id = p_id
     and coalesce(numero_processo, '') <> '';

  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

grant execute on function public.ativar_monitoramento_sei_padrao(text, uuid, text) to authenticated;

-- =========================================================
-- 6) Alertas: status tratado não deve duplicar na próxima varredura
-- =========================================================
create table if not exists public.processo_alertas (
  id uuid primary key default gen_random_uuid(),
  processo_monitorado_id uuid,
  contrato_id uuid,
  demanda_id uuid,
  numero_processo text,
  titulo text,
  descricao text,
  setor text,
  setor_gerador text,
  setor_origem text,
  tipo_documento text,
  documento text,
  id_sei text,
  data_movimentacao text,
  source_hash text,
  alert_event_key text,
  status text default 'Pendente',
  observacao_gestor text,
  gerar_demanda boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.processo_alertas
  add column if not exists processo_monitorado_id uuid,
  add column if not exists contrato_id uuid,
  add column if not exists demanda_id uuid,
  add column if not exists numero_processo text,
  add column if not exists titulo text,
  add column if not exists descricao text,
  add column if not exists assunto_identificado text,
  add column if not exists resumo_documento text,
  add column if not exists texto_documento text,
  add column if not exists estrategia_leitura text,
  add column if not exists leitura_confirmada boolean default false,
  add column if not exists erro_leitura text,
  add column if not exists tentativas_leitura integer,
  add column if not exists nivel_alerta text,
  add column if not exists setor text,
  add column if not exists setor_gerador text,
  add column if not exists setor_origem text,
  add column if not exists tipo_documento text,
  add column if not exists documento text,
  add column if not exists id_sei text,
  add column if not exists data_movimentacao text,
  add column if not exists source_hash text,
  add column if not exists alert_event_key text,
  add column if not exists status text default 'Pendente',
  add column if not exists observacao_gestor text,
  add column if not exists gerar_demanda boolean default false,
  add column if not exists created_at timestamptz default now(),
  add column if not exists updated_at timestamptz default now();

drop index if exists public.uq_processo_alertas_event_key;

-- Normaliza chaves antigas inválidas/duplicadas, sem apagar alerta antigo.
update public.processo_alertas
set alert_event_key = md5('alerta_antigo|' || id::text)
where alert_event_key is null
   or trim(alert_event_key) = ''
   or alert_event_key = '||contrato||'
   or alert_event_key = '||processo||'
   or alert_event_key like '%||%';

with duplicados as (
  select id, alert_event_key,
         row_number() over (partition by alert_event_key order by created_at nulls last, id) as rn
  from public.processo_alertas
  where alert_event_key is not null and trim(alert_event_key) <> ''
)
update public.processo_alertas pa
set alert_event_key = md5('alerta_duplicado|' || pa.id::text)
from duplicados d
where pa.id = d.id and d.rn > 1;

create unique index if not exists uq_processo_alertas_event_key
on public.processo_alertas(alert_event_key)
where alert_event_key is not null and trim(alert_event_key) <> '';

alter table public.processo_alertas enable row level security;
drop policy if exists processo_alertas_select on public.processo_alertas;
create policy processo_alertas_select on public.processo_alertas for select to authenticated using (true);
drop policy if exists processo_alertas_insert on public.processo_alertas;
create policy processo_alertas_insert on public.processo_alertas for insert to authenticated with check (true);
drop policy if exists processo_alertas_update on public.processo_alertas;
create policy processo_alertas_update on public.processo_alertas for update to authenticated using (true) with check (true);
drop policy if exists processo_alertas_delete on public.processo_alertas;
create policy processo_alertas_delete on public.processo_alertas for delete to authenticated using (true);
grant select, insert, update, delete on public.processo_alertas to authenticated;

-- =========================================================
-- 7) Cache Supabase/PostgREST
-- =========================================================
notify pgrst, 'reload schema';
