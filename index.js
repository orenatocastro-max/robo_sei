
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
const VERSION = '14.0.0';
const ROBOT_BATCH_SIZE = Number(process.env.ROBOT_BATCH_SIZE || 5);
const ROBOT_TIME_BUDGET_MINUTES = Number(process.env.ROBOT_TIME_BUDGET_MINUTES || 10);
const ROBOT_SELF_RESUME_DELAY_SECONDS = Number(process.env.ROBOT_SELF_RESUME_DELAY_SECONDS || 30);
const ROBOT_EXECUTION_STALE_MINUTES = Number(process.env.ROBOT_EXECUTION_STALE_MINUTES || 30);
let running = false;
let runningStartedAt = null;
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


function looksLikeProcessTreeText(text = '') {
  const raw = String(text || '');
  const clean = cleanText(raw);
  const n = normalize(clean);
  const romanSeq = /\bI\s+II\s+III\s+IV\s+V\b/.test(clean);
  const manyDocNames = (clean.match(/\b(Despacho|Informação|Ofício|Memorando|Parecer|Anexo|Certidão|Consulta|Comunicação|Contrato)\b/gi) || []).length >= 8;
  const manyIds = (clean.match(/\(\d{6,}\)/g) || []).length >= 8;
  const hasTreeTerms = n.includes('controle de processos') || n.includes('processos recebidos') || n.includes('processos gerados') || n.includes('acompanhamento especial');
  const lacksDocumentHeader = !/(governo do estado|secretaria|núcleo|nucleo|assunto\s*:|refer[êe]ncia\s*:|ao senhor|senhor\(a\)|despacho|informa[cç][aã]o\s*n[ºo])/i.test(clean);
  return hasTreeTerms || romanSeq || (manyDocNames && manyIds && lacksDocumentHeader);
}

function formatDocumentRef(movement = {}) {
  const tipo = movement.tipo_documento || 'Documento';
  const id = movement.id_sei || (String(movement.documento || '').match(/\((\d{5,})\)/) || [])[1] || '';
  return `${tipo}${id ? ` (${id})` : ''}`;
}

function safeFallbackSubject(movement = {}) {
  return `Novo ${formatDocumentRef(movement)} inserido no processo`;
}

function safeFallbackSummary(movement = {}) {
  if (movement.erro_leitura) return `Movimentação nova identificada no processo monitorado, porém o conteúdo do documento não pôde ser lido/confirmado automaticamente. Motivo: ${movement.erro_leitura}`;
  return `Movimentação nova identificada no processo monitorado. Verifique o teor do documento no SEI para confirmar as providências necessárias.`;
}

function extractDocumentSubject(text = '', movement = {}) {
  const raw = String(text || '').trim();
  if (!raw || looksLikeProcessTreeText(raw) || movement.leitura_confirmada === false) return safeFallbackSubject(movement);

  // Só considera assunto específico quando há padrão explícito no documento.
  const explicitPatterns = [
    /^\s*assunto\s*[:\-]\s*(.+)$/im,
    /^\s*ementa\s*[:\-]\s*(.+)$/im,
    /^\s*refer[êe]ncia\s*[:\-]\s*(.+)$/im,
    /^\s*objeto\s*[:\-]\s*(.+)$/im
  ];
  for (const pattern of explicitPatterns) {
    const match = raw.match(pattern);
    if (match?.[1]) return cleanText(match[1]).slice(0, 220);
  }

  const normalized = normalize(raw);
  const themes = [
    ['termo aditivo', 'Termo aditivo / alteração contratual'],
    ['apostilamento', 'Apostilamento contratual'],
    ['prorrogacao', 'Prorrogação de vigência contratual'],
    ['reequilibrio', 'Reequilíbrio econômico-financeiro'],
    ['errata', 'Errata / correção documental'],
    ['nota tecnica', 'Nota técnica / análise técnica'],
    ['pagamento', 'Pagamento / faturamento'],
    ['fiscalizacao', 'Fiscalização contratual'],
    ['notificacao', 'Notificação ou comunicação formal'],
    ['oficio', 'Ofício / comunicação externa']
  ];
  for (const [key, label] of themes) if (normalized.includes(key)) return label;
  return safeFallbackSubject(movement);
}

function summarizeDocumentText(text = '', movement = {}) {
  const raw = cleanText(text);
  if (!raw || looksLikeProcessTreeText(raw) || movement.leitura_confirmada === false) return safeFallbackSummary(movement);

  const assuntoMatch = raw.match(/^\s*assunto\s*[:\-]\s*(.+)$/im);
  const referenciaMatch = raw.match(/^\s*refer[êe]ncia\s*[:\-]\s*(.+)$/im);
  const interessadoMatch = raw.match(/^(?:ao senhor|a senhora|interessad[oa]|empresa|contratada)\s*[:\-]?\s*(.+)$/im);
  const firstSentences = raw.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [raw];
  const parts = [];
  if (assuntoMatch?.[0]) parts.push(cleanText(assuntoMatch[0]));
  if (referenciaMatch?.[0]) parts.push(cleanText(referenciaMatch[0]));
  if (interessadoMatch?.[0]) parts.push(cleanText(interessadoMatch[0]));
  parts.push(...firstSentences.slice(0, 2).map(cleanText).filter(x => x.length > 20));
  return [...new Set(parts)].join(' ').slice(0, 700) || safeFallbackSummary(movement);
}

function parseDocumentName(text = '') {
  const t = cleanText(text);
  const m = t.match(/^(.+?)\s*\((\d+)\)/);
  if (m) return { documento: cleanText(m[1]), id_sei: m[2] };
  return { documento: t, id_sei: null };
}

function inferDocumentType(name = '') {
  const clean = cleanText(name);
  const n = normalize(clean);
  // Evita classificar setor/unidade como "Contrato" apenas porque aparece "Gerência de Contratos".
  if (/^SESAU-|GER[ÊE]NCIA|N[ÚU]CLEO|COORDENADORIA|UNIDADE/i.test(clean) && !/\(\d{5,}\)/.test(clean)) return 'Documento';

  const patterns = [
    ['Termo Aditivo', /^Termo\s+Aditivo\b/i],
    ['Nota Técnica', /^Nota\s+T[ée]cnica\b/i],
    ['Termo de Referência', /^Termo\s+de\s+Refer[êe]ncia\b/i],
    ['Informação', /^Informa[cç][aã]o\b/i],
    ['Despacho', /^Despacho\b/i],
    ['Ofício', /^Of[íi]cio\b/i],
    ['Memorando', /^Memorando\b/i],
    ['Parecer', /^Parecer\b/i],
    ['Anexo', /^Anexo\b/i],
    ['Portaria', /^Portaria\b/i],
    ['Certidão', /^Certid[ãa]o\b/i],
    ['Consulta', /^Consulta\b/i],
    ['Comunicação', /^Comunica[cç][aã]o\b/i],
    ['Contrato', /^Contrato\b/i]
  ];
  for (const [label, pattern] of patterns) if (pattern.test(clean)) return label;

  // Anexo Contrato (id) continua sendo Anexo, não Contrato.
  const first = clean.split(/\s+/)[0] || 'Documento';
  return first.length > 30 ? 'Documento' : first;
}

