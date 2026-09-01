'use strict';

const Papa = require('papaparse');

// ================================================================
// CONFIG
// ================================================================
const SHEET_ID = '1nBsorlQR29Ub_KFmr-QW2O2fi1lPKUuBIRvEKC1m8PU';
const BASE_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=`;
const sheetURL = name => BASE_URL + encodeURIComponent(name) + '&_t=' + Date.now();

// ================================================================
// UTILITIES (ported from index.html)
// ================================================================
function normalizeKey(k) {
  return String(k).toLowerCase().trim()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_').replace(/^_|_$/g, '');
}

const COL_ALIASES = {
  data_criacao:        ['data_criacao','data_de_criacao','datacriacao','data_cadastro','created_at','data_criacao_do_lead','data_criacao_lead'],
  email:               ['email','email_do_contato','emaildocontato','e_mail','contato_email'],
  lead_id:             ['lead_id','id_lead','leadid','id'],
  deal_utm_source:     ['deal_utm_source','utm_source','source','midia_source'],
  estrategia:          ['estrategia'],
  funil:               ['funil'],
  fonte_original_pipe: ['fonte_original_pipe','fonte_original_pipes','fonte_original','fonteoriginalpipe'],
  canal_originador:    ['canal_originador','canal_originador_do_lead','vendas_canal_originador_do_lead_analises','canal_orig'],
  status_reuniao:      ['status_reuniao','status','situacao','status_da_reuniao','reuniao_status'],
  data_venda:          ['data_venda','data_de_venda','datavenda','data_fechamento','consultoria_data_da_contratacao_diario','data_contratacao','data_da_contratacao'],
  data_reuniao:        ['data_reuniao','data_da_reuniao','datareuniao'],
  patrimonio_validado: ['adv_patrimonio_validado','patrimonio_validado','patrimonio','aum','patrimonio_aum','patrimonio_cliente'],
  valor:               ['valor','value','receita','valor_contrato'],
  consultor:           ['consultor','consultor_responsavel'],
};

const COL_REVERSE = {};
for (const [canon, aliases] of Object.entries(COL_ALIASES))
  for (const alias of aliases)
    COL_REVERSE[alias] = canon;

function normalizeRow(row) {
  const raw = {};
  for (const [k, v] of Object.entries(row))
    raw[normalizeKey(k)] = (v == null ? '' : String(v)).trim();
  const out = { ...raw };
  for (const [rawKey, val] of Object.entries(raw)) {
    const canon = COL_REVERSE[rawKey];
    if (canon && out[canon] === undefined) out[canon] = val;
  }
  return out;
}

let DATE_FMT = null;
let VENDA_DATE_FMT = null;

function parseDate(s, fmt) {
  if (!s) return null;
  s = String(s).trim().replace(/\s+\d{1,2}:\d{2}(:\d{2})?(\s*(AM|PM))?$/i, '').trim();
  if (!s) return null;

  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const [, a, b, y] = m.map(Number);
    if (a > 12) return new Date(y, b - 1, a);
    if (b > 12) return new Date(y, a - 1, b);
    if ((fmt || DATE_FMT) === 'MDY') return new Date(y, a - 1, b);
    return new Date(y, b - 1, a);
  }

  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);

  if (/^\d{5}$/.test(s)) {
    const d = new Date(1899, 11, 30);
    d.setDate(d.getDate() + +s);
    return d;
  }

  const d = new Date(s);
  return isNaN(d) ? null : d;
}

function detectDateFormats(RAW) {
  const fields = ['data_criacao', 'data_de_criacao', 'data_reuniao'];
  for (const table of [RAW.leads, RAW.reunioes]) {
    for (const row of table.slice(0, 200)) {
      for (const f of [...fields, ...Object.keys(row)].filter((v, i, a) => a.indexOf(v) === i)) {
        const s = (row[f] || '').trim().replace(/\s+\d{1,2}:\d{2}.*$/, '').trim();
        const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (!m) continue;
        const a = +m[1], b = +m[2];
        if (a > 12) { DATE_FMT = 'DMY'; break; }
        if (b > 12) { DATE_FMT = 'MDY'; break; }
      }
      if (DATE_FMT) break;
    }
    if (DATE_FMT) break;
  }
  if (!DATE_FMT) DATE_FMT = 'DMY';

  const vendaFields = ['data_venda', 'data_da_contratacao', 'data_contratacao', 'consultoria_data_da_contratacao_diario'];
  for (const row of RAW.vendas.slice(0, 500)) {
    for (const f of [...vendaFields, ...Object.keys(row)].filter((v, i, a) => a.indexOf(v) === i)) {
      const s = (row[f] || '').trim().replace(/\s+\d{1,2}:\d{2}.*$/, '').trim();
      const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (!m) continue;
      const a = +m[1], b = +m[2];
      if (a > 12) { VENDA_DATE_FMT = 'DMY'; break; }
      if (b > 12) { VENDA_DATE_FMT = 'MDY'; break; }
    }
    if (VENDA_DATE_FMT) break;
  }
  if (!VENDA_DATE_FMT) VENDA_DATE_FMT = DATE_FMT;
}

function normVal(s) {
  return String(s || '').toLowerCase().trim()
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
}

const REALIZADA_VALUES = ['concluido', 'realizada', 'concluida', 'concluded', 'done', 'realizado'];

function detectReuniaoStatus(reunioes) {
  if (!reunioes.length) return null;
  const keys = Object.keys(reunioes[0]);
  for (const key of keys) {
    const hasIt = reunioes.slice(0, 500).some(r => REALIZADA_VALUES.includes(normVal(r[key])));
    if (hasIt) return key;
  }
  return null;
}

function isRealizada(r, statusKey) {
  if (statusKey) return REALIZADA_VALUES.includes(normVal(r[statusKey]));
  return REALIZADA_VALUES.includes(normVal(r.status_reuniao));
}

function isOrigemBase(row) {
  const f = (row.fonte_original_pipe || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  return f === 'prospeccao consultor';
}

function parseNum(s) {
  if (!s) return 0;
  s = String(s).trim().replace(/[R$\s]/g, '');
  if (!s) return 0;
  if (/^\d{1,3}(\.\d{3})*,\d+$/.test(s)) return parseFloat(s.replace(/\./g, '').replace(',', '.')) || 0;
  if (/^\d{1,3}(\.\d{3})+$/.test(s)) return parseFloat(s.replace(/\./g, '')) || 0;
  if (/^\d{1,3}(,\d{3})*\.\d+$/.test(s)) return parseFloat(s.replace(/,/g, '')) || 0;
  if (/^\d{1,3}(,\d{3})+$/.test(s)) return parseFloat(s.replace(/,/g, '')) || 0;
  if (/^\d+(,\d+)?$/.test(s)) return parseFloat(s.replace(',', '.')) || 0;
  return parseFloat(s.replace(/[^0-9.]/g, '')) || 0;
}

const parsePatrimonio = s => { const n = parseNum(s); return n > 0 && n < 10000 ? n * 1000 : n; };

const fmtR$ = n => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }).format(n || 0);
const fmtN  = n => (n || 0).toLocaleString('pt-BR');

function isSameDay(d, ref) {
  if (!d || !ref) return false;
  return d.getFullYear() === ref.getFullYear()
    && d.getMonth()    === ref.getMonth()
    && d.getDate()     === ref.getDate();
}

// ================================================================
// FETCH SHEETS
// ================================================================
async function fetchSheet(name) {
  const url = sheetURL(name);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching sheet "${name}"`);
  const csv = await resp.text();
  return Papa.parse(csv, { header: true, skipEmptyLines: true }).data.map(normalizeRow);
}

