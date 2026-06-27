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
const INTERVAL_MINUTES = Number(process.env.RUN_INTERVAL_MINUTES || process.env.CHECK_INTERVAL_MINUTES || 60);
const DEMAND_DOCUMENT_RECENCY_DAYS = Number(process.env.DEMAND_DOCUMENT_RECENCY_DAYS || 3);
const ALERT_DOCUMENT_RECENCY_DAYS = Number(process.env.ALERT_DOCUMENT_RECENCY_DAYS || 7);
let running = false;
let lastResult = null;

function nowBR() {
  return new Date().toLocaleString('pt-BR', { timeZone: 'America/Porto_Velho' });
}

function normalize(s = '') {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function firstNonEmptyLine(text = '') {
  return String(text).split(/\r?\n/).map(l => l.trim()).find(Boolean) || '';
}

function cleanText(text = '') {
  return String(text)
    .replace(/\s+/g, ' ')
    .replace(/ /g, ' ')
    .trim();
}

function extractDocumentSubject(text = '', movement = {}) {
  const raw = String(text || '').trim();
  const normalized = normalize(raw);
  const tipo = movement.tipo_documento || movement.documento || 'Documento';

  const explicitPatterns = [
    /assunto\s*[:\-]\s*(.+)/i,
    /ementa\s*[:\-]\s*(.+)/i,
    /refer[êe]ncia\s*[:\-]\s*(.+)/i,
    /objeto\s*[:\-]\s*(.+)/i
  ];
  for (const pattern of explicitPatterns) {
    const match = raw.match(pattern);
    if (match?.[1]) return cleanText(match[1]).slice(0, 180);
  }

  const themes = [
    ['termo aditivo', 'Termo aditivo / alteração contratual'],
    ['aditivo', 'Termo aditivo / alteração contratual'],
    ['apostilamento', 'Apostilamento contratual'],
    ['prorrogacao', 'Prorrogação de vigência contratual'],
    ['vigencia', 'Vigência contratual'],
    ['reequilibrio', 'Reequilíbrio econômico-financeiro'],
    ['valor', 'Atualização ou análise de valores'],
    ['errata', 'Errata / correção documental'],
    ['correcao', 'Correção documental ou cadastral'],
    ['manifestacao', 'Solicitação de manifestação técnica'],
    ['encaminha', 'Encaminhamento para análise'],
    ['despacho', 'Despacho / encaminhamento no processo'],
    ['nota tecnica', 'Nota técnica / análise técnica'],
    ['pagamento', 'Pagamento / faturamento'],
    ['fiscalizacao', 'Fiscalização contratual'],
    ['notificacao', 'Notificação ou comunicação formal']
  ];
  for (const [key, label] of themes) {
    if (normalized.includes(key)) return label;
  }

  const line = firstNonEmptyLine(raw);
  if (line) return cleanText(line).slice(0, 180);
  return `Novo ${tipo} identificado no processo`;
}

function summarizeDocumentText(text = '', movement = {}) {
  const raw = cleanText(text);
  if (!raw) return movement.resumo || `Novo documento/movimentação identificado pelo robô SEI: ${movement.documento || movement.tipo_documento || 'documento'}.`;
  const sentences = raw.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [raw];
  const summary = sentences.slice(0, 2).join(' ').trim();
  return summary.slice(0, 500);
}

async function readDocumentContent(_item, movement) {
  // Em ROBOT_MODE=simulation, criamos um conteúdo de teste para validar o alerta personalizado.
  // Em ROBOT_MODE=real, esta função deve ser ligada aos seletores do SEI após mapearmos a tela real do documento.
  if (MODE === 'simulation') {
    return `Assunto: Solicitação de manifestação sobre vigência contratual.\n\nDocumento simulado do setor ${movement.setor || 'GECONT'} referente ao processo. Trata de análise/encaminhamento relacionado ao contrato monitorado, com necessidade de verificação pela equipe gestora.`;
  }
  return movement.texto_documento || '';
}

async function enrichMovementWithDocumentText(item, movement) {
  const texto = await readDocumentContent(item, movement);
  const assunto = extractDocumentSubject(texto, movement);
  const resumoDoc = summarizeDocumentText(texto, movement);
  return {
    ...movement,
    texto_documento: texto ? String(texto).slice(0, 12000) : null,
    assunto_identificado: assunto,
    resumo_documento: resumoDoc,
    resumo: resumoDoc || movement.resumo
  };
}

function parseBRDate(value) {
  if (!value) return null;
  const s = String(value).trim();
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), 12, 0, 0);
  const iso = new Date(s);
  return Number.isNaN(iso.getTime()) ? null : iso;
}

function daysUntil(value) {
  const d = parseBRDate(value);
  if (!d) return null;
  const now = new Date();
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0);
  return Math.ceil((d.getTime() - base.getTime()) / 86400000);
}

function daysSince(value) {
  const d = parseBRDate(value);
  if (!d) return null;
  const now = new Date();
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0);
  return Math.floor((base.getTime() - d.getTime()) / 86400000);
}