function isValidDocumentLabel(text = '') {
  const t = cleanText(text);
  if (!t || t.length > 180) return false;
  // Documento SEI normalmente tem tipo documental + ID entre parênteses.
  const hasId = /\(\d{5,}\)/.test(t);
  const startsDocType = /^(Informação|Informacao|Despacho|Ofício|Oficio|Memorando|Parecer|Anexo|Contrato|Termo\s+Aditivo|Termo\s+de\s+Referência|Termo\s+de\s+Referencia|Nota\s+Técnica|Nota\s+Tecnica|Portaria|Certidão|Certidao|Consulta|Comunicação|Comunicacao)\b/i.test(t);
  if (!hasId || !startsDocType) return false;
  // Evita unidade/setor como “SESAU-GECONT - GERÊNCIA DE CONTRATOS”.
  if (/^SESAU-|GER[ÊE]NCIA|N[ÚU]CLEO|COORDENADORIA|CONTROLE DE PROCESSOS/i.test(t)) return false;
  return true;
}

function parseBRDate(value) {
  if (!value) return null;
  const s = String(value).trim();

  // Aceita: 27/06/2026, 27/06/2026 10:30, 27/06/2026, 10:30:22
  const br = s.match(/(\d{2})\/(\d{2})\/(\d{4})(?:[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (br) {
    return new Date(
      Number(br[3]),
      Number(br[2]) - 1,
      Number(br[1]),
      Number(br[4] || 12),
      Number(br[5] || 0),
      Number(br[6] || 0)
    );
  }

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

function splitRuleList(value = '') {
  return String(value || '')
    .split(/[,;|\n]+/)
    .map(v => normalize(v).trim())
    .filter(Boolean);
}

function anyRuleMatches(value, rules) {
  if (!rules.length) return true;
  const v = normalize(value || '');
  return rules.some(r => v.includes(r) || r.includes(v));
}

function extractSectorFromContext(text = '') {
  const raw = cleanText(text || '');
  const patterns = [
    /(SESAU-[A-Z0-9-]{2,})/i,
    /(HB-[A-Z0-9-]{2,})/i,
    /(GECONT|GPACC|CREG|PGE|CAD|CGAPP|NIARCREG|NIAR)/i
  ];
  for (const pattern of patterns) {
    const m = raw.match(pattern);
    if (m?.[1]) return String(m[1]).toUpperCase();
  }
  return null;
}

function sectorForRule(mov = {}) {
  // Regra definida pelo usuário deve bater com o setor/usuário que GEROU o documento na árvore do SEI,
  // não com unidades citadas dentro do texto do documento ou destinatários.
  return mov.setor_gerador || mov.setor_origem || mov.setor || '';
}

function ruleMatches(mov, rule) {
  const setores = splitRuleList(rule.setor_interesse || rule.setor_alerta || '');
  const tipos = splitRuleList(rule.tipo_documento_interesse || rule.tipo_documento_alerta || '');

  const setorOk = anyRuleMatches(sectorForRule(mov), setores);
  const tipoBase = `${mov.tipo_documento || ''} ${mov.documento || ''}`;
  const tipoOk = anyRuleMatches(tipoBase, tipos);

  return setorOk && tipoOk;
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
  const contexts = typeof pageOrFrame.frames === 'function' ? [pageOrFrame, ...pageOrFrame.frames()] : [pageOrFrame];

  // 1) Seletores normais em página principal e frames.
  for (const ctx of contexts) {
    for (const sel of selectors) {
      try {
        const loc = ctx.locator(sel).first();
        if (await loc.count() && await loc.isVisible({ timeout: 1500 }).catch(() => false)) {
          await loc.fill(String(value));
          return `selector:${sel}`;
        }
      } catch {}
    }
  }

  // 2) Fallback: localizar input visível por heurística no DOM/frame.
  // Isso cobre telas do SEI em que o campo não expõe id/name previsível.
  for (const ctx of contexts) {
    try {
      const handle = await ctx.evaluateHandle((wantedSelectors) => {
        const norm = (v) => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim();
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          const st = window.getComputedStyle(el);
          return r.width > 30 && r.height > 15 && st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity || 1) !== 0;
        };
        const inputs = Array.from(document.querySelectorAll('input, textarea'))
          .filter(visible)
          .filter(el => !['hidden','button','submit','checkbox','radio','file'].includes(String(el.type || '').toLowerCase()));

        const joined = wantedSelectors.join(' ').toUpperCase();
        const isPasswordWanted = joined.includes('SENHA') || joined.includes('PASSWORD') || joined.includes('PWD');
        if (isPasswordWanted) {
          return inputs.find(el => String(el.type || '').toLowerCase() === 'password') || inputs[1] || null;
        }

        // Usuário/CPF costuma ser o primeiro input de texto visível antes da senha.
        const scored = inputs.map((el, idx) => {
          const r = el.getBoundingClientRect();
          const label = norm([el.id, el.name, el.placeholder, el.title, el.autocomplete, el.getAttribute('aria-label'), el.className].filter(Boolean).join(' '));
          let score = 0;
          if (label.includes('USUARIO') || label.includes('LOGIN') || label.includes('CPF') || label.includes('MATRICULA')) score += 50;
          if (['text','tel','number','email',''].includes(String(el.type || '').toLowerCase())) score += 10;
          score += Math.max(0, 10 - idx);
          score -= r.y / 10000;
          return { el, score };
        }).sort((a,b) => b.score - a.score);
        return scored[0]?.el || inputs[0] || null;
      }, selectors);
      const element = handle.asElement();
      if (element) {
        await element.fill(String(value)).catch(async () => {
          await element.click({ force: true });
          await element.evaluate((el, val) => {
            el.value = val;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }, String(value));
        });
        return 'fallback-visible-input-heuristic';
      }
    } catch {}
  }

  // 3) Diagnóstico sem imprimir valores digitados.
  try {
    const page = typeof pageOrFrame.frames === 'function' ? pageOrFrame : null;
    if (page) {
      for (const [i, frame] of page.frames().entries()) {
        const diag = await frame.evaluate(() => Array.from(document.querySelectorAll('input, textarea, select, button'))
          .map((el) => {
            const r = el.getBoundingClientRect();
            return `${el.tagName} id=${el.id||''} name=${el.name||''} type=${el.type||''} placeholder=${el.placeholder||''} title=${el.title||''} text=${(el.innerText||el.textContent||'').trim()} x=${Math.round(r.x)} y=${Math.round(r.y)} w=${Math.round(r.width)} h=${Math.round(r.height)}`;
          }).slice(0, 50).join('\n')).catch(() => '');
        if (diag) console.log(`[SEI][DEBUG CAMPOS FRAME ${i}]\n${diag}`);
      }
    }
  } catch {}

  throw new Error(`Não localizei campo para preencher. Seletores testados: ${selectors.join(', ')}`);
}

async function clickFirstVisible(pageOrFrame, selectors) {
  for (const sel of selectors) {
    try {
      const loc = pageOrFrame.locator(sel).first();
      if (await loc.count() && await loc.isVisible({ timeout: 1500 }).catch(() => false)) {
        await loc.click({ timeout: 5000 });
        return sel;
      }
    } catch {}
  }
  throw new Error(`Não localizei botão/link. Seletores testados: ${selectors.join(', ')}`);
}

async function clickLoginAcessar(page) {
  const selectors = [
    'input[value="ACESSAR"]',
    'input[value*="ACESS"]',
    'input[type="button"][value*="ACESS"]',
    'input[type="submit"][value*="ACESS"]',
    'button:has-text("ACESSAR")',
    'button:has-text("Acessar")',
    'a:has-text("ACESSAR")',
    'a:has-text("Acessar")',
    '[role="button"]:has-text("ACESSAR")',
    '[role="button"]:has-text("Acessar")',
    '#btnAcessar', '#btnLogin', '#sbmLogin', '#btnEnviar', '#btnEntrar',
    '.btn-primary', '.btn', '[onclick*="login" i]', '[onclick*="acess" i]', '[onclick*="entrar" i]',
    'input[name*=Acess]', 'input[id*=Acess]',
    'input[name*=Login]', 'input[id*=Login]',
    'input[type="submit"]', 'button[type="submit"]',
    'text=ACESSAR', 'text=Acessar',
    'xpath=//*[contains(translate(normalize-space(.), "abcdefghijklmnopqrstuvwxyz", "ABCDEFGHIJKLMNOPQRSTUVWXYZ"), "ACESSAR")]'
  ];

  // 1) tenta seletores normais e clique forçado na página principal e frames.
  for (const ctx of [page, ...page.frames()]) {
    for (const sel of selectors) {
      try {
        const loc = ctx.locator(sel).first();
        if (await loc.count() && await loc.isVisible({ timeout: 1200 }).catch(() => false)) {
          await loc.click({ timeout: 5000 }).catch(async () => loc.click({ timeout: 5000, force: true }));
          await page.waitForTimeout(1800);
          return `selector:${sel}`;
        }
      } catch {}
    }
  }

  console.log('[SEI] Clique normal no botão ACESSAR não funcionou. Tentando fallbacks robustos...');

  // 2) tenta clicar por elemento visível com texto/value/id/name/onClick parecido.
  for (const frame of page.frames()) {
    const clicked = await frame.evaluate(() => {
      const norm = (v) => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim();
      const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        const st = window.getComputedStyle(el);
        return r.width > 5 && r.height > 5 && st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity || 1) !== 0;
      };
      const els = Array.from(document.querySelectorAll('input, button, a, div, span, label, td'));
      const target = els.find((el) => {
        if (!isVisible(el)) return false;
        const txt = norm([el.innerText, el.textContent, el.value, el.id, el.name, el.title, el.className, el.getAttribute('aria-label'), el.getAttribute('onclick')].filter(Boolean).join(' '));
        return txt.includes('ACESSAR') || txt.includes('ACESS') || txt.includes('LOGIN') || txt.includes('ENTRAR');
      });
      if (target) {
        const clickable = target.closest('button,input,a,[onclick]') || target;
        clickable.scrollIntoView({ block: 'center', inline: 'center' });
        clickable.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
        clickable.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        clickable.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        clickable.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        try { clickable.click(); } catch {}
        return true;
      }
      return false;
    }).catch(() => false);
    if (clicked) {
      await page.waitForTimeout(2200);
      return 'fallback-dom-visible-text-click';
    }
  }

  // 3) tenta submeter formulário que contém o campo senha/usuário, e chamar funções comuns.
  for (const frame of page.frames()) {
    const submitted = await frame.evaluate(() => {
      const candidates = ['login', 'logar', 'entrar', 'acessar', 'validarLogin', 'onSubmit', 'submitLogin', 'enviarLogin', 'autenticar'];
      for (const name of candidates) {
        try { if (typeof window[name] === 'function') { window[name](); return `function:${name}`; } } catch {}
      }
      const pwd = document.querySelector('input[type="password"], input[name*=Senha], input[id*=Senha]');
      let form = pwd?.closest?.('form') || document.querySelector('form');
      if (form) {
        try {
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          if (typeof form.requestSubmit === 'function') form.requestSubmit();
          else form.submit();
          return 'form-submit';
        } catch {}
      }
      return '';
    }).catch(() => '');
    if (submitted) {
      await page.waitForTimeout(2200);
      return `fallback-${submitted}`;
    }
  }

  // 4) tentativa por coordenada configurável no Render.
  const envX = Number(process.env.SEI_LOGIN_CLICK_X || 0);
  const envY = Number(process.env.SEI_LOGIN_CLICK_Y || 0);
  if (envX > 0 && envY > 0) {
    console.log(`[SEI] Tentando clique por coordenada configurada SEI_LOGIN_CLICK_X/Y: x=${envX}, y=${envY}...`);
    await page.mouse.click(envX, envY);
    await page.waitForTimeout(2200);
    return 'fallback-env-coordinate-click';
  }

  // 5) tentativa por coordenada calculada: centro do botão abaixo do campo de unidade/senha.
  try {
    const point = await page.evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 20 && r.height > 15 && st.display !== 'none' && st.visibility !== 'hidden';
      };
      const buttonLike = Array.from(document.querySelectorAll('input, button, a, div, span'))
        .filter(visible)
        .map((el) => {
          const r = el.getBoundingClientRect();
          const txt = String([el.innerText, el.textContent, el.value, el.id, el.name, el.className].filter(Boolean).join(' ')).toUpperCase();
          return { x: r.x, y: r.y, width: r.width, height: r.height, txt };
        })
        .find((r) => r.txt.includes('ACESS') || r.txt.includes('ENTRAR') || r.txt.includes('LOGIN'));
      if (buttonLike) return { x: buttonLike.x + buttonLike.width / 2, y: buttonLike.y + buttonLike.height / 2, kind: 'buttonLike' };
      const boxes = Array.from(document.querySelectorAll('input, select'))
        .filter(visible)
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        })
        .sort((a,b) => a.y - b.y);
      if (boxes.length) {
        const last = boxes[boxes.length - 1];
        return { x: last.x + last.width / 2, y: last.y + last.height + 45, kind: 'belowLastInput' };
      }
      return null;
    });
    if (point) {
      console.log(`[SEI] Tentando clique por coordenada calculada (${point.kind}) em x=${Math.round(point.x)}, y=${Math.round(point.y)}...`);
      await page.mouse.click(point.x, point.y);
      await page.waitForTimeout(2200);
      return 'fallback-calculated-coordinate-click';
    }
  } catch {}

  // 6) tentativa por teclado: senha -> Enter / Tab Enter.
  try {
    const pwd = page.locator('input[type="password"]').first();
    if (await pwd.count()) {
      await pwd.focus();
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1500);
      await pwd.focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(2200);
      return 'fallback-password-enter-tab-enter';
    }
  } catch {}

  // 7) salva diagnóstico textual no log para calibrar.
  try {
    const diag = await page.evaluate(() => Array.from(document.querySelectorAll('input, button, a, select'))
      .map((el) => {
        const r = el.getBoundingClientRect();
        return `${el.tagName} id=${el.id||''} name=${el.name||''} type=${el.type||''} value=${el.value||''} text=${(el.innerText||el.textContent||'').trim()} x=${Math.round(r.x)} y=${Math.round(r.y)} w=${Math.round(r.width)} h=${Math.round(r.height)}`;
      }).slice(0, 40).join('\n'));
    console.log('[SEI][DEBUG LOGIN ELEMENTOS]\n' + diag);
  } catch {}

  throw new Error(`Não localizei/acionou botão ACESSAR. Seletores e fallbacks testados: ${selectors.join(', ')}, dom-visible-text-click, js-function/form-submit, env-coordinate-click, calculated-coordinate-click, keyboard-enter, debug-elements`);
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
    'input[type="text"]', 'input[type="tel"]', 'input[type="number"]', 'input[type="email"]', 'input[autocomplete*=username]', 'input[placeholder*=Usu]', 'input[placeholder*=CPF]', 'input[placeholder*=Login]', 'input:not([type])'
  ], process.env.SEI_USER);

  await fillFirstVisible(page, [
    'input[name="pwdSenha"]', '#pwdSenha', 'input[id*=Senha]', 'input[name*=Senha]', 'input[type="password"]', 'input[autocomplete*=password]', 'input[placeholder*=Senha]'
  ], process.env.SEI_PASSWORD);

  await selectUnidade(page, process.env.SEI_UNIDADE || '');

  const loginClickMethod = await clickLoginAcessar(page);
  console.log(`[SEI] Acesso acionado por: ${loginClickMethod}`);

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
  const candidates = [];
  for (const frame of allFrames(page)) {
    try {
      const found = await frame.locator('a, span, div, td').evaluateAll((els) => {
        const isVisible = (el) => {
          const s = window.getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return s && s.visibility !== 'hidden' && s.display !== 'none' && r.width > 0 && r.height > 0;
        };
        const valid = (text) => {
          const t = String(text || '').replace(/\s+/g, ' ').trim();
          if (!t || t.length > 180) return false;
          const hasId = /\(\d{5,}\)/.test(t);
          const startsDocType = /^(Informação|Informacao|Despacho|Ofício|Oficio|Memorando|Parecer|Anexo|Contrato|Termo\s+Aditivo|Termo\s+de\s+Referência|Termo\s+de\s+Referencia|Nota\s+Técnica|Nota\s+Tecnica|Portaria|Certidão|Certidao|Consulta|Comunicação|Comunicacao)\b/i.test(t);
          if (!hasId || !startsDocType) return false;
          if (/^SESAU-|GER[ÊE]NCIA|N[ÚU]CLEO|COORDENADORIA|CONTROLE DE PROCESSOS/i.test(t)) return false;
          return true;
        };
        const sectorFrom = (txt) => {
          const s = String(txt || '').replace(/\s+/g, ' ').trim();
          const m = s.match(/(SESAU-[A-Z0-9-]{2,}|HB-[A-Z0-9-]{2,}|GECONT|GPACC|CREG|PGE|CAD|CGAPP|NIARCREG|NIAR)/i);
          return m ? String(m[1]).toUpperCase() : '';
        };
        return els
          .filter(isVisible)
          .map((el, idx) => {
            const text = (el.innerText || el.textContent || '').trim();
            const parentText = (el.parentElement?.innerText || el.parentElement?.textContent || '').trim();
            const rowText = (el.closest('li, tr, div')?.innerText || el.closest('li, tr, div')?.textContent || '').trim();
            const ctx = [text, parentText, rowText].filter(Boolean).join(' ');
            return { idx, text, tag: el.tagName, href: el.href || el.getAttribute('href') || '', contextText: ctx, setorGerador: sectorFrom(ctx) };
          })
          .filter(x => valid(x.text))
          .filter((x, i, arr) => arr.findIndex(y => y.text === x.text) === i);
      });
      for (const f of found) candidates.push({ frame, text: cleanText(f.text), href: f.href || '', contextText: cleanText(f.contextText || ''), setorGerador: f.setorGerador || extractSectorFromContext(f.contextText || '') });
    } catch {}
  }

  const unique = [];
  const seen = new Set();
  for (const c of candidates) {
    const key = cleanText(c.text);
    if (!seen.has(key)) { seen.add(key); unique.push(c); }
  }
  return unique.slice(-Math.max(1, SEI_MAX_DOCUMENTS));
}