async function fetchSheets() {
  console.log('Fetching Google Sheets...');
  const [leads, reunioes, vendas, metaCaptacao, metaLeads] = await Promise.all([
    fetchSheet('Leads'),
    fetchSheet('Reuniões'),
    fetchSheet('Vendas'),
    fetchSheet('Meta Captação'),
    fetchSheet('Meta Leads'),
  ]);
  console.log(`Loaded: ${leads.length} leads · ${reunioes.length} reuniões · ${vendas.length} vendas`);
  return { leads, reunioes, vendas, metaCaptacao, metaLeads };
}

// ================================================================
// AGGREGATE YESTERDAY
// ================================================================
function getYesterdayDate() {
  // Allow override for manual testing: YESTERDAY_OVERRIDE=YYYY-MM-DD
  if (process.env.YESTERDAY_OVERRIDE) {
    const [y, m, d] = process.env.YESTERDAY_OVERRIDE.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  t.setDate(t.getDate() - 1);
  return t;
}

function aggregateYesterday(RAW) {
  const yesterday  = getYesterdayDate();
  const statusKey  = detectReuniaoStatus(RAW.reunioes);

  // --- LEADS ---
  const yleads = RAW.leads.filter(l => isSameDay(parseDate(l.data_criacao), yesterday));
  const leadsByFunil = {};
  yleads.forEach(l => {
    const k = (l.funil || '(sem funil)').trim();
    leadsByFunil[k] = (leadsByFunil[k] || 0) + 1;
  });
  const leadsByFonte = {};
  yleads.forEach(l => {
    const k = (l.fonte_original_pipe || '(sem fonte)').trim();
    leadsByFonte[k] = (leadsByFonte[k] || 0) + 1;
  });

  // --- REUNIÕES ---
  const yreun     = RAW.reunioes.filter(r => isSameDay(parseDate(r.data_reuniao), yesterday));
  const yreunReal = yreun.filter(r => isRealizada(r, statusKey));

  // --- VENDAS ---
  const yvendas  = RAW.vendas.filter(v => isSameDay(parseDate(v.data_venda, VENDA_DATE_FMT), yesterday));
  const capTotal = yvendas.reduce((s, v) => s + parsePatrimonio(v.adv_patrimonio_validado || v.patrimonio_validado), 0);
  const capBase  = yvendas.filter(isOrigemBase).reduce((s, v) => s + parsePatrimonio(v.adv_patrimonio_validado || v.patrimonio_validado), 0);
  const plMedio  = yvendas.length ? capTotal / yvendas.length : 0;

  // --- META DO DIA ---
  let metaLeadsDia = 0, metaCapDia = 0;
  RAW.metaLeads.forEach(m => {
    if (isSameDay(parseDate(m.data), yesterday)) metaLeadsDia += parseNum(m.meta_total_de_leads);
  });
  RAW.metaCaptacao.forEach(m => {
    if (isSameDay(parseDate(m.data), yesterday)) metaCapDia += parseNum(m.meta_de_captacao);
  });

  return {
    date: yesterday,
    leads: {
      total: yleads.length,
      byFunil: leadsByFunil,
      byFonte: leadsByFonte,
      meta: metaLeadsDia,
    },
    reunioes: {
      total: yreun.length,
      realizadas: yreunReal.length,
    },
    vendas: {
      total: yvendas.length,
      capTotal,
      capSuno: capTotal - capBase,
      capBase,
      plMedio,
      meta: metaCapDia,
    },
  };
}

// ================================================================
// AI ANALYSIS
// ================================================================
const SYSTEM_PROMPT = `Você é um assistente analítico do time comercial da Suno Consultoria.
Analise os números do dia anterior de forma direta, concisa e útil.
- Destaque o que chamou atenção (positivo ou negativo)
- Se houver meta, comente o atingimento
- Use no máximo 3-4 frases curtas
- Escreva em parágrafo corrido, sem bullet points
- Responda em português brasileiro
- Não mencione que é uma IA`;

async function generateAnalysis(metrics) {
  const { date, leads, reunioes, vendas } = metrics;
  const dateStr = date.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });

  const text = `Métricas de ${dateStr}:

LEADS: ${leads.total}${leads.meta ? ` (meta do dia: ${leads.meta})` : ''}
Por funil: ${Object.entries(leads.byFunil).map(([k, v]) => `${k}: ${v}`).join(', ') || 'nenhum'}

REUNIÕES: ${reunioes.total} agendadas, ${reunioes.realizadas} realizadas

VENDAS: ${vendas.total} clientes${vendas.meta ? ` (meta captação do dia: ${fmtR$(vendas.meta)})` : ''}
Captação total: ${fmtR$(vendas.capTotal)}
Origem Suno: ${fmtR$(vendas.capSuno)} | Origem Base: ${fmtR$(vendas.capBase)}
PL Médio: ${vendas.total ? fmtR$(vendas.plMedio) : '—'}

Gere uma análise curta e direta desses resultados.`;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: text }],
      }),
    });
    if (!resp.ok) throw new Error(`Anthropic HTTP ${resp.status}`);
    const data = await resp.json();
    return data.content[0].text;
  } catch (e) {
    console.error('Analysis generation failed:', e.message);
    return null;
  }
}