function isRecentMovement(mov, maxDays) {
  const diff = daysSince(mov.data_movimentacao);
  if (diff === null) return false;
  return diff >= 0 && diff <= maxDays;
}

async function hasPreviousMovements(item) {
  let query = supabase.from('processo_movimentacoes').select('id').limit(1);
  if (item.origem === 'contrato') query = query.eq('contrato_id', item.id);
  else query = query.eq('processo_monitorado_id', item.id);
  const { data, error } = await query;
  if (error) throw error;
  return (data || []).length > 0;
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
      numero_contrato: c.numero_contrato,
      prestador: c.prestador,
      numero_processo: c.processo,
      assunto: `Contrato ${c.numero_contrato || 's/n'} - ${c.prestador || ''}`,
      setor_alerta: c.setor_alerta,
      tipo_documento_alerta: c.tipo_documento_alerta,
      gerar_alerta: c.gerar_alerta_sei !== false,
      gerar_demanda: c.gerar_demanda_sei !== false,
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
      gerar_demanda: p.gerar_demanda !== false,
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
      documento: `Despacho teste ${dateKey}`,
      resumo: `Movimentação simulada pelo robô para validar o processo ${item.numero_processo}.`,
      hash_movimentacao: `sim:${item.origem}:${item.id}:${dateKey}`
    }];
  }

  console.warn('ROBOT_MODE=real ainda exige mapeamento dos seletores do SEI. Nenhuma movimentação real foi coletada.');
  return [];
}

async function createDemandIfNeeded(item, movement, alerta) {
  if (!item.gerar_demanda || !item.contrato_id) return null;
  const titulo = `Verificar novo documento SEI - ${item.assunto}`.slice(0, 220);
  const active = ['Aberta', 'Em andamento', 'Aguardando resposta'];
  const { data: existing } = await supabase
    .from('demandas')
    .select('id')
    .eq('contrato_id', item.contrato_id)
    .eq('titulo', titulo)
    .in('status', active)
    .maybeSingle();
  if (existing?.id) return existing.id;

  const { data, error } = await supabase.from('demandas').insert({
    contrato_id: item.contrato_id,
    titulo,
    status: 'Aberta',
    prioridade: 'Alta',
    observacao: `Demanda automática gerada pelo robô SEI por novo documento/movimentação.\n\nProcesso: ${item.numero_processo}\nDocumento: ${movement.documento}\nTipo: ${movement.tipo_documento}\nSetor: ${movement.setor}\nData: ${movement.data_movimentacao}\nAssunto identificado: ${movement.assunto_identificado || alerta?.titulo || ''}\nResumo: ${movement.resumo_documento || movement.resumo || ''}\n\nVerificar o teor do documento e adotar as providências cabíveis.`
  }).select('id').single();
  if (error) throw error;
  return data.id;
}

async function generateExpiryDemands() {
  const { data: contratos, error } = await supabase
    .from('contratos')
    .select('*')
    .neq('situacao', 'Inativo');
  if (error) throw error;

  let created = 0;
  for (const c of contratos || []) {
    const dias = daysUntil(c.data_fim);
    if (dias === null || dias < 0 || dias > 15) continue;
    const titulo = `Acompanhar Vigência do Contrato ${c.numero_contrato || 's/n'} - ${c.prestador || 'Prestador não informado'}`;
    const { data: existing } = await supabase
      .from('demandas')
      .select('id')
      .eq('contrato_id', c.id)
      .eq('titulo', titulo)
      .in('status', ['Aberta', 'Em andamento', 'Aguardando resposta'])
      .maybeSingle();
    if (existing?.id) continue;
    const { error: dErr } = await supabase.from('demandas').insert({
      contrato_id: c.id,
      titulo,
      prazo: c.data_fim || '',
      status: 'Aberta',
      prioridade: 'Urgente',
      observacao: `Demanda automática criada pelo robô porque o contrato vence nos próximos 15 dias.\n\nContrato ${c.numero_contrato || 's/n'} - ${c.prestador || 'Prestador não informado'}\nFim da vigência: ${c.data_fim || '-'}\nDias restantes: ${dias}.\n\nVerificar necessidade de prorrogação, renovação, nova contratação ou encerramento.`
    });
    if (dErr) throw dErr;
    created++;
  }
  return created;
}

