
import express from 'express';
import WebSocket from 'ws';
import { createClient } from '@supabase/supabase-js';

const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Variável obrigatória ausente: ${key}`);
    process.exit(1);
  }
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  realtime: { transport: WebSocket }
});

const MODE = process.env.ROBOT_MODE || 'simulation';
const INTERVAL_MINUTES = Number(process.env.RUN_INTERVAL_MINUTES || process.env.CHECK_INTERVAL_MINUTES || 60);
const DEMAND_DOCUMENT_RECENCY_DAYS = Number(process.env.DEMAND_DOCUMENT_RECENCY_DAYS || 3);
const ALERT_DOCUMENT_RECENCY_DAYS = Number(process.env.ALERT_DOCUMENT_RECENCY_DAYS || 7);
const SEI_TIMEOUT_MS = Number(process.env.SEI_TIMEOUT_MS || 45000);
const SEI_MAX_DOCUMENTS = Number(process.env.SEI_MAX_DOCUMENTS || 40);
const SEI_READ_LAST_DOCUMENTS = Number(process.env.SEI_READ_LAST_DOCUMENTS || 1);
const SEI_HEADLESS = String(process.env.SEI_HEADLESS || 'true').toLowerCase() !== 'false';
const SEI_DEBUG = String(process.env.SEI_DEBUG || 'false').toLowerCase() === 'true';
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
  return String(text).replace(/\s+/g, ' ').replace(/ /g, ' ').trim();
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
    if (match?.[1]) return cleanText(match[1]).slice(0, 220);
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
    ['notificacao', 'Notificação ou comunicação formal'],
    ['oficio', 'Ofício / comunicação externa'],
    ['informacao', 'Informação técnica / resposta administrativa']
  ];
  for (const [key, label] of themes) if (normalized.includes(key)) return label;

  const line = firstNonEmptyLine(raw);
  if (line) return cleanText(line).slice(0, 220);
  return `Novo ${tipo} identificado no processo`;
}

function summarizeDocumentText(text = '', movement = {}) {
  const raw = cleanText(text);
  if (!raw) return movement.resumo || `Novo documento/movimentação identificado pelo robô SEI: ${movement.documento || movement.tipo_documento || 'documento'}.`;

  const assuntoMatch = raw.match(/assunto\s*[:\-]\s*([^\n\.]+[\.]?)/i);
  const interessadoMatch = raw.match(/(ao senhor|a senhora|interessad[oa]|empresa|contratada)\s*[:\-]?\s*([^\n\.]{10,180})/i);
  const firstSentences = raw.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [raw];
  const parts = [];
  if (assuntoMatch?.[0]) parts.push(cleanText(assuntoMatch[0]));
  if (interessadoMatch?.[0]) parts.push(cleanText(interessadoMatch[0]));
  parts.push(...firstSentences.slice(0, 2).map(cleanText));
  return [...new Set(parts)].join(' ').slice(0, 700);
}

function parseDocumentName(text = '') {
  const t = cleanText(text);
  const m = t.match(/^(.+?)\s*\((\d+)\)/);
  if (m) return { documento: cleanText(m[1]), id_sei: m[2] };
  return { documento: t, id_sei: null };
}

function inferDocumentType(name = '') {
  const n = normalize(name);
  const known = ['Despacho', 'Informação', 'Ofício', 'Memorando', 'Parecer', 'Anexo', 'Termo Aditivo', 'Nota Técnica', 'Contrato', 'Termo de Referência', 'Portaria'];
  for (const k of known) if (n.includes(normalize(k))) return k;
  const first = cleanText(name).split(' ')[0] || 'Documento';
  return first;
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
  const { data: contratos, error: cErr } = await supabase.from('contratos').select('*').eq('monitorar_sei', true);
  if (cErr) throw cErr;

  const { data: avulsos, error: pErr } = await supabase.from('processos_monitorados').select('*').eq('monitoramento_ativo', true);
  if (pErr) throw pErr;

  return [
    ...(contratos || []).map(c => ({
      origem: 'contrato', id: c.id, contrato_id: c.id,
      numero_contrato: c.numero_contrato, prestador: c.prestador,
      numero_processo: c.processo, assunto: `Contrato ${c.numero_contrato || 's/n'} - ${c.prestador || ''}`,
      setor_alerta: c.setor_alerta, tipo_documento_alerta: c.tipo_documento_alerta,
      gerar_alerta: c.gerar_alerta_sei !== false, gerar_demanda: c.gerar_demanda_sei !== false, raw: c
    })),
    ...(avulsos || []).map(p => ({
      origem: 'avulso', id: p.id, processo_monitorado_id: p.id, contrato_id: p.contrato_id || null,
      numero_processo: p.numero_processo, assunto: p.assunto,
      setor_interesse: p.setor_interesse, tipo_documento_interesse: p.tipo_documento_interesse,
      gerar_alerta: p.gerar_alerta !== false, gerar_demanda: p.gerar_demanda !== false, raw: p
    }))
  ].filter(x => x.numero_processo);
}

async function fillFirstVisible(pageOrFrame, selectors, value) {
  for (const sel of selectors) {
    try {
      const loc = pageOrFrame.locator(sel).first();
      if (await loc.count() && await loc.isVisible({ timeout: 1500 }).catch(() => false)) {
        await loc.fill(String(value));
        return sel;
      }
    } catch {}
  }
  throw new Error(`Não localizei campo para preencher. Seletores testados: ${selectors.join(', ')}`);
}

async function clickFirstVisible(pageOrFrame, selectors) {
  for (const sel of selectors) {
    try {
      const loc = pageOrFrame.locator(sel).first();
      if (await loc.count() && await loc.isVisible({ timeout: 1500 }).catch(() => false)) {
        await loc.click();
        return sel;
      }
    } catch {}
  }
  throw new Error(`Não localizei botão/link. Seletores testados: ${selectors.join(', ')}`);
}

async function selectUnidade(page, unidade) {
  if (!unidade) return;
  const candidates = ['select', 'select[name*=Unidade]', '#selInfraUnidades', '#selOrgao', '[name*=Unidade]'];
  for (const sel of candidates) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count() && await loc.isVisible({ timeout: 2000 }).catch(() => false)) {
        // Se for select, tenta por label e por value aproximado
        try { await loc.selectOption({ label: unidade }); return; } catch {}
        try { await loc.selectOption(unidade); return; } catch {}
        try {
          await loc.click();
          await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
          await page.keyboard.type(unidade);
          await page.keyboard.press('Enter');
          return;
        } catch {}
      }
    } catch {}
  }
}

async function loginSEI(page) {
  if (!process.env.SEI_URL || !process.env.SEI_USER || !process.env.SEI_PASSWORD) {
    throw new Error('Para ROBOT_MODE=sei, preencha SEI_URL, SEI_USER e SEI_PASSWORD no Render.');
  }

  console.log('[SEI] Abrindo login...');
  await page.goto(process.env.SEI_URL, { waitUntil: 'domcontentloaded', timeout: SEI_TIMEOUT_MS });

  await fillFirstVisible(page, [
    'input[name="txtUsuario"]', '#txtUsuario', 'input[id*=Usuario]', 'input[name*=Usuario]',
    'input[type="text"]', 'input:not([type])'
  ], process.env.SEI_USER);

  await fillFirstVisible(page, [
    'input[name="pwdSenha"]', '#pwdSenha', 'input[id*=Senha]', 'input[name*=Senha]', 'input[type="password"]'
  ], process.env.SEI_PASSWORD);

  await selectUnidade(page, process.env.SEI_UNIDADE || '');

  await clickFirstVisible(page, [
    'button:has-text("ACESSAR")', 'input[value="ACESSAR"]', 'button:has-text("Acessar")',
    'input[type="submit"]', 'button[type="submit"]', 'text=ACESSAR'
  ]);

  await page.waitForLoadState('domcontentloaded', { timeout: SEI_TIMEOUT_MS }).catch(() => {});
  await page.waitForTimeout(2500);
  const body = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  if (normalize(body).includes('captcha') || normalize(body).includes('senha invalida') || normalize(body).includes('usuario ou senha')) {
    throw new Error('Falha no login do SEI. Robô parou para evitar novas tentativas/captcha.');
  }
  console.log('[SEI] Login finalizado ou sessão já autenticada.');
}

function allFrames(page) {
  return page.frames();
}

async function findFrameContaining(page, text) {
  const wanted = normalize(text);
  for (const frame of allFrames(page)) {
    try {
      const body = await frame.locator('body').innerText({ timeout: 2000 });
      if (normalize(body).includes(wanted)) return frame;
    } catch {}
  }
  return page.mainFrame();
}

async function searchProcess(page, numeroProcesso) {
  console.log(`[SEI] Pesquisando processo ${numeroProcesso}...`);
  const frames = allFrames(page);
  let filled = false;
  for (const frame of frames) {
    try {
      const selectors = [
        'input[placeholder*="Pesquisar"]', 'input[title*="Pesquisar"]', '#txtPesquisaRapida',
        'input[name*=Pesquisa]', 'input[type="search"]'
      ];
      for (const sel of selectors) {
        const loc = frame.locator(sel).first();
        if (await loc.count() && await loc.isVisible({ timeout: 800 }).catch(() => false)) {
          await loc.fill(numeroProcesso);
          await loc.press('Enter');
          filled = true;
          break;
        }
      }
      if (filled) break;
    } catch {}
  }
  if (!filled) throw new Error('Não localizei o campo de pesquisa superior do SEI.');

  await page.waitForLoadState('domcontentloaded', { timeout: SEI_TIMEOUT_MS }).catch(() => {});
  await page.waitForTimeout(3000);

  // Se aparecer o número do processo em resultado/tela, tenta clicar nele.
  for (const frame of allFrames(page)) {
    try {
      const loc = frame.getByText(numeroProcesso, { exact: false }).first();
      if (await loc.count() && await loc.isVisible({ timeout: 1000 }).catch(() => false)) {
        await loc.click().catch(() => {});
        await page.waitForTimeout(2500);
        break;
      }
    } catch {}
  }
}

async function collectDocumentCandidates(page) {
  const keywords = /(Informação|Informacao|Despacho|Ofício|Oficio|Memorando|Parecer|Anexo|Contrato|Termo|Nota Técnica|Nota Tecnica|Portaria)/i;
  const candidates = [];
  for (const frame of allFrames(page)) {
    try {
      const found = await frame.locator('a, span, div, td').evaluateAll((els) => {
        const isVisible = (el) => {
          const s = window.getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return s && s.visibility !== 'hidden' && s.display !== 'none' && r.width > 0 && r.height > 0;
        };
        return els.map((el, idx) => ({ idx, text: (el.innerText || el.textContent || '').trim() }))
          .filter(x => x.text && x.text.length < 220)
          .filter((x, i, arr) => arr.findIndex(y => y.text === x.text) === i)
          .filter(x => /Informação|Informacao|Despacho|Ofício|Oficio|Memorando|Parecer|Anexo|Contrato|Termo|Nota Técnica|Nota Tecnica|Portaria/i.test(x.text));
      });
      for (const f of found) candidates.push({ frame, text: f.text });
    } catch {}
  }

  // Ordena na ordem encontrada, remove duplicados exatos e limita aos últimos documentos.
  const unique = [];
  const seen = new Set();
  for (const c of candidates) {
    const key = cleanText(c.text);
    if (!seen.has(key)) { seen.add(key); unique.push(c); }
  }
  return unique.slice(-Math.max(1, SEI_MAX_DOCUMENTS));
}

async function clickDocumentAndRead(page, candidate) {
  const label = candidate.text;
  const frame = candidate.frame;
  console.log(`[SEI] Abrindo documento: ${label}`);
  const locs = [
    frame.getByText(label, { exact: true }).first(),
    frame.getByText(label, { exact: false }).first(),
    frame.locator(`text=${label}`).first()
  ];
  let clicked = false;
  for (const loc of locs) {
    try {
      if (await loc.count() && await loc.isVisible({ timeout: 1000 }).catch(() => false)) {
        await loc.click({ timeout: 5000 }); clicked = true; break;
      }
    } catch {}
  }
  if (!clicked) return { texto: '', erroLeitura: 'Não foi possível clicar no documento.' };

  await page.waitForTimeout(3000);
  // O documento costuma abrir no painel/iframe direito. Pegamos o frame com mais texto útil.
  let best = '';
  for (const f of allFrames(page)) {
    try {
      const txt = await f.locator('body').innerText({ timeout: 2000 });
      const cleaned = cleanText(txt);
      if (cleaned.length > best.length && !normalize(cleaned).includes('controle de processos')) best = cleaned;
    } catch {}
  }
  if (!best) best = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  return { texto: String(best || '').slice(0, 30000), erroLeitura: best ? null : 'Documento aberto, mas texto não foi encontrado.' };
}

async function getMovementsFromSEIReal(item) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({
    headless: SEI_HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  page.setDefaultTimeout(SEI_TIMEOUT_MS);

  try {
    await loginSEI(page);
    await searchProcess(page, item.numero_processo);

    const candidates = await collectDocumentCandidates(page);
    console.log(`[SEI] Documentos candidatos encontrados: ${candidates.length}`);
    if (!candidates.length) return [];

    const selected = candidates.slice(-Math.max(1, SEI_READ_LAST_DOCUMENTS));
    const movements = [];
    for (const cand of selected) {
      const { documento, id_sei } = parseDocumentName(cand.text);
      const tipo_documento = inferDocumentType(documento);
      const read = await clickDocumentAndRead(page, cand);
      const texto = read.texto || '';
      const setorMatch = cand.text.match(/SESAU-[A-Z0-9\-]+|GECONT|GPACC|CREG|PGE|CAD|CGAPP/i) || texto.match(/SESAU-[A-Z0-9\-]+|GECONT|GPACC|CREG|PGE|CAD|CGAPP/i);
      const setor = setorMatch?.[0] || item.setor_interesse || item.setor_alerta || 'SEI';
      const hoje = nowBR();
      const hash = `sei:${item.numero_processo}:${id_sei || documento}`;
      movements.push({
        data_movimentacao: hoje,
        setor,
        tipo_documento,
        documento,
        id_sei,
        texto_documento: texto,
        resumo: read.erroLeitura ? `Movimentação identificada, mas o conteúdo não pôde ser lido: ${read.erroLeitura}` : `Documento ${documento} identificado pelo robô SEI.`,
        hash_movimentacao: hash
      });
    }
    return movements;
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
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
      texto_documento: `Assunto: Solicitação de manifestação sobre vigência contratual.\n\nDocumento simulado do setor ${item.setor_interesse || item.setor_alerta || 'GECONT'} referente ao processo. Trata de análise/encaminhamento relacionado ao contrato monitorado, com necessidade de verificação pela equipe gestora.`,
      hash_movimentacao: `sim:${item.origem}:${item.id}:${dateKey}`
    }];
  }

  if (MODE === 'sei') return await getMovementsFromSEIReal(item);

  console.warn(`ROBOT_MODE=${MODE} não reconhecido. Use simulation ou sei.`);
  return [];
}

async function readDocumentContent(_item, movement) {
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

async function createDemandIfNeeded(item, movement, alerta) {
  if (!item.gerar_demanda || !item.contrato_id) return null;
  const titulo = `Verificar novo documento SEI - ${item.assunto}`.slice(0, 220);
  const active = ['Aberta', 'Em andamento', 'Aguardando resposta'];
  const { data: existing } = await supabase.from('demandas').select('id').eq('contrato_id', item.contrato_id).eq('titulo', titulo).in('status', active).maybeSingle();
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
  const { data: contratos, error } = await supabase.from('contratos').select('*').neq('situacao', 'Inativo');
  if (error) throw error;

  let created = 0;
  for (const c of contratos || []) {
    const dias = daysUntil(c.data_fim);
    if (dias === null || dias < 0 || dias > 15) continue;
    const titulo = `Acompanhar Vigência do Contrato ${c.numero_contrato || 's/n'} - ${c.prestador || 'Prestador não informado'}`;
    const { data: existing } = await supabase.from('demandas').select('id').eq('contrato_id', c.id).eq('titulo', titulo).in('status', ['Aberta', 'Em andamento', 'Aguardando resposta']).maybeSingle();
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
  let newMovements = 0, alerts = 0, demands = 0;
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
    const { data: inserted, error: alertErr } = await supabase.from('processo_alertas').insert(alertaPayload).select('*').single();
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
  return { item: item.assunto, processo: item.numero_processo, movementsFound: movements.length, newMovements, alerts, demands };
}

export async function runRobot() {
  if (running) return { status: 'already-running' };
  running = true;
  const startedAt = new Date().toISOString();
  try {
    const expiryDemands = await generateExpiryDemands();
    const items = await fetchMonitoredItems();
    const results = [];
    for (const item of items) {
      try { results.push(await processItem(item)); }
      catch (err) { console.error(`[ERRO item ${item.numero_processo}]`, err); results.push({ item: item.assunto, processo: item.numero_processo, error: err.message }); }
    }
    lastResult = { startedAt, finishedAt: new Date().toISOString(), mode: MODE, demandDocumentRecencyDays: DEMAND_DOCUMENT_RECENCY_DAYS, alertDocumentRecencyDays: ALERT_DOCUMENT_RECENCY_DAYS, expiryDemands, monitored: items.length, results };
    console.log(JSON.stringify(lastResult, null, 2));
    return lastResult;
  } finally { running = false; }
}

const app = express();
app.use(express.json({ limit: '1mb' }));
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
  const token = req.headers['x-robot-token'] || req.query.token || req.body?.token || '';
  if (String(token) === String(requiredToken)) return true;
  res.status(401).json({ error: 'Token do robô inválido ou ausente.' });
  return false;
}

app.get('/', (_req, res) => res.json({ ok: true, service: 'Robô SEI NIAR', version: '11.0.0', mode: MODE, running, endpoints: ['GET /health', 'GET /run', 'POST /run', 'GET /trigger', 'POST /trigger'], lastResult }));
app.get('/health', (_req, res) => res.json({ ok: true, version: '11.0.0', mode: MODE, running, lastResult }));

async function handleManualRun(req, res) {
  if (!checkTriggerToken(req, res)) return;
  try { res.json(await runRobot()); }
  catch (err) { console.error(err); res.status(500).json({ error: err.message, stack: SEI_DEBUG ? err.stack : undefined }); }
}

app.post('/run', handleManualRun);
app.get('/run', handleManualRun);
app.post('/trigger', handleManualRun);
app.get('/trigger', handleManualRun);

if (process.argv.includes('--once')) {
  runRobot().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
} else {
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => console.log(`Robô SEI NIAR rodando na porta ${port}. Modo: ${MODE}. Versão 11.0.0`));
  setInterval(() => runRobot().catch(err => console.error(err)), Math.max(5, INTERVAL_MINUTES) * 60 * 1000);
  setTimeout(() => runRobot().catch(err => console.error(err)), 5000);
}