// ================================================================
// BUILD EMAIL HTML
// ================================================================
function buildEmailHTML(metrics, analysis) {
  const { date, leads, reunioes, vendas } = metrics;
  const dateStr   = date.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
  const dateShort = date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });

  const fmtAtg = (real, meta) => {
    if (!meta) return '';
    const pct   = ((real / meta) * 100).toFixed(0);
    const color = real >= meta ? '#16a34a' : '#C82526';
    return `<span style="color:${color};font-weight:700;font-size:11px;margin-left:8px;">${pct}% da meta</span>`;
  };

  const funilRows = Object.entries(leads.byFunil)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `
      <tr>
        <td style="padding:7px 10px;border-bottom:1px solid #F0F0F0;font-size:13px;">${k}</td>
        <td style="padding:7px 10px;border-bottom:1px solid #F0F0F0;text-align:right;font-weight:600;font-size:13px;">${v}</td>
      </tr>`)
    .join('');

  const fonteRows = Object.entries(leads.byFonte)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k, v]) => `
      <tr>
        <td style="padding:6px 10px;border-bottom:1px solid #F5F5F5;font-size:12px;color:#4B5563;">${k}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #F5F5F5;text-align:right;font-size:12px;color:#4B5563;">${v}</td>
      </tr>`)
    .join('');

  const analysisSection = analysis
    ? `<div style="background:#fff;border-radius:8px;padding:20px 24px;margin-bottom:16px;border:1px solid #E8E8E8;">
        <div style="font-size:11px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:0.6px;margin-bottom:12px;">Análise IA</div>
        <div style="background:#FEF2F2;border:1px solid rgba(200,37,38,.15);border-radius:8px;padding:16px;font-size:13px;line-height:1.75;color:#2D2D2D;">${analysis.replace(/\n/g, '<br>')}</div>
      </div>`
    : '';

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Resumo Comercial Suno</title>
</head>
<body style="margin:0;padding:0;background:#F5F7FA;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<div style="max-width:600px;margin:0 auto;padding:20px;">

  <!-- HEADER -->
  <div style="background:#fff;border-radius:8px;padding:24px 28px;margin-bottom:16px;border:1px solid #E8E8E8;border-left:4px solid #C82526;">
    <div style="margin-bottom:6px;">
      <span style="color:#C82526;font-weight:800;font-size:20px;line-height:1;">(</span>
      <span style="color:#2D2D2D;font-weight:700;letter-spacing:3px;font-size:14px;margin:0 4px;">SUNO</span>
      <span style="color:#C82526;font-weight:800;font-size:20px;line-height:1;">)</span>
    </div>
    <div style="font-size:20px;font-weight:700;color:#2D2D2D;line-height:1.2;">Resumo Comercial</div>
    <div style="font-size:13px;color:#6B7280;margin-top:4px;">${dateStr}</div>
  </div>

  <!-- LEADS -->
  <div style="background:#fff;border-radius:8px;padding:20px 24px;margin-bottom:16px;border:1px solid #E8E8E8;">
    <div style="font-size:11px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:0.6px;margin-bottom:12px;">Leads Gerados</div>
    <div style="font-size:36px;font-weight:700;color:#2D2D2D;line-height:1;">${leads.total}${fmtAtg(leads.total, leads.meta)}</div>
    ${leads.meta ? `<div style="font-size:12px;color:#9CA3AF;margin-top:4px;">Meta do dia: ${leads.meta}</div>` : ''}
    ${funilRows ? `
    <table style="width:100%;border-collapse:collapse;margin-top:16px;">
      <thead>
        <tr>
          <th style="text-align:left;font-size:10px;font-weight:700;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.5px;padding:7px 10px;background:#F9F9F9;border-radius:4px 0 0 4px;">Funil</th>
          <th style="text-align:right;font-size:10px;font-weight:700;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.5px;padding:7px 10px;background:#F9F9F9;border-radius:0 4px 4px 0;">Leads</th>
        </tr>
      </thead>
      <tbody>${funilRows}</tbody>
    </table>` : ''}
    ${fonteRows ? `
    <table style="width:100%;border-collapse:collapse;margin-top:10px;">
      <thead>
        <tr>
          <th style="text-align:left;font-size:10px;font-weight:700;color:#D1D5DB;text-transform:uppercase;letter-spacing:0.5px;padding:6px 10px;background:#FAFAFA;">Fonte Original (top 5)</th>
          <th style="text-align:right;font-size:10px;font-weight:700;color:#D1D5DB;text-transform:uppercase;letter-spacing:0.5px;padding:6px 10px;background:#FAFAFA;">N</th>
        </tr>
      </thead>
      <tbody>${fonteRows}</tbody>
    </table>` : ''}
  </div>

  <!-- REUNIÕES -->
  <div style="background:#fff;border-radius:8px;padding:20px 24px;margin-bottom:16px;border:1px solid #E8E8E8;">
    <div style="font-size:11px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:0.6px;margin-bottom:14px;">Reuniões</div>
    <div style="display:flex;gap:32px;">
      <div>
        <div style="font-size:32px;font-weight:700;color:#2D2D2D;line-height:1;">${reunioes.total}</div>
        <div style="font-size:11px;color:#9CA3AF;margin-top:4px;">Agendadas</div>
      </div>
      <div>
        <div style="font-size:32px;font-weight:700;color:#C82526;line-height:1;">${reunioes.realizadas}</div>
        <div style="font-size:11px;color:#9CA3AF;margin-top:4px;">Realizadas</div>
      </div>
    </div>
  </div>

  <!-- VENDAS -->
  <div style="background:#fff;border-radius:8px;padding:20px 24px;margin-bottom:16px;border:1px solid #E8E8E8;">
    <div style="font-size:11px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:0.6px;margin-bottom:14px;">Vendas e Captação</div>
    <div style="display:flex;gap:28px;flex-wrap:wrap;margin-bottom:16px;align-items:flex-end;">
      <div>
        <div style="font-size:36px;font-weight:700;color:#2D2D2D;line-height:1;">${vendas.total}</div>
        <div style="font-size:11px;color:#9CA3AF;margin-top:4px;">Clientes</div>
      </div>
      <div>
        <div style="font-size:22px;font-weight:700;color:#2D2D2D;line-height:1;">${fmtR$(vendas.capTotal)}${fmtAtg(vendas.capTotal, vendas.meta)}</div>
        <div style="font-size:11px;color:#9CA3AF;margin-top:4px;">Captação total${vendas.meta ? ` · Meta: ${fmtR$(vendas.meta)}` : ''}</div>
      </div>
      <div>
        <div style="font-size:16px;font-weight:600;color:#6B7280;line-height:1;">${vendas.total ? fmtR$(vendas.plMedio) : '—'}</div>
        <div style="font-size:11px;color:#9CA3AF;margin-top:4px;">PL Médio</div>
      </div>
    </div>
    <table style="width:100%;border-collapse:collapse;">
      <thead>
        <tr>
          <th style="text-align:left;font-size:10px;font-weight:700;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.5px;padding:7px 10px;background:#F9F9F9;">Origem</th>
          <th style="text-align:right;font-size:10px;font-weight:700;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.5px;padding:7px 10px;background:#F9F9F9;">Captação</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td style="padding:8px 10px;border-bottom:1px solid #F0F0F0;font-size:13px;">
            <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#2563eb;margin-right:7px;vertical-align:middle;"></span>Origem Suno
          </td>
          <td style="padding:8px 10px;border-bottom:1px solid #F0F0F0;text-align:right;font-weight:600;font-size:13px;">${fmtR$(vendas.capSuno)}</td>
        </tr>
        <tr>
          <td style="padding:8px 10px;font-size:13px;">
            <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#16a34a;margin-right:7px;vertical-align:middle;"></span>Origem Base
          </td>
          <td style="padding:8px 10px;text-align:right;font-weight:600;font-size:13px;">${fmtR$(vendas.capBase)}</td>
        </tr>
      </tbody>
    </table>
  </div>

  <!-- ANÁLISE IA -->
  ${analysisSection}

  <!-- FOOTER -->
  <div style="text-align:center;padding:16px 0;font-size:11px;color:#9CA3AF;line-height:1.6;">
    Dashboard Estratégico Comercial · Suno Consultoria<br>
    Dados referentes a ${dateShort} · Enviado automaticamente por volta das 09h BRT
  </div>