async function processItem(item) {
  const movements = await getMovementsFromSEI(item);
  let newMovements = 0;
  let alerts = 0;
  let demands = 0;
  const hadPrevious = await hasPreviousMovements(item);

  for (const baseMov of movements) {
    const mov = await enrichMovementWithDocumentText(item, baseMov);
    const recentForAlert = isRecentMovement(mov, ALERT_DOCUMENT_RECENCY_DAYS);
    const recentForDemand = isRecentMovement(mov, DEMAND_DOCUMENT_RECENCY_DAYS);
    const { error: movErr } = await supabase.from('processo_movimentacoes').insert({
      processo_monitorado_id: item.origem === 'avulso' ? item.id : null,
      contrato_id: item.contrato_id || null,
      numero_processo: item.numero_processo,
      ...mov
    });
    if (movErr && !String(movErr.message).toLowerCase().includes('duplicate')) throw movErr;
    if (!movErr) newMovements++;
    if (movErr) continue;

    // Regra de segurança: documento antigo não gera demanda e, se for muito antigo, nem alerta pendente.
    // Primeira leitura: salva a referência inicial; só alerta se for recente, mas não gera demanda.
    if (!item.gerar_alerta || !ruleMatches(mov, item) || !recentForAlert) continue;

    const source_hash = `alert:${mov.hash_movimentacao}`;
    const primeiraLeitura = !hadPrevious;
    const podeGerarDemanda = !!item.gerar_demanda && !primeiraLeitura && recentForDemand;
    const alertaPayload = {
      processo_monitorado_id: item.origem === 'avulso' ? item.id : null,
      contrato_id: item.contrato_id || null,
      numero_processo: item.numero_processo,
      titulo: mov.assunto_identificado ? `${mov.assunto_identificado} - ${item.numero_processo}` : `Novo documento no processo ${item.numero_processo}`,
      descricao: primeiraLeitura
        ? `Primeira leitura do processo. O documento foi registrado como referência inicial. ${mov.resumo_documento || mov.resumo || ''}`
        : (mov.resumo_documento || mov.resumo || `Documento ${mov.documento} identificado pelo robô SEI.`),
      assunto_identificado: mov.assunto_identificado || null,
      resumo_documento: mov.resumo_documento || null,
      texto_documento: mov.texto_documento || null,
      setor: mov.setor,
      tipo_documento: mov.tipo_documento,
      documento: mov.documento,
      data_movimentacao: mov.data_movimentacao,
      source_hash,
      status: 'Pendente',
      gerar_demanda: podeGerarDemanda
    };
    const { data: inserted, error: alertErr } = await supabase
      .from('processo_alertas')
      .insert(alertaPayload)
      .select('*')
      .single();
    if (alertErr && !String(alertErr.message).toLowerCase().includes('duplicate')) throw alertErr;
    if (!alertErr) {
      alerts++;
      if (podeGerarDemanda) {
        const demandaId = await createDemandIfNeeded(item, mov, inserted);
        if (demandaId) {
          demands++;
          await supabase.from('processo_alertas').update({ demanda_id: demandaId }).eq('id', inserted.id);
        }
      }
    }
  }

  const update = item.origem === 'contrato'
    ? supabase.from('contratos').update({ ultimo_monitoramento_sei: nowBR(), ultima_movimentacao_sei: movements[0]?.data_movimentacao || null }).eq('id', item.id)
    : supabase.from('processos_monitorados').update({ ultimo_monitoramento: nowBR(), ultima_movimentacao: movements[0]?.data_movimentacao || null }).eq('id', item.id);
  const { error: updateErr } = await update;
  if (updateErr) throw updateErr;
  return { item: item.assunto, newMovements, alerts, demands };
}

export async function runRobot() {
  if (running) return { status: 'already-running' };
  running = true;
  const startedAt = new Date().toISOString();
  try {
    const expiryDemands = await generateExpiryDemands();
    const items = await fetchMonitoredItems();
    const results = [];
    for (const item of items) results.push(await processItem(item));
    lastResult = { startedAt, finishedAt: new Date().toISOString(), mode: MODE, demandDocumentRecencyDays: DEMAND_DOCUMENT_RECENCY_DAYS, alertDocumentRecencyDays: ALERT_DOCUMENT_RECENCY_DAYS, expiryDemands, monitored: items.length, results };
    console.log(JSON.stringify(lastResult, null, 2));
    return lastResult;
  } finally {
    running = false;
  }
}

const app = express();
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-robot-token');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

function checkTriggerToken(req, res) {
  const requiredToken = process.env.ROBOT_TRIGGER_TOKEN || '';
  if (!requiredToken) return true;
  const token = req.headers['x-robot-token'] || req.query.token || '';
  if (String(token) === String(requiredToken)) return true;
  res.status(401).json({ error: 'Token do robô inválido ou ausente.' });
  return false;
}

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'Robô SEI NIAR',
    mode: MODE,
    running,
    endpoints: ['GET /health', 'GET /run', 'POST /run', 'GET /trigger', 'POST /trigger'],
    lastResult
  });
});

app.get('/health', (_req, res) => res.json({ ok: true, mode: MODE, running, lastResult }));

async function handleManualRun(req, res) {
  if (!checkTriggerToken(req, res)) return;
  try { res.json(await runRobot()); }
  catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
}

// Rota usada pelo site v10
app.post('/run', handleManualRun);
app.get('/run', handleManualRun);

// Rota alternativa para teste manual no navegador
app.post('/trigger', handleManualRun);
app.get('/trigger', handleManualRun);

if (process.argv.includes('--once')) {
  runRobot().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
} else {
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => console.log(`Robô SEI NIAR rodando na porta ${port}. Modo: ${MODE}`));
  setInterval(() => runRobot().catch(err => console.error(err)), Math.max(5, INTERVAL_MINUTES) * 60 * 1000);
  setTimeout(() => runRobot().catch(err => console.error(err)), 5000);
}
