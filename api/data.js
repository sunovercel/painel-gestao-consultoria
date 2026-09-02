// Endpoint que serve os dados do painel a partir do Snowflake
// (ANALYTICS.CONSULTORIA), substituindo a leitura direta de CSV do Google
// Sheets. Devolve o mesmo formato que RAW = { leads, reunioes, vendas,
// metaCaptacao, metaLeads, negociacao, tombamentos } esperava do
// loadData()/fetchSheet() antigo -- cada array já vem com as chaves
// canônicas que normalizeRow()/COL_ALIASES usavam, então o resto do
// painel (filtros, funil, cohort, forecast, pivot) não precisa mudar.
//
// Limitações conhecidas (ver sql/README.md no repo Projeto Dados Snow):
//  - "reunioes" é APROXIMADA: não existe objeto de Task/Event/Meeting no
//    Salesforce (nem no Data Cloud share, nem na base legada via Airbyte).
//    Cada linha aqui é 1 negócio com indício de reunião (StatusReuniao_c__c,
//    BotConfirmou, Data1ReuniaoQualificacao), não 1 reunião real -- não há
//    "Tipo de chamada e reunião" real, nem múltiplas reuniões por negócio.
//  - "prioridade" não existe em nenhum objeto do Salesforce -- Forecast
//    roda sem segmentação por prioridade (tudo cai em "(Sem prioridade)").
//  - Os ~7.699 negócios com ETAPA_FUNIL = 'Lead' podem estar com EMAIL/
//    FONTE_AQUISICAO desatualizados enquanto Lead_Home__dll (fonte no
//    Salesforce Data Cloud) estiver quebrada -- ver sql/README.md.

import snowflake from 'snowflake-sdk';

let cachedConnection = null;
let cache = null;
let cacheAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min -- evita bater no Snowflake a cada carregamento de página

function getConnection() {
  return new Promise((resolve, reject) => {
    if (cachedConnection) return resolve(cachedConnection);
    const conn = snowflake.createConnection({
      account: process.env.SNOWFLAKE_ACCOUNT,
      username: process.env.SNOWFLAKE_USER,
      password: process.env.SNOWFLAKE_PASSWORD,
      warehouse: process.env.SNOWFLAKE_WAREHOUSE,
      role: process.env.SNOWFLAKE_ROLE,
      database: 'ANALYTICS',
      schema: 'CONSULTORIA',
    });
    conn.connect((err, connectedConn) => {
      if (err) return reject(new Error('Snowflake connection failed: ' + err.message));
      cachedConnection = connectedConn;
      resolve(connectedConn);
    });
  });
}

async function query(sqlText) {
  const conn = await getConnection();
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText,
      complete: (err, _stmt, rows) => {
        if (err) return reject(new Error('Query failed: ' + err.message));
        resolve(rows || []);
      },
    });
  });
}

const str = (v) => (v == null ? '' : String(v));

function mapNegocio(r) {
  return {
    negocio_id: r.NEGOCIO_ID,
    email: str(r.EMAIL),
    funil: str(r.FUNIL),
    estrategia: str(r.ESTRATEGIA),
    deal_utm_source: str(r.UTM_SOURCE),
    deal_utm_medium: str(r.UTM_MEDIUM),
    deal_utm_campaign: str(r.UTM_CAMPAIGN),
    fonte_original_pipe: str(r.FONTE_AQUISICAO),
    canal_originador: str(r.CANAL),
    patrimonio_investido_grupo: str(r.PATRIMONIO_DECLARADO),
    aporte_mensal_grupo: str(r.APORTE_MENSAL_FAIXA),
    adv_patrimonio_validado: str(r.PATRIMONIO_VALIDADO),
    valor: str(r.VALOR),
    data_criacao: str(r.DATA_CRIACAO),
    data_venda: str(r.DATA_CONTRATACAO),
    sdr_responsavel: str(r.SDR_RESPONSAVEL),
    closer_responsavel: str(r.CLOSER_RESPONSAVEL),
    etapa_do_negocio: str(r.STAGE_NAME),
    prioridade: '', // não existe no Salesforce -- confirmado em 2026-09-01
  };
}

function mapReuniaoAproximada(r) {
  return {
    negocio_id: r.NEGOCIO_ID,
    email: str(r.EMAIL),
    funil: str(r.FUNIL),
    estrategia: str(r.ESTRATEGIA),
    deal_utm_source: str(r.UTM_SOURCE),
    fonte_original_pipe: str(r.FONTE_AQUISICAO),
    canal_originador: str(r.CANAL),
    sdr_responsavel: str(r.SDR_RESPONSAVEL),
    closer_responsavel: str(r.CLOSER_RESPONSAVEL),
    data_da_atividade: str(r.DATA_1_REUNIAO_QUALIFICACAO || r.DATA_CRIACAO),
    status_reuniao: str(r.STATUS_REUNIAO) || (r.BOT_CONFIRMOU_REUNIAO ? 'Concluído' : ''),
    tipo_reuniao: 'Reunião', // aproximado -- não existe "Tipo de chamada e reunião" real na fonte
  };
}

