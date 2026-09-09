// Endpoint que serve os dados do painel a partir do Snowflake
// (ANALYTICS.CONSULTORIA), substituindo a leitura direta de CSV do Google
// Sheets. Devolve o mesmo formato que RAW = { leads, reunioes, vendas,
// metaCaptacao, metaLeads, negociacao, tombamentos } esperava do
// loadData()/fetchSheet() antigo -- cada array já vem com as chaves
// canônicas que normalizeRow()/COL_ALIASES usavam, então o resto do
// painel (filtros, funil, cohort, forecast, pivot) não precisa mudar.
//
// Negociação (pipeline aberto) vem de VW_FATO_NEGOCIO_COMBINADO (2026-09-02),
// não de FATO_NEGOCIO puro -- Consultoria só passou a existir de fato no
// Salesforce a partir de 2026-07-14 (antes disso o pouco que aparecia em
// FATO_NEGOCIO era ruído). A view combina Salesforce (>= corte) com
// FATO_NEGOCIO_HIST_HUBSPOT (< corte, carga única a partir de
// RAW.CONSULTORIA_HUBSPOT.FUNIL_ADVISORY). Ver sql/007_load_negocio_historico_hubspot.sql
// e sql/README.md no repo Projeto Dados Snow.
//
// Vendas vêm de VW_VENDAS_SALESFORCE (2026-09-09), que lê direto o objeto
// Opportunity do Salesforce Data Cloud com a lógica que o Rafael (área de
// negócio) validou: StageName=Ganho, RecordType=Consultoria, Produto=Fee
// Fixo, DataInicioContrato > 2026-07-13 -- e usa PATRIMONIO_VALIDADO como
// métrica de venda (não VALOR/Amount). Antes "vendas" era só um filtro
// STAGE_NAME='Ganho' em cima de VW_FATO_NEGOCIO_COMBINADO, sem o filtro de
// RecordType/Produto, misturando oportunidades ganhas de outras áreas da
// Suno. Validado: 117 registros, R$ 91.983.489,00 de patrimônio validado,
// bate exato com o relatório [Marketing] Vendas de Consultoria do
// Salesforce. Ver sql/README.md e sql/012_criar_vw_vendas_salesforce.sql.
//
// Leads vêm de VW_LEADS_SALESFORCE (2026-09-08), que lê direto o objeto Lead
// do Salesforce Data Cloud (Lead_Home__dll), NÃO de VW_FATO_NEGOCIO_COMBINADO
// (que é baseado em Opportunity). Isso foi trocado porque "leads" antes
// contava todo negócio já captado em qualquer etapa (273k, desde 2021) e não
// batia com o relatório oficial do Salesforce (~10k, desde 14/07/26) -- ver
// sql/README.md e sql/011_criar_vw_leads_salesforce.sql no repo Projeto Dados
// Snow. Por vir de um objeto diferente (Lead, não Opportunity), o array
// "leads" não tem sdr_responsavel/closer_responsavel/valor/data_venda reais
// (ficam '' -- ver mapLead()); o join com "vendas" no cohort é por email.
//
// Reuniões vêm de VW_REUNIOES_SALESFORCE (2026-09-09), que lê direto o objeto
// ServiceAppointment do Salesforce (Scheduler) -- confirmado pelo vendor como
// o objeto real de reunião comercial de Consultoria, e MUITO melhor que a
// antiga aproximação via campos da Opportunity (StatusReuniao_c__c/
// BotConfirmou/Data1ReuniaoQualificacao), que não tinha grão real de reunião
// nem tipo real. Achado importante: DATA_CRIACAO na view é a data de criação
// do LEAD (join por e-mail feito dentro da própria view), não da própria
// ServiceAppointment -- isso faz o filtro global de "Criação" do painel
// implementar coorte real (dos leads gerados num dia, quantos tiveram
// reunião), que é a lógica que o Rafael descreveu em reunião. Antes, o
// filtro comparava a data de criação do LEAD com a data de criação da
// OPPORTUNITY (dois objetos diferentes, sem relação de coorte real).
// Validado: para leads de 2026-09-01, 30 leads com reunião marcada e 8 com
// realizada (vs 36/10 que a lógica antiga mostrava). Ver sql/README.md e
// sql/013_criar_vw_reunioes_salesforce.sql no repo Projeto Dados Snow.
//
// Limitações conhecidas (ver sql/README.md no repo Projeto Dados Snow):
//  - "reunioes" combina duas fontes por causa de um corte real de dados:
//    (a) ANTES de 2026-05-29 (quando o sinal de reunião no Salesforce
//    começa a existir de fato): FATO_REUNIAO_HIST_PLANILHA, carga única
//    (2026-09-01) com grão real de reunião (Reunião ID/Tipo de
//    chamada/Resultado), a partir da planilha original que alimentava o
//    painel antes desta migração (mesma fonte Salesforce, caminho de
//    sincronização diferente -- não é HubSpot).
//    (b) A PARTIR de 2026-05-29: VW_REUNIOES_SALESFORCE (ver acima).
//    Email__c só é preenchido em 61% das ServiceAppointment (2347/3822) --
//    reuniões sem e-mail correspondente a um Lead ficam sem DATA_CRIACAO e só
//    aparecem quando nenhum filtro de Criação está ativo. sdr_responsavel/
//    closer_responsavel não são mapeados (ServiceAppointment só tem OwnerId,
//    sem nome do responsável).
//  - "prioridade" não existe em nenhum objeto do Salesforce -- Forecast
//    roda sem segmentação por prioridade (tudo cai em "(Sem prioridade)").