function locatorCandidatesForDocument(frame, candidate) {
  const label = cleanText(candidate.text || '');
  const parsed = parseDocumentName(label);
  const id = parsed.id_sei || '';
  const docName = parsed.documento || label;
  const tipo = inferDocumentType(docName);
  const locators = [];

  const push = (loc, name) => locators.push({ loc, name });

  // 1) Texto completo exatamente como aparece na árvore.
  if (label) push(frame.getByText(label, { exact: true }).first(), 'texto-exato');

  // 2) Texto aproximado do documento.
  if (docName && docName !== label) push(frame.getByText(docName, { exact: false }).first(), 'nome-documento');

  // 3) Número/ID SEI dentro da árvore.
  if (id) push(frame.getByText(id, { exact: false }).first(), 'id-sei');

  // 4) Link/âncora que contenha o texto ou o ID.
  if (label) push(frame.locator('a').filter({ hasText: label }).first(), 'link-com-texto-exato');
  if (docName) push(frame.locator('a').filter({ hasText: docName }).first(), 'link-com-nome');
  if (id) push(frame.locator('a').filter({ hasText: id }).first(), 'link-com-id');

  // 5) Elementos de árvore típicos do SEI.
  if (label) push(frame.locator('[id*=divArvore], [id*=arvore], #divArvore').locator('a, span, div, td').filter({ hasText: label }).first(), 'arvore-texto');
  if (id) push(frame.locator('[id*=divArvore], [id*=arvore], #divArvore').locator('a, span, div, td').filter({ hasText: id }).first(), 'arvore-id');

  // 6) Busca por tipo + id, útil quando o SEI quebra o texto em nós diferentes.
  if (tipo && id) push(frame.locator('a, span, div, td').filter({ hasText: new RegExp(`${tipo}.*${id}|${id}.*${tipo}`, 'i') }).first(), 'tipo-e-id');

  return locators;
}