</div>
</body>
</html>`;
}

// ================================================================
// SEND EMAIL (SendGrid API v3)
// ================================================================
async function sendEmail(html, subject) {
  const recipients = process.env.EMAIL_RECIPIENTS
    .split(',')
    .map(e => ({ email: e.trim() }))
    .filter(r => r.email);

  const resp = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.SENDGRID_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: { email: process.env.EMAIL_FROM, name: 'Suno · Dashboard Comercial' },
      personalizations: [{ to: recipients }],
      subject,
      content: [{ type: 'text/html', value: html }],
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`SendGrid ${resp.status}: ${body}`);
  }
  console.log(`Email sent to: ${recipients.map(r => r.email).join(', ')}`);
}

// ================================================================
// MAIN
// ================================================================
async function main() {
  const required = ['ANTHROPIC_KEY', 'SENDGRID_API_KEY', 'EMAIL_FROM', 'EMAIL_RECIPIENTS'];
  const missing  = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error('Missing env vars:', missing.join(', '));
    process.exit(1);
  }

  let RAW;
  try {
    RAW = await fetchSheets();
  } catch (e) {
    console.error('Failed to fetch sheets:', e.message);
    process.exit(1);
  }

  detectDateFormats(RAW);
  console.log(`Date formats — leads: ${DATE_FMT}, vendas: ${VENDA_DATE_FMT}`);

  const metrics   = aggregateYesterday(RAW);
  const dateShort = metrics.date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  console.log(`Metrics for ${dateShort}: ${metrics.leads.total} leads · ${metrics.reunioes.realizadas} reuniões realizadas · ${metrics.vendas.total} vendas · ${fmtR$(metrics.vendas.capTotal)}`);

  const analysis = await generateAnalysis(metrics);
  const subject  = `\u{1F4CA} Resumo Comercial Suno — ${dateShort}`;
  const html     = buildEmailHTML(metrics, analysis);

  try {
    await sendEmail(html, subject);
  } catch (e) {
    console.error('Failed to send email:', e.message);
    process.exit(1);
  }

  console.log('Done!');
}

main();