import snowflake from 'snowflake-sdk';

// Fix conhecido: em serverless (Vercel/Lambda), o filesystem é só-leitura
// exceto /tmp. O snowflake-sdk tenta escrever cache de OCSP/credenciais em
// pastas baseadas em HOME (ex.: ~/.cache/snowflake), que não existem/não são
// graváveis nesse ambiente -- isso derruba a conexão sem lançar um erro que
// chegue ao nosso try/catch. Redireciona pra /tmp, que é gravável.
process.env.HOME = process.env.HOME || '/tmp';
process.env.SF_TEMPORARY_CREDENTIAL_CACHE_DIR = '/tmp';
process.env.SF_OCSP_RESPONSE_CACHE_DIR = '/tmp';
snowflake.configure({ ocspFailOpen: true });

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
    complemento_estrategia: str(r.COMPLEMENTO_ESTRATEGIA), // só populado em vendas (VW_VENDAS_SALESFORCE) -- ver passGlobalVendas() no painel
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

function mapLead(r) {
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
    aporte_mensal_grupo: '', // não existe no objeto Lead
    adv_patrimonio_validado: str(r.PATRIMONIO_VALIDADO),
    valor: '', // Lead não tem valor de negócio (isso só existe após conversão em Opportunity)
    data_criacao: str(r.DATA_CRIACAO),
    data_venda: '', // Lead não vende -- vendas vêm de VW_FATO_NEGOCIO_COMBINADO (mapNegocio)
    sdr_responsavel: '', // não existe no objeto Lead
    closer_responsavel: '', // não existe no objeto Lead
    etapa_do_negocio: str(r.STAGE_NAME), // Status do Lead (Novo/Trabalhando/Convertido/Descartado), não StageName de Opportunity
    prioridade: '', // não existe no Salesforce -- confirmado em 2026-09-01
  };
}

function mapReuniaoSalesforce(r) {
  return {
    negocio_id: r.NEGOCIO_ID,
    email: str(r.EMAIL),
    funil: str(r.FUNIL),
    estrategia: str(r.ESTRATEGIA),
    deal_utm_source: '', // não existe no ServiceAppointment
    fonte_original_pipe: '', // não existe no ServiceAppointment
    canal_originador: str(r.CANAL),
    sdr_responsavel: '', // ServiceAppointment só tem OwnerId (sem nome) -- não mapeado
    closer_responsavel: '', // idem
    data_criacao: str(r.DATA_CRIACAO), // data de criação do LEAD (via join por e-mail na view), não da própria reunião
    data_da_atividade: str(r.DATA_ATIVIDADE),
    status_reuniao: str(r.STATUS_REUNIAO),
    tipo_reuniao: str(r.TIPO_REUNIAO) || 'Reunião',
  };
}