async function readBestDocumentText(page) {
  let best = '';
  let bestFrameUrl = '';
  const frames = allFrames(page);

  for (const f of frames) {
    try {
      const txt = await f.locator('body').innerText({ timeout: 2500 });
      const cleaned = cleanText(txt);
      const n = normalize(cleaned);
      // Pontua melhor frames que parecem conter documento e penaliza árvore/menu do SEI.
      const isTree = looksLikeProcessTreeText(cleaned);
      const hasDocHeader = /(governo do estado|secretaria|núcleo|nucleo|assunto\s*:|refer[êe]ncia\s*:|ao senhor|senhor\(a\)|informa[cç][aã]o\s*n[ºo]|despacho)/i.test(cleaned);
      const penalty = isTree ? 100000 : 0;
      const bonus = hasDocHeader ? 20000 : 0;
      const score = Math.max(0, cleaned.length + bonus - penalty);
      const bestScore = Math.max(0, best.length + (/(assunto\s*:|governo do estado|secretaria)/i.test(best) ? 20000 : 0) - (looksLikeProcessTreeText(best) ? 100000 : 0));
      if (score > bestScore) {
        best = cleaned;
        bestFrameUrl = f.url();
      }
    } catch {}
  }

  if (!best) best = cleanText(await page.locator('body').innerText({ timeout: 5000 }).catch(() => ''));
  return { text: best, frameUrl: bestFrameUrl };
}