function mapTombamento(r) {
  return {
    nome: str(r.NOME),
    email: str(r.EMAIL),
    taxa_de_adm: str(r.TAXA_ADM),
    data_de_implantacao: str(r.DATA_IMPLANTACAO),
    pl_total_implantado_via_api: str(r.PL_IMPLANTACAO),
  };
}

async function loadFromSnowflake() {
  const negocioRows = await query(`
    SELECT
      NEGOCIO_ID, EMAIL, ETAPA_FUNIL, FUNIL, ESTRATEGIA, STAGE_NAME,
      FONTE_AQUISICAO, CANAL, UTM_SOURCE, UTM_MEDIUM, UTM_CAMPAIGN,
      APORTE_MENSAL_FAIXA, PATRIMONIO_DECLARADO, PATRIMONIO_VALIDADO, VALOR,
      TO_VARCHAR(DATA_CRIACAO, 'YYYY-MM-DD') AS DATA_CRIACAO,
      TO_VARCHAR(DATA_CONTRATACAO, 'YYYY-MM-DD') AS DATA_CONTRATACAO,
      SDR_RESPONSAVEL, CLOSER_RESPONSAVEL, STATUS_REUNIAO, BOT_CONFIRMOU_REUNIAO,
      TO_VARCHAR(DATA_1_REUNIAO_QUALIFICACAO, 'YYYY-MM-DD') AS DATA_1_REUNIAO_QUALIFICACAO
    FROM FATO_NEGOCIO
  `);

  const negocios = negocioRows.map(mapNegocio);
  const leads = negocios; // "Leads" = todo negócio já captado, independente da etapa atual
  const vendas = negocioRows.filter(r => r.STAGE_NAME === 'Ganho').map(mapNegocio);
  const negociacao = negocioRows.filter(r => r.ETAPA_FUNIL === 'Opportunity').map(mapNegocio);
  const reunioes = negocioRows
    .filter(r => r.STATUS_REUNIAO || r.BOT_CONFIRMOU_REUNIAO || r.DATA_1_REUNIAO_QUALIFICACAO)
    .map(mapReuniaoAproximada);

  const metaRows = await query(`
    SELECT
      TO_VARCHAR(DATA_REFERENCIA, 'YYYY-MM-DD') AS DATA,
      META_TOTAL_LEADS, META_APLICACAO, META_SESSAO_ESTRATEGICA, META_SESSAO_LM_FRIOS,
      META_CAPTACAO, META_QUANTIDADE, META_PL_MEDIO
    FROM FATO_META_DIARIA
    ORDER BY DATA_REFERENCIA
  `);
  const metaLeads = metaRows.map(m => ({
    data: str(m.DATA),
    meta_total_de_leads: str(m.META_TOTAL_LEADS),
    meta_aplicacao: str(m.META_APLICACAO),
    meta_sessao_estrategica: str(m.META_SESSAO_ESTRATEGICA),
    meta_sessao_lmfrios: str(m.META_SESSAO_LM_FRIOS),
  }));
  const metaCaptacao = metaRows.map(m => ({
    data: str(m.DATA),
    meta_de_captacao: str(m.META_CAPTACAO),
    meta_de_quantidade: str(m.META_QUANTIDADE),
    meta_de_pl_medio: str(m.META_PL_MEDIO),
  }));

  const tombRows = await query(`
    SELECT
      NOME, EMAIL, TAXA_ADM,
      TO_VARCHAR(DATA_IMPLANTACAO, 'YYYY-MM-DD') AS DATA_IMPLANTACAO,
      PL_IMPLANTACAO
    FROM FATO_TOMBAMENTO
  `);
  const tombamentos = tombRows.map(mapTombamento);

  return { leads, reunioes, vendas, metaCaptacao, metaLeads, negociacao, tombamentos };
}

export default async function handler(req, res) {
  // Versão de homologação: acesso restrito por senha única (SITE_PASSWORD
  // na Vercel). Protege o endpoint em si, não só a tela do painel -- sem
  // isso, quem descobrisse a URL do endpoint pulava a tela de login.
  const sitePassword = process.env.SITE_PASSWORD;
  if (sitePassword && req.headers['x-site-password'] !== sitePassword) {
    return res.status(401).json({ error: 'Senha inválida ou ausente.' });
  }

  try {
    const now = Date.now();
    if (!cache || now - cacheAt > CACHE_TTL_MS) {
      cache = await loadFromSnowflake();
      cacheAt = now;
    }
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    res.status(200).json(cache);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
