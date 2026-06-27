import express from 'express';
import { createClient } from '@supabase/supabase-js';

const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Variável obrigatória ausente: ${key}`);
    process.exit(1);
  }
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

const MODE = process.env.ROBOT_MODE || 'simulation';
const INTERVAL_MINUTES = Number(process.env.CHECK_INTERVAL_MINUTES || 60);
let running = false;
let lastResult = null;

function nowBR() {
  return new Date().toLocaleString('pt-BR', { timeZone: 'America/Porto_Velho' });
}

function normalize(s = '') {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function ruleMatches(mov, rule) {
  const setor = normalize(rule.setor_interesse || rule.setor_alerta || '');
  const tipo = normalize(rule.tipo_documento_interesse || rule.tipo_documento_alerta || '');
  if (setor && !normalize(mov.setor).includes(setor)) return false;
  if (tipo && !normalize(mov.tipo_documento).includes(tipo) && !normalize(mov.documento).includes(tipo)) return false;
  return true;
}

async function fetchMonitoredItems() {
  const { data: contratos, error: cErr } = await supabase
    .from('contratos')
    .select('*')
    .eq('monitorar_sei', true);
  if (cErr) throw cErr;

  const { data: avulsos, error: pErr } = await supabase
    .from('processos_monitorados')
    .select('*')
    .eq('monitoramento_ativo', true);
  if (pErr) throw pErr;

  return [
    ...(contratos || []).map(c => ({
      origem: 'contrato',
      id: c.id,
      contrato_id: c.id,
      numero_processo: c.processo,
      assunto: `Contrato ${c.numero_contrato || 's/n'} - ${c.prestador || ''}`,
      setor_alerta: c.setor_alerta,
      tipo_documento_alerta: c.tipo_documento_alerta,
      gerar_alerta: c.gerar_alerta_sei !== false,
      gerar_demanda: !!c.gerar_demanda_sei,
      raw: c
    })),
    ...(avulsos || []).map(p => ({
      origem: 'avulso',
      id: p.id,
      processo_monitorado_id: p.id,
      contrato_id: p.contrato_id || null,
      numero_processo: p.numero_processo,
      assunto: p.assunto,
      setor_interesse: p.setor_interesse,
      tipo_documento_interesse: p.tipo_documento_interesse,
      gerar_alerta: p.gerar_alerta !== false,
      gerar_demanda: !!p.gerar_demanda,
      raw: p
    }))
  ].filter(x => x.numero_processo);
}

async function getMovementsFromSEI(item) {
  if (MODE === 'simulation') {
    const dateKey = new Date().toISOString().slice(0, 10);
    return [{
      data_movimentacao: nowBR(),
      setor: item.setor_interesse || item.setor_alerta || 'GECONT',
      tipo_documento: item.tipo_documento_interesse || item.tipo_documento_alerta || 'Despacho',
      documento: `Movimentação teste ${dateKey}`,
      resumo: `Movimentação simulada pelo robô para validar o processo ${item.numero_processo}.`,
      hash_movimentacao: `sim:${item.origem}:${item.id}:${dateKey}`
    }];
  }

  // Próximo passo: implementar consulta real com Playwright.
  // O login está preparado por variáveis SEI_URL, SEI_USER e SEI_PASSWORD.
  // Precisamos mapear os seletores reais do SEI em uma execução assistida.
  console.warn('ROBOT_MODE=real ainda exige mapeamento dos seletores do SEI. Nenhuma movimentação real foi coletada.');
  return [];
}

async function createDemandIfNeeded(item, movement, alerta) {
  if (!item.gerar_demanda || !item.contrato_id) return null;
  const titulo = `Verificar movimentação SEI - ${item.assunto}`.slice(0, 220);
  const { data: existing } = await supabase
    .from('demandas')
    .select('id')
    .eq('contrato_id', item.contrato_id)
    .eq('titulo', titulo)
    .in('status', ['Aberta', 'Em andamento', 'Aguardando resposta'])
    .maybeSingle();
  if (existing?.id) return existing.id;
  const { data, error } = await supabase.from('demandas').insert({
    contrato_id: item.contrato_id,
    titulo,
    status: 'Aberta',
    prioridade: 'Alta',
    observacao: `Demanda automática gerada pelo robô SEI.\nProcesso: ${item.numero_processo}\nDocumento: ${movement.documento}\nSetor: ${movement.setor}\nAlerta: ${alerta?.titulo || ''}`
  }).select('id').single();
  if (error) throw error;
  return data.id;
}

async function processItem(item) {
  const movements = await getMovementsFromSEI(item);
  let newMovements = 0;
  let alerts = 0;

  for (const mov of movements) {
    const { error: movErr } = await supabase.from('processo_movimentacoes').insert({
      processo_monitorado_id: item.origem === 'avulso' ? item.id : null,
      contrato_id: item.contrato_id || null,
      numero_processo: item.numero_processo,
      ...mov
    });
    if (movErr && !String(movErr.message).includes('duplicate')) throw movErr;
    if (!movErr) newMovements++;

    if (!item.gerar_alerta || !ruleMatches(mov, item)) continue;

    const source_hash = `alert:${mov.hash_movimentacao}`;
    const alertaPayload = {
      processo_monitorado_id: item.origem === 'avulso' ? item.id : null,
      contrato_id: item.contrato_id || null,
      numero_processo: item.numero_processo,
      titulo: `Nova movimentação no processo ${item.numero_processo}`,
      descricao: mov.resumo || `Documento ${mov.documento} identificado pelo robô SEI.`,
      setor: mov.setor,
      tipo_documento: mov.tipo_documento,
      documento: mov.documento,
      data_movimentacao: mov.data_movimentacao,
      source_hash,
      status: 'Pendente',
      gerar_demanda: !!item.gerar_demanda
    };
    const { data: inserted, error: alertErr } = await supabase
      .from('processo_alertas')
      .insert(alertaPayload)
      .select('*')
      .single();
    if (alertErr && !String(alertErr.message).includes('duplicate')) throw alertErr;
    if (!alertErr) {
      alerts++;
      const demandaId = await createDemandIfNeeded(item, mov, inserted);
      if (demandaId) await supabase.from('processo_alertas').update({ demanda_id: demandaId }).eq('id', inserted.id);
    }
  }

  const update = item.origem === 'contrato'
    ? supabase.from('contratos').update({ ultimo_monitoramento_sei: nowBR(), ultima_movimentacao_sei: movements[0]?.data_movimentacao || null }).eq('id', item.id)
    : supabase.from('processos_monitorados').update({ ultimo_monitoramento: nowBR(), ultima_movimentacao: movements[0]?.data_movimentacao || null }).eq('id', item.id);
  const { error: updateErr } = await update;
  if (updateErr) throw updateErr;
  return { item: item.assunto, newMovements, alerts };
}

export async function runRobot() {
  if (running) return { status: 'already-running' };
  running = true;
  const startedAt = new Date().toISOString();
  try {
    const items = await fetchMonitoredItems();
    const results = [];
    for (const item of items) results.push(await processItem(item));
    lastResult = { startedAt, finishedAt: new Date().toISOString(), mode: MODE, monitored: items.length, results };
    console.log(JSON.stringify(lastResult, null, 2));
    return lastResult;
  } finally {
    running = false;
  }
}

const app = express();
app.get('/health', (_req, res) => res.json({ ok: true, mode: MODE, running, lastResult }));
app.post('/run', async (_req, res) => {
  try { res.json(await runRobot()); }
  catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});
app.get('/run', async (_req, res) => {
  try { res.json(await runRobot()); }
  catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

if (process.argv.includes('--once')) {
  runRobot().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
} else {
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => console.log(`Robô SEI NIAR rodando na porta ${port}. Modo: ${MODE}`));
  setInterval(() => runRobot().catch(err => console.error(err)), Math.max(5, INTERVAL_MINUTES) * 60 * 1000);
  setTimeout(() => runRobot().catch(err => console.error(err)), 5000);
}