function mapReuniaoHistorica(r) {
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
    data_criacao: str(r.DATA_CRIACAO),
    data_da_atividade: str(r.DATA_ATIVIDADE || r.DATA_CRIACAO),
    status_reuniao: str(r.STATUS_REUNIAO),
    tipo_reuniao: str(r.TIPO_REUNIAO) || 'Reunião',
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
      SDR_RESPONSAVEL, CLOSER_RESPONSAVEL
    FROM VW_FATO_NEGOCIO_COMBINADO
  `);

  // "Vendas" vem de VW_VENDAS_SALESFORCE (2026-09-09), que lê direto o objeto
  // Opportunity do Salesforce filtrado pela lógica que o Rafael validou:
  // StageName=Ganho, RecordType=Consultoria, Produto=Fee Fixo, DataInicioContrato
  // > 2026-07-13. Antes vinha de VW_FATO_NEGOCIO_COMBINADO filtrando só
  // STAGE_NAME='Ganho', sem os filtros de RecordType/Produto -- misturava
  // oportunidades ganhas de outras áreas da Suno (ex.: RecordType='Checkout'
  // sozinho tem 66 mil linhas em Ganho). Validado: 117 registros, R$
  // 91.983.489,00 de patrimônio validado, bate exato com o relatório
  // [Marketing] Vendas de Consultoria do Salesforce. Ver sql/README.md e
  // sql/012_criar_vw_vendas_salesforce.sql no repo Projeto Dados Snow.
  const vendaRows = await query(`
    SELECT
      NEGOCIO_ID, EMAIL, FUNIL, ESTRATEGIA, COMPLEMENTO_ESTRATEGIA, STAGE_NAME,
      FONTE_AQUISICAO, CANAL, UTM_SOURCE, UTM_MEDIUM, UTM_CAMPAIGN,
      PATRIMONIO_DECLARADO, PATRIMONIO_VALIDADO,
      TO_VARCHAR(DATA_CRIACAO, 'YYYY-MM-DD') AS DATA_CRIACAO,
      TO_VARCHAR(DATA_VENDA, 'YYYY-MM-DD') AS DATA_CONTRATACAO
    FROM VW_VENDAS_SALESFORCE
  `);
  const vendas = vendaRows.map(mapNegocio);

  const negociacao = negocioRows.filter(r => r.ETAPA_FUNIL === 'Opportunity').map(mapNegocio);

  // "Leads" = objeto Lead do Salesforce (Data Cloud), não Opportunity -- bate com o
  // relatório [Marketing] Leads - Consultoria (validado em 2026-09-08: 10022 vs 10290,
  // diferença = lag de sync do share). Ver sql/README.md e sql/011_criar_vw_leads_salesforce.sql
  // no repo Projeto Dados Snow.
  const leadRows = await query(`
    SELECT
      NEGOCIO_ID, EMAIL, FUNIL, ESTRATEGIA, STAGE_NAME,
      FONTE_AQUISICAO, CANAL, UTM_SOURCE, UTM_MEDIUM, UTM_CAMPAIGN,
      PATRIMONIO_DECLARADO, PATRIMONIO_VALIDADO,
      TO_VARCHAR(DATA_CRIACAO, 'YYYY-MM-DD') AS DATA_CRIACAO
    FROM VW_LEADS_SALESFORCE
  `);
  const leads = leadRows.map(mapLead);

  const reuniaoHistRows = await query(`
    SELECT
      NEGOCIO_ID, EMAIL, FUNIL, ESTRATEGIA, UTM_SOURCE, FONTE_AQUISICAO, CANAL,
      SDR_RESPONSAVEL, CLOSER_RESPONSAVEL, STATUS_REUNIAO, TIPO_REUNIAO,
      TO_VARCHAR(DATA_ATIVIDADE, 'YYYY-MM-DD"T"HH24:MI:SS') AS DATA_ATIVIDADE,
      TO_VARCHAR(DATA_CRIACAO, 'YYYY-MM-DD"T"HH24:MI:SS') AS DATA_CRIACAO
    FROM FATO_REUNIAO_HIST_PLANILHA
  `);

  // Reuniões (a partir de 2026-05-29) vêm de VW_REUNIOES_SALESFORCE (2026-09-09),
  // que lê direto o objeto ServiceAppointment do Salesforce (Scheduler) -- confirmado
  // pelo vendor como o objeto real de reunião comercial, bem melhor que a antiga
  // aproximação via campos da Opportunity (StatusReuniao_c__c/BotConfirmou/
  // Data1ReuniaoQualificacao). DATA_CRIACAO na view é a data de criação do LEAD
  // (join por e-mail dentro da própria view), não da ServiceAppointment -- isso faz
  // o filtro global de "Criação" do painel implementar coorte real (dos leads
  // gerados num dia, quantos tiveram reunião), como pedido pelo Rafael. Validado:
  // para leads de 2026-09-01, 30 leads com reunião marcada e 8 com realizada (vs
  // 36/10 que a lógica antiga via Opportunity mostrava). Limitação conhecida:
  // Email__c só é preenchido em 61% das ServiceAppointment -- reuniões sem e-mail
  // correspondente a um Lead ficam sem DATA_CRIACAO e só aparecem quando nenhum
  // filtro de Criação está ativo. sdr_responsavel/closer_responsavel não mapeados
  // (ServiceAppointment só tem OwnerId, sem nome). Ver sql/README.md e
  // sql/013_criar_vw_reunioes_salesforce.sql no repo Projeto Dados Snow.
  const reuniaoSFRows = await query(`
    SELECT
      NEGOCIO_ID, EMAIL, FUNIL, ESTRATEGIA, CANAL, STATUS_REUNIAO, TIPO_REUNIAO,
      TO_VARCHAR(DATA_CRIACAO, 'YYYY-MM-DD') AS DATA_CRIACAO,
      TO_VARCHAR(DATA_ATIVIDADE, 'YYYY-MM-DD"T"HH24:MI:SS') AS DATA_ATIVIDADE
    FROM VW_REUNIOES_SALESFORCE
  `);
  const reunioes = [...reuniaoHistRows.map(mapReuniaoHistorica), ...reuniaoSFRows.map(mapReuniaoSalesforce)];

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