function validateReadText(text = '', candidate = {}) {
  const parsed = parseDocumentName(candidate.text || '');
  const id = parsed.id_sei || '';
  const docName = parsed.documento || candidate.text || '';
  const tipo = inferDocumentType(docName);
  const clean = cleanText(text);
  const n = normalize(clean);

  const isTree = looksLikeProcessTreeText(clean);
  const hasMinText = clean.length >= 120;
  const hasId = id ? n.includes(normalize(id)) : false;
  const hasTipo = tipo ? n.includes(normalize(tipo)) : false;
  const hasDocName = docName ? n.includes(normalize(docName).slice(0, 30)) : false;
  const hasExplicitSubject = /^\s*(assunto|refer[êe]ncia|objeto|ementa)\s*[:\-]/im.test(clean);
  const hasDocumentHeader = /(governo do estado|secretaria|núcleo|nucleo|ao senhor|senhor\(a\)|informa[cç][aã]o\s*n[ºo]|despacho\s*n[ºo]?)/i.test(clean);

  const confirmed = hasMinText && !isTree && (hasId || hasTipo || hasDocName || hasExplicitSubject || hasDocumentHeader);
  const reason = confirmed ? null : `Leitura não confirmada. minText=${hasMinText}, arvore=${isTree}, id=${hasId}, tipo=${hasTipo}, nome=${hasDocName}, assuntoExplicito=${hasExplicitSubject}, cabecalho=${hasDocumentHeader}`;
  return { confirmed, reason, hasMinText, isTree, hasId, hasTipo, hasDocName, hasExplicitSubject, hasDocumentHeader };
}

async function tryLocatorClick(page, candidate, loc, name) {
  if (!await loc.count().catch(() => 0)) return { ok: false, name, reason: 'locator não encontrado' };
  const target = loc.first();
  const visible = await target.isVisible({ timeout: 1200 }).catch(() => false);
  if (!visible) return { ok: false, name, reason: 'locator não visível' };

  const popupPromise = page.waitForEvent('popup', { timeout: 2500 }).catch(() => null);
  try {
    await target.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    await target.click({ timeout: 5000, force: true });
  } catch (err) {
    // 2ª tentativa: duplo clique.
    try { await target.dblclick({ timeout: 5000, force: true }); }
    catch (err2) {
      // 3ª tentativa: JS click no elemento/pai clicável.
      try {
        await target.evaluate((el) => {
          const clickable = el.closest('a, span, div, td, li') || el;
          clickable.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          clickable.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
        });
      } catch (err3) {
        return { ok: false, name, reason: err3.message || err2.message || err.message };
      }
    }
  }

  const popup = await popupPromise;
  if (popup) {
    await popup.waitForLoadState('domcontentloaded', { timeout: SEI_TIMEOUT_MS }).catch(() => {});
    await popup.waitForTimeout(1800);
    const readPopup = await readBestDocumentText(popup);
    const validPopup = validateReadText(readPopup.text, candidate);
    if (validPopup.confirmed) {
      await popup.close().catch(() => {});
      return { ok: true, name: `${name}/popup`, texto: readPopup.text, validation: validPopup };
    }
    await popup.close().catch(() => {});
  }

  await page.waitForLoadState('domcontentloaded', { timeout: 7000 }).catch(() => {});
  await page.waitForTimeout(2200);
  const read = await readBestDocumentText(page);
  const valid = validateReadText(read.text, candidate);
  if (valid.confirmed) return { ok: true, name, texto: read.text, validation: valid };
  return { ok: false, name, reason: valid.reason, textoTentativa: read.text?.slice(0, 1000) || '' };
}

async function clickByDirectHref(page, candidate) {
  const label = cleanText(candidate.text || '');
  const parsed = parseDocumentName(label);
  const id = parsed.id_sei || '';
  const docName = parsed.documento || label;

  for (const frame of allFrames(page)) {
    try {
      const hrefs = await frame.locator('a').evaluateAll((els, args) => {
        const { label, id, docName } = args;
        return els.map(a => ({ text: (a.innerText || a.textContent || '').trim(), href: a.href || a.getAttribute('href') || '' }))
          .filter(x => x.href && (
            (label && x.text.includes(label)) ||
            (id && (x.text.includes(id) || x.href.includes(id))) ||
            (docName && x.text.includes(docName))
          ));
      }, { label, id, docName });

      for (const h of hrefs.slice(0, 5)) {
        try {
          const url = new URL(h.href, frame.url()).toString();
          const newPage = await page.context().newPage();
          await newPage.goto(url, { waitUntil: 'domcontentloaded', timeout: SEI_TIMEOUT_MS });
          await newPage.waitForTimeout(1800);
          const read = await readBestDocumentText(newPage);
          const valid = validateReadText(read.text, candidate);
          await newPage.close().catch(() => {});
          if (valid.confirmed) return { ok: true, name: 'href-direto', texto: read.text, validation: valid };
        } catch {}
      }
    } catch {}
  }
  return { ok: false, name: 'href-direto', reason: 'nenhum href válido confirmou a leitura' };
}

async function clickDocumentAndRead(page, candidate) {
  const label = candidate.text;
  const frame = candidate.frame;
  const attempts = [];
  console.log(`[SEI] Abrindo documento com leitura robusta: ${label}`);

  // Estratégia A: vários locators e formas de clique.
  for (const { loc, name } of locatorCandidatesForDocument(frame, candidate)) {
    const result = await tryLocatorClick(page, candidate, loc, name);
    attempts.push({ name: result.name, ok: result.ok, reason: result.reason || null });
    console.log(`[SEI] Tentativa clique ${result.name}: ${result.ok ? 'OK' : 'falhou'}${result.reason ? ' - ' + result.reason : ''}`);
    if (result.ok) return { texto: String(result.texto || '').slice(0, 30000), erroLeitura: null, leitura_confirmada: true, estrategia_leitura: result.name, tentativas_leitura: attempts };
  }

  // Estratégia B: abrir href direto em nova página quando o SEI usa link escondido.
  const hrefResult = await clickByDirectHref(page, candidate);
  attempts.push({ name: hrefResult.name, ok: hrefResult.ok, reason: hrefResult.reason || null });
  console.log(`[SEI] Tentativa ${hrefResult.name}: ${hrefResult.ok ? 'OK' : 'falhou'}${hrefResult.reason ? ' - ' + hrefResult.reason : ''}`);
  if (hrefResult.ok) return { texto: String(hrefResult.texto || '').slice(0, 30000), erroLeitura: null, leitura_confirmada: true, estrategia_leitura: hrefResult.name, tentativas_leitura: attempts };

  // Fallback seguro: nunca impede o alerta.
  return {
    texto: '',
    erroLeitura: `Não foi possível abrir/confirmar a leitura do documento após ${attempts.length} tentativa(s).`,
    leitura_confirmada: false,
    estrategia_leitura: null,
    tentativas_leitura: attempts
  };
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
      if (!isValidDocumentLabel(cand.text)) {
        console.log(`[SEI] Ignorando candidato que não parece documento válido: ${cand.text}`);
        continue;
      }
      const { documento, id_sei } = parseDocumentName(cand.text);
      const tipo_documento = inferDocumentType(documento);
      const read = await clickDocumentAndRead(page, cand);
      const texto = read.texto || '';
      const setorGerador = cand.setorGerador || extractSectorFromContext(cand.contextText || cand.text || '') || 'SEI';
      const setor = setorGerador;
      const hoje = nowBR();
      const hash = `sei:${item.numero_processo}:${id_sei || documento}`;
      movements.push({
        data_movimentacao: hoje,
        setor,
        setor_gerador: setorGerador,
        setor_origem: setorGerador,
        tipo_documento,
        documento,
        id_sei,
        texto_documento: texto,
        resumo: read.erroLeitura ? `Movimentação identificada, mas o conteúdo não pôde ser lido: ${read.erroLeitura}` : `Documento ${documento} identificado pelo robô SEI.`,
        erro_leitura: read.erroLeitura || null,
        leitura_confirmada: !!read.leitura_confirmada,
        estrategia_leitura: read.estrategia_leitura || null,
        tentativas_leitura: read.tentativas_leitura ? JSON.stringify(read.tentativas_leitura).slice(0, 4000) : null,
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
  const textoOriginal = await readDocumentContent(item, movement);
  const textoValido = textoOriginal && !looksLikeProcessTreeText(textoOriginal) && movement.leitura_confirmada !== false;
  const texto = textoValido ? textoOriginal : '';
  const movementForSummary = textoValido ? movement : { ...movement, leitura_confirmada: false, erro_leitura: movement.erro_leitura || 'Texto capturado não foi considerado conteúdo confiável do documento.' };
  const assunto = extractDocumentSubject(texto, movementForSummary);
  const resumoDoc = summarizeDocumentText(texto, movementForSummary);
  return {
    ...movement,
    leitura_confirmada: textoValido ? movement.leitura_confirmada : false,
    erro_leitura: textoValido ? movement.erro_leitura : (movement.erro_leitura || 'Texto capturado não foi considerado conteúdo confiável do documento.'),
    texto_documento: texto ? String(texto).slice(0, 12000) : null,
    assunto_identificado: assunto || safeFallbackSubject(movementForSummary),
    resumo_documento: resumoDoc || safeFallbackSummary(movementForSummary),
    resumo: resumoDoc || safeFallbackSummary(movementForSummary)
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
    observacao: `Demanda automática gerada pelo robô SEI por novo documento/movimentação.\n\nProcesso: ${item.numero_processo}\nDocumento: ${movement.documento}\nTipo: ${movement.tipo_documento}\nSetor gerador: ${movement.setor_gerador || movement.setor}\nData: ${movement.data_movimentacao}\nAssunto identificado: ${movement.assunto_identificado || alerta?.titulo || ''}\nResumo: ${movement.resumo_documento || movement.resumo || ''}\n\nVerificar o teor do documento e adotar as providências cabíveis.`
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
    const diffDays = daysSince(mov.data_movimentacao);
    const recentForAlert = isRecentMovement(mov, ALERT_DOCUMENT_RECENCY_DAYS);
    const recentForDemand = isRecentMovement(mov, DEMAND_DOCUMENT_RECENCY_DAYS);
    const { erro_leitura, texto_documento, ...movToSave } = mov;

    // Evita duplicar alerta/movimentação quando a mesma movimentação já foi salva antes.
    const { data: existingMov, error: existingErr } = await supabase
      .from('processo_movimentacoes')
      .select('id')
      .eq('hash_movimentacao', mov.hash_movimentacao)
      .maybeSingle();
    if (existingErr) throw existingErr;
    if (existingMov?.id) {
      console.log(`[SEI] Movimentação já registrada, ignorando duplicidade: ${mov.documento}`);
      continue;
    }

    const { error: movErr } = await supabase.from('processo_movimentacoes').insert({
      processo_monitorado_id: item.origem === 'avulso' ? item.id : null,
      contrato_id: item.contrato_id || null,
      numero_processo: item.numero_processo,
      ...movToSave,
      texto_documento: texto_documento || null
    });
    if (movErr && !String(movErr.message).toLowerCase().includes('duplicate')) throw movErr;
    if (!movErr) newMovements++;
    if (movErr) continue;

    // Regra segura: documento novo em processo monitorado gera alerta. A janela de data classifica o alerta,
    // mas não deve impedir a notificação quando a movimentação é nova no sistema.
    const matches = ruleMatches(mov, item);
    const leituraFalhou = !!mov.erro_leitura;
    const dataIncerta = diffDays === null;
    const alertaInformativo = !recentForAlert || dataIncerta || !matches;
    if (!item.gerar_alerta) {
      console.log(`[SEI] Movimento registrado sem alerta porque gerar_alerta=false. documento=${mov.documento}`);
      continue;
    }

    const source_hash = `alert:${mov.hash_movimentacao}`;
    const primeiraLeitura = !hadPrevious;
    const podeGerarDemanda = !!item.gerar_demanda && !primeiraLeitura && recentForDemand && matches;
    const prefixoInformativo = alertaInformativo ? '[INFORMATIVO] ' : '';
    const leituraStatus = mov.leitura_confirmada ? 'Leitura do documento confirmada pelo robô.' : 'Conteúdo não confirmado/lido automaticamente.';
    const alertaPayload = {
      processo_monitorado_id: item.origem === 'avulso' ? item.id : null,
      contrato_id: item.contrato_id || null,
      numero_processo: item.numero_processo,
      titulo: `${prefixoInformativo}${formatDocumentRef(mov)} inserido no processo ${item.numero_processo}`, 
      descricao: primeiraLeitura
        ? `Primeira leitura do processo. Documento registrado como referência inicial. ${leituraStatus}`
        : `${leituraStatus} ${mov.resumo_documento || `Documento ${mov.documento} identificado pelo robô SEI.`}`,
      assunto_identificado: mov.assunto_identificado || null,
      resumo_documento: mov.resumo_documento || null,
      texto_documento: mov.texto_documento || null,
      estrategia_leitura: mov.estrategia_leitura || null,
      leitura_confirmada: !!mov.leitura_confirmada,
      erro_leitura: mov.erro_leitura || null,
      tentativas_leitura: mov.tentativas_leitura || null,
      nivel_alerta: alertaInformativo ? 'informativo' : 'normal',
      setor: mov.setor,
      setor_gerador: mov.setor_gerador || mov.setor,
      setor_origem: mov.setor_origem || mov.setor_gerador || mov.setor,
      tipo_documento: mov.tipo_documento,
      documento: mov.documento,
      id_sei: mov.id_sei || null,
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


async function createRobotExecution(startedAt, itemsLength) {
  try {
    const { data, error } = await supabase.from('robo_execucoes').insert({
      inicio: startedAt,
      status: 'Em andamento',
      modo: MODE,
      processos_monitorados: itemsLength || 0,
      processos_verificados: 0,
      processos_erro: 0,
      alertas_gerados: 0,
      demandas_geradas: 0,
      mensagem: 'Execução iniciada pelo robô SEI.'
    }).select('id').single();
    if (error) throw error;
    return data?.id || null;
  } catch (err) {
    console.warn('[ROBO] Não foi possível registrar execução no Supabase:', err.message);
    return null;
  }
}

async function updateRobotExecution(execId, patch) {
  if (!execId) return;
  try { await supabase.from('robo_execucoes').update(patch).eq('id', execId); }
  catch (err) { console.warn('[ROBO] Falha ao atualizar execução:', err.message); }
}

function robotItemKey(item) {
  return `${item.origem || 'processo'}:${item.id || item.contrato_id || item.processo_monitorado_id || item.numero_processo}`;
}

async function saveRobotExecutionItem(execId, item, result, ordem = null) {
  if (!execId) return;
  const payload = {
    execucao_id: execId,
    item_nome: item.assunto || item.prestador || item.numero_processo,
    numero_processo: item.numero_processo,
    origem: item.origem,
    status: result.error ? 'Erro' : 'Verificado',
    mensagem: result.error || (result.newMovements ? 'Movimentação nova identificada' : 'Sem novidade'),
    documento: result.documento || result.ultimoDocumento || null,
    movimentos: result.newMovements || 0,
    alertas: result.alerts || 0,
    demandas: result.demands || 0,
    item_key: robotItemKey(item),
    item_id: item.id || item.contrato_id || item.processo_monitorado_id || null,
    ordem,
    inicio_item: result.inicioItem || null,
    fim_item: result.fimItem || null,
    duracao_ms: result.duracaoMs || null
  };
  try {
    await supabase.from('robo_execucao_itens').insert(payload);
  } catch (err) {
    // Compatibilidade caso o SQL novo ainda não tenha sido rodado.
    const { item_key, item_id, ordem, inicio_item, fim_item, duracao_ms, ...legacyPayload } = payload;
    try { await supabase.from('robo_execucao_itens').insert(legacyPayload); }
    catch (err2) { console.warn('[ROBO] Falha ao registrar item da execução:', err2.message); }
  }
}

async function getLatestResumableExecution() {
  try {
    const { data, error } = await supabase
      .from('robo_execucoes')
      .select('*')
      .in('status', ['Em andamento', 'Pausada para continuação', 'Possível travamento'])
      .order('inicio', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    const inicio = data.inicio ? new Date(data.inicio) : null;
    if (!inicio || Number.isNaN(inicio.getTime())) return data;
    const ageMinutes = (Date.now() - inicio.getTime()) / 60000;
    if (ageMinutes > ROBOT_EXECUTION_STALE_MINUTES * 4) return null;
    return data;
  } catch (err) {
    console.warn('[ROBO] Não foi possível consultar execução retomável:', err.message);
    return null;
  }
}

async function getProcessedItemKeys(execId) {
  if (!execId) return new Set();
  try {
    const { data, error } = await supabase
      .from('robo_execucao_itens')
      .select('item_key,origem,numero_processo,status')
      .eq('execucao_id', execId)
      .neq('status', 'Erro');
    if (error) throw error;
    const keys = new Set();
    for (const row of data || []) {
      if (row.item_key) keys.add(row.item_key);
      else if (row.origem && row.numero_processo) keys.add(`${row.origem}:${row.numero_processo}`);
    }
    return keys;
  } catch (err) {
    console.warn('[ROBO] Não foi possível recuperar itens já verificados:', err.message);
    return new Set();
  }
}

function shouldStopBatch(batchStartedAt, processedInBatch) {
  if (processedInBatch >= ROBOT_BATCH_SIZE) return true;
  const elapsedMinutes = (Date.now() - batchStartedAt) / 60000;
  return elapsedMinutes >= ROBOT_TIME_BUDGET_MINUTES;
}

function scheduleSelfResume() {
  const delay = Math.max(5, ROBOT_SELF_RESUME_DELAY_SECONDS) * 1000;
  console.log(`[ROBO] Agendando retomada automática em ${Math.round(delay / 1000)}s...`);
  setTimeout(() => {
    runRobot({ resumedByTimer: true }).catch(err => console.error('[ROBO] Falha na retomada automática:', err));
  }, delay);
}

export async function runRobot(options = {}) {
  if (running) {
    const runningAge = runningStartedAt ? (Date.now() - runningStartedAt.getTime()) / 60000 : 0;
    if (runningAge > ROBOT_EXECUTION_STALE_MINUTES) {
      console.warn(`[ROBO] Execução em memória parecia travada há ${runningAge.toFixed(1)} min. Liberando trava local.`);
      running = false;
      runningStartedAt = null;
    } else {
      return { status: 'already-running', runningAgeMinutes: Number(runningAge.toFixed(1)) };
    }
  }

  running = true;
  runningStartedAt = new Date();
  const batchStartedAt = Date.now();
  const startedAt = new Date().toISOString();
  let execId = null;
  let resumed = false;

  try {
    const items = await fetchMonitoredItems();
    const resumable = await getLatestResumableExecution();
    if (resumable?.id) {
      execId = resumable.id;
      resumed = true;
      await updateRobotExecution(execId, {
        status: 'Em andamento',
        mensagem: 'Execução retomada automaticamente para continuar a varredura.'
      });
    } else {
      execId = await createRobotExecution(startedAt, items.length);
    }

    const processedKeys = await getProcessedItemKeys(execId);
    const pendingItems = items.filter(item => {
      const key = robotItemKey(item);
      return !processedKeys.has(key) && !processedKeys.has(`${item.origem}:${item.numero_processo}`);
    });

    const expiryDemands = resumed ? 0 : await generateExpiryDemands();
    const results = [];
    let processedInBatch = 0;

    console.log(`[ROBO] ${resumed ? 'Retomando' : 'Iniciando'} execução ${execId || '(sem id)'}. Total=${items.length}; já verificados=${processedKeys.size}; pendentes=${pendingItems.length}; lote=${ROBOT_BATCH_SIZE}; orçamento=${ROBOT_TIME_BUDGET_MINUTES}min.`);

    for (const item of pendingItems) {
      if (shouldStopBatch(batchStartedAt, processedInBatch)) break;
      const inicioItem = new Date().toISOString();
      const itemStarted = Date.now();
      let result;
      try {
        result = await processItem(item);
      } catch (err) {
        console.error(`[ERRO item ${item.numero_processo}]`, err);
        result = { item: item.assunto, processo: item.numero_processo, error: err.message };
      }
      result.inicioItem = inicioItem;
      result.fimItem = new Date().toISOString();
      result.duracaoMs = Date.now() - itemStarted;
      results.push(result);
      processedInBatch++;
      await saveRobotExecutionItem(execId, item, result, processedKeys.size + processedInBatch);

      // Totais parciais, considerando também os itens já registrados no banco.
      const totalVerificados = processedKeys.size + processedInBatch;
      await updateRobotExecution(execId, {
        processos_verificados: totalVerificados,
        processos_erro: results.filter(r => r.error).length,
        alertas_gerados: results.reduce((sum, r) => sum + Number(r.alerts || 0), 0),
        demandas_geradas: results.reduce((sum, r) => sum + Number(r.demands || 0), 0) + expiryDemands,
        mensagem: `Varredura em andamento. Verificados ${totalVerificados}/${items.length}.`
      });
    }

    const finalProcessedKeys = await getProcessedItemKeys(execId);
    const totalProcessed = Math.max(finalProcessedKeys.size, processedKeys.size + processedInBatch);
    const remaining = Math.max(0, items.length - totalProcessed);
    const partialTotals = {
      processos_verificados: totalProcessed,
      processos_erro: results.filter(r => r.error).length,
      alertas_gerados: results.reduce((sum, r) => sum + Number(r.alerts || 0), 0),
      demandas_geradas: results.reduce((sum, r) => sum + Number(r.demands || 0), 0) + expiryDemands
    };

    if (remaining > 0) {
      lastResult = {
        status: 'partial-resume-scheduled',
        executionId: execId,
        startedAt,
        pausedAt: new Date().toISOString(),
        mode: MODE,
        version: VERSION,
        monitored: items.length,
        processed: totalProcessed,
        remaining,
        batchSize: ROBOT_BATCH_SIZE,
        timeBudgetMinutes: ROBOT_TIME_BUDGET_MINUTES,
        results
      };
      await updateRobotExecution(execId, {
        status: 'Pausada para continuação',
        ...partialTotals,
        mensagem: `Lote concluído. Restam ${remaining} processo(s). Retomada automática agendada.`
      });
      scheduleSelfResume();
      console.log(JSON.stringify(lastResult, null, 2));
      return lastResult;
    }

    const totals = partialTotals;
    lastResult = {
      status: 'completed',
      executionId: execId,
      startedAt: resumed ? (resumable?.inicio || startedAt) : startedAt,
      finishedAt: new Date().toISOString(),
      mode: MODE,
      version: VERSION,
      demandDocumentRecencyDays: DEMAND_DOCUMENT_RECENCY_DAYS,
      alertDocumentRecencyDays: ALERT_DOCUMENT_RECENCY_DAYS,
      expiryDemands,
      monitored: items.length,
      processed: totalProcessed,
      results
    };
    await updateRobotExecution(execId, {
      fim: lastResult.finishedAt,
      status: totals.processos_erro ? 'Concluída com erro' : 'Concluída',
      ...totals,
      mensagem: totals.processos_erro ? 'Execução finalizada com erro em um ou mais processos.' : 'Execução concluída.'
    });
    console.log(JSON.stringify(lastResult, null, 2));
    return lastResult;
  } catch (err) {
    await updateRobotExecution(execId, { fim: new Date().toISOString(), status: 'Erro', mensagem: err.message });
    throw err;
  } finally {
    running = false;
    runningStartedAt = null;
  }
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

app.get('/', (_req, res) => res.json({ ok: true, service: 'Robô SEI NIAR', version: VERSION, mode: MODE, running, endpoints: ['GET /health', 'GET /run', 'POST /run', 'GET /trigger', 'POST /trigger', 'GET /reset-lock'], lastResult }));
app.get('/health', (_req, res) => res.json({ ok: true, version: VERSION, mode: MODE, running, lastResult }));

async function handleManualRun(req, res) {
  if (!checkTriggerToken(req, res)) return;
  try { res.json(await runRobot()); }
  catch (err) { console.error(err); res.status(500).json({ error: err.message, stack: SEI_DEBUG ? err.stack : undefined }); }
}

app.post('/run', handleManualRun);
app.get('/run', handleManualRun);
app.post('/trigger', handleManualRun);
app.get('/trigger', handleManualRun);
app.get('/reset-lock', (req, res) => { if (!checkTriggerToken(req, res)) return; running = false; runningStartedAt = null; res.json({ ok: true, message: 'Trava local liberada. Se houver execução pausada no banco, o próximo /trigger vai retomá-la.' }); });

if (process.argv.includes('--once')) {
  runRobot().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
} else {
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => console.log(`Robô SEI NIAR rodando na porta ${port}. Modo: ${MODE}. Versão ${VERSION}`));
  setInterval(() => runRobot().catch(err => console.error(err)), Math.max(5, INTERVAL_MINUTES) * 60 * 1000);
  setTimeout(() => runRobot().catch(err => console.error(err)), 5000);
}
