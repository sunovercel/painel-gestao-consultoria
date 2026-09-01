# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Estrutura do projeto

Arquivo único: `index.html` (~2.900 linhas) + um endpoint serverless
`api/data.js`. Sem build, sem framework. **Nunca criar arquivos separados
de CSS/JS para o painel em si** — todo o código de UI/lógica de negócio
vive no `index.html`; `api/` é só a camada de acesso a dado.

Há também um job de email diário em `scripts/` (Node.js, independente do painel).

Dependências:
- Chart.js 4.4.0 (CDN) — gráficos de barras/linha
- `snowflake-sdk` (npm, `package.json` na raiz) — usado só por `api/data.js`

## Desenvolvimento local

```bash
vercel dev
# acesse http://localhost:3000
```

Precisa do `vercel dev` (ou equivalente com suporte a `/api`), não um
servidor HTTP estático puro — o painel busca dados de `/api/data`, que é
uma função serverless que conecta no Snowflake (precisa das env vars
`SNOWFLAKE_*`, ver seção "Fonte de dados").

## Deploy

- GitHub: `demetriuslima-collab/painel-gestao-consultoria` (público)
- Vercel: deploy automático a cada push em `main`
- **Sempre passar a URL de produção** para usuários — URLs de preview do Vercel (`*-hash.vercel.app`) congelam na versão do deploy
- **Deployment Protection:** desativado — não reativar, bloqueia usuários após limparem cookies
- Env vars necessárias na Vercel: `SNOWFLAKE_ACCOUNT`, `SNOWFLAKE_USER`,
  `SNOWFLAKE_PASSWORD`, `SNOWFLAKE_WAREHOUSE`, `SNOWFLAKE_ROLE` (role
  dedicada de leitura em `ANALYTICS.CONSULTORIA` -- nunca `ACCOUNTADMIN`)

## Fonte de dados

**Migrado em 2026-09-01** do CSV público do Google Sheets para o Snowflake
(`ANALYTICS.CONSULTORIA`, alimentado pelo Salesforce via Data Cloud). O
painel busca `GET /api/data`, que devolve
`{ leads, reunioes, vendas, metaCaptacao, metaLeads, negociacao, tombamentos }`
já nas chaves canônicas que `COL_ALIASES` documenta -- o resto do código
(filtros, funil, cohort, forecast, pivot) não sabe a diferença.
Schema/carga em `sql/` no repo `Projeto Dados Snow` (`001_schema_consultoria.sql`,
`003_stage_load_consultoria.sql`, `004_load_metas.sql`) -- ver `sql/README.md`
lá para o histórico completo da migração e limitações conhecidas:

- **Reuniões é aproximada** -- não existe objeto de Task/Event/Meeting no
  Salesforce; cada linha é 1 negócio com indício de reunião, não 1 reunião
  real (sem "Tipo de chamada e reunião" real, sem múltiplas reuniões por negócio).
- **Forecast roda sem "Prioridade"** -- esse campo não existe em nenhum
  objeto do Salesforce; tudo cai em "(Sem prioridade)".
- **Metas (Leads/Captação) são carga manual** -- não vêm do Salesforce,
  precisam ser recarregadas (`004_load_metas.sql`) quando a planilha de
  planejamento for atualizada.
- Os negócios com `etapa_do_negocio` vindos de Lead podem estar
  desatualizados enquanto a view `Lead_Home__dll` (fonte no Salesforce
  Data Cloud) estiver quebrada do lado deles -- ver `sql/README.md`.

A antiga planilha Google Sheets (`SHEET_ID =
1nBsorlQR29Ub_KFmr-QW2O2fi1lPKUuBIRvEKC1m8PU`) continua existindo como
referência histórica, mas não é mais lida pelo painel.

`RAW = { leads, reunioes, vendas, metaCaptacao, metaLeads, negociacao, tombamentos }`.

## Arquitetura do código (seções do script)

Números de linha mudam a cada edição — **buscar pelo nome da função**. Ordem no arquivo:

- **AUTH** — `USERS`, `setupLogin()`, `logout()`
- **CONFIG** — `SHEET_ID`, `sheetURL`, `PALETTE`, `FUNNEL_CLR`
- **RUNTIME STATE** — `RAW` (6 bases), `SEL` (filtros globais multi-select), `F` (datas), `STATE` (aba ativa, sub-views, toggles de tempo, `forecastFactors`, `forecastEtapa`, `pivotDims/pivotSort/…`)
- **Flags auto-detectadas** — `DATE_FMT`, `VENDA_DATE_FMT`, `META_DATE_FMT`, `TOMB_DATE_FMT`, `REUNIAO_STATUS_KEY`, `SDR_IN_LEADS`, `SDR_IN_REUNIOES`, `CLOSER_IN_REUNIOES`, `TIPO_IN_REUNIOES`, `TIPO_REUNIAO_TOTAL`
- **UTILITIES** — `normalizeKey`, `COL_ALIASES`, `normalizeRow`, `parseDate`, `parseNum`, `parseTaxa`, `parsePLImplantado`, `tombValor`, `parsePatrimonio`, `monthKey/monthLabel`
- **DATA LOADING** — `fetchSheet`, `loadData` (abas `Negociação` e `tombamentos` defensivas)
- **DETECÇÃO** — `detectDateFormat` (DATE/VENDA/META/TOMB), `detectReuniaoStatus`, `detectSdrCloserColumns`
- **FILTERING** — `passGlobal` (leads/reuniões), `passSdrCloser` (SDR/Closer/Tipo, defensivo), `passGlobalVendas`, `passGlobalNegociacao`, `emailsTipoRealizadas`, `filteredLeads/Reuniones/Vendas/Negociacao`, `filteredTombados` (funil), `filteredTombamentos` (aba Tombamento) + `TOMB_BREAKDOWNS`/`tombDimValue`
- **MULTI-SELECT** — `MS_CFG`, `buildAllMS`, `populateAllFilters`
- **METAS** — `metaPeriodo` (metas seguem o filtro ativo; sem filtro = mês atual), `calcMetaCaptacao` (segue `F.vdi/F.vdf`), `calcMetaLeads` (segue `F.di/F.df`)
- **RENDER DISPATCH** — `render()` → funil / leads / vendas / tombamento / cohort / reunioes / forecast / pivot / ia
- **FUNIL** — `renderFunil` (dispatcher Geral/Comparativo), `renderFunilGeral` (com etapa "Tombados" se a base existir), `renderFunilComparativo`
- **DIÁRIA DE LEADS** — `PATRIMONIO_ORDER`, `orderLeadGroups`, `renderLeads/Table/Chart`
- **DIÁRIA DE VENDAS** — `renderVendas` (dispatcher), `renderVendasCaptacao/Origem/Breakdown`, `renderVendasChart/BreakdownChart`, `VENDAS_BREAKDOWNS`
- **TOMBAMENTO** — `renderTombamento` (dispatcher por `STATE.tombScope`), `renderTombamentoResumo/BreakdownTbl/Chart`, `computeTombAlertas`, `renderTombAlertas`, `applyTombDatePreset`
- **REUNIÕES** — `renderReunioes` (eixo `data_da_atividade`; dedup por email+tipo)
- **FORECAST** — `FORECAST_PRIOS`, `prioKey`, `renderForecast/computeAndRenderForecast/renderForecastEtapaChips`
- **COHORT** — `renderCohort` (dispatcher por `STATE.cohortView`), `renderCohortLeads` (clássica, intocada), `renderCohortTombamento` (3 tabelas), `fmtR$c`
- **CHART HELPERS** — `buildDayAxis`, `buildTimeAxis` (dia/semana/mês), `chartOpts`, `destroyChart`
- **TABELA DINÂMICA (pivot)** — `PIVOT_DIMS`, `PIVOT_DIM_SEL_KEY`, `PIVOT_SORT_VAL`, `buildPivotTree`, `orderPivotChildren`, `renderPivot/renderPivotArea/renderPivotRows`, `togglePivotDim`
- **EVENT LISTENERS + INIT** — `bindEvents`, `init`, `refreshData`
- **IA CHAT** — `buildDataContext`, `renderMarkdown`, `appendChatMsg`, `submitAI`, `clearAIChat`

## Quirks críticos de dados

### Normalização de colunas
`normalizeRow()` aplica `normalizeKey()` (lowercase, sem acentos, underscores) em cada chave, depois mapeia para chaves canônicas via `COL_ALIASES`. Ao adicionar suporte a uma nova coluna da planilha, adicionar o alias no objeto `COL_ALIASES`.

### Detecção de formato de data
**Desde a migração para Snowflake (2026-09-01), `api/data.js` manda todas as
datas em ISO (`YYYY-MM-DD`)** -- `parseDate` trata ISO direto, sem
ambiguidade, então os detectores abaixo praticamente não encontram mais
nada pra detectar (ficam nos valores de fallback) e isso é esperado, não é
bug. A lógica ficou no código como estava (não removida) porque ainda é a
via de segurança caso algum dado volte a chegar em formato `N/N/YYYY`.
Bases diferentes vêm em formatos diferentes (o Google Sheets exporta MDY em algumas, e as abas de Metas são preenchidas manualmente em DMY). Por isso há **quatro detectores independentes** (em `detectDateFormat`, heurística: dígito `>12` desambigua):
- `DATE_FMT` — detectado de leads/reuniões (MDY nesta planilha)
- `VENDA_DATE_FMT` — específico da coluna `data_venda`
- `META_DATE_FMT` — específico da coluna `data` das abas de Metas (**DMY**; fallback DMY)
- `TOMB_DATE_FMT` — específico de `data_de_implantacao` da aba tombamentos (**DMY** `dd/mm/yyyy`; fallback DMY)

Sempre passar o formato certo no `parseDate`: `parseDate(row.data_venda, VENDA_DATE_FMT)`, `parseDate(m.data, META_DATE_FMT)`, `parseDate(r.data_de_implantacao, TOMB_DATE_FMT)`. ⚠️ Esquecer o `META_DATE_FMT` faz as metas caírem no mês errado (bug já corrigido — a linha de meta e a "meta até a data" dependem disso). `data_da_atividade` (Reuniões) vem em `YYYY-MM-DD HH:MM`, sem ambiguidade. A coluna canônica `data_venda` vem de **"Consultoria - Data da contratação"** (alias em `COL_ALIASES`) e hoje chega em ISO `YYYY-MM-DD` — `parseDate` trata ISO direto.

### Base tombamentos (regras críticas de parsing)
- Colunas: `nome, email, taxa_de_adm, data_de_implantacao, pl_na_data_de_implantacao`. A coluna de PL foi **renomeada** na revisão de 2026-07 — `COL_ALIASES` mantém o nome antigo `pl_total_implantado_via_api` como chave canônica no código.
- **PL** (`parsePLImplantado`): valor em **reais puros, sem separadores** (`"4989768"` = R$ 4.989.768) → `parseNum` direto. ⚠️ NUNCA reintroduzir a regra antiga de dividir por 1000 (valia só para o formato quebrado anterior à revisão). Sanidade: mediana ~R$ 600k, teto plausível ~R$ 20M por cliente.
- **Taxa** (`parseTaxa`): vem como `"1,00%"` → fração (0,01). `parseNum` NÃO trata `%` — nunca usar nela. Máximo esperado: 1%.
- **Valor = PL × taxa** (`tombValor`), calculado no dash — a coluna `valor` da planilha (fórmula quebrada) foi removida e nunca é lida.
- **Regra global**: em todas as visões (funil, cohort, aba Tombamento escopo padrão), só entram tombamentos cujo **email aparece na aba Vendas** (match normalizado). A única exceção é o escopo "Todos os Tombamentos" da aba.

### Patrimônio validado
Usar sempre `parsePatrimonio()`, nunca `parseNum()` direto:
```js
parsePatrimonio(v.adv_patrimonio_validado || v.patrimonio_validado)
```
`parsePatrimonio` multiplica por 1.000 valores < 10.000 (alguns registros estão abreviados, ex: `600` = R$ 600.000).

A coluna canônica é `adv_patrimonio_validado` (de `[ADV] Patrimônio validado` na planilha). O alias `patrimonio_validado` é fallback.

### Reuniões realizadas
`REUNIAO_STATUS_KEY` é detectado automaticamente em `detectReuniaoStatus()` — busca qual coluna da aba Reuniões contém valores como "concluido"/"realizada". Usar sempre `isRealizada(r)`, nunca comparar a coluna diretamente.

### Deduplicação de reuniões (dois modos, intencionais)
- **Funil / demais views** (`filteredReuniones()`): deduplica por **email** (1 reunião por contato). Consequência: ao filtrar por Tipo de Reunião, um contato com reuniões de tipos diferentes é contado só uma vez (absorvido) — não é bug.
- **Aba Reuniões** (`renderReunioes`): deduplica por **email + tipo** (conta o mesmo contato de novo quando o tipo de chamada/reunião difere). Não usa `filteredReuniones` (que dedupla só por email).

### Origem Base vs Origem Suno
`isOrigemBase(row)` retorna `true` quando `fonte_original_pipe` é `'prospeccao consultor'` (comparação normalizada, sem acentos).
MGM entra em **Origem Suno** (não é Origem Base).

### Aba Vendas tem campo `funil` próprio
A aba Vendas da planilha possui coluna `funil` diretamente — não fazer join por email com leads para obter o funil. `passGlobalVendas` filtra por `row.funil` e `buildDataContext()` usa `row.funil` no cross-tab mensal. Nunca usar email-join para derivar funil nas vendas; os números ficam incorretos.

## Filtros

**Globais** (topo, valem em todas as abas) — multi-select via `SEL` + `MS_CFG`: Source, Estratégia, Funil, Patrimônio (`patrimonio_investido_grupo`), Fonte Orig., Canal Orig., Closer, SDR, Tipo de Reunião. Mais o range de data de **criação** (`F.di/F.df` sobre `data_criacao`).

**Detecção defensiva** (`detectSdrCloserColumns`): filtros de colunas que podem não existir em todas as bases só "ligam" onde a coluna existe (flags `*_IN_*`), sem quebrar antes de a coluna ser adicionada. Regras (via `passSdrCloser` / `passGlobalVendas`):
- **SDR**: filtra leads + reuniões + vendas.
- **Closer**: filtra reuniões + vendas, **nunca leads** (regra de negócio — closer só atua da reunião em diante, mesmo que a coluna exista em leads). No Funil, ao filtrar closer os **Leads ficam cheios** e só marcadas/realizadas/vendas caem (intencional).
- **Tipo de Reunião** (`tipo_reuniao` = coluna "Tipo de chamada e reunião", só em Reuniões): filtra reuniões direto; **vendas por cruzamento de e-mail** (`emailsTipoRealizadas`) — só vendas cujo e-mail bate com reunião REALIZADA do(s) tipo(s). "Todos" selecionado = sem restrição (`size < TIPO_REUNIAO_TOTAL`). E-mails montados de `RAW.reunioes` **sem dedup**.

**Específicos de aba**: Diária de Vendas → range de data de **venda** (`F.vdi/F.vdf`); Reuniões → data da **atividade** (`F.rai/F.raf`); Tombamento → data de **implantação** (`F.tdi/F.tdf`); Forecast → **Etapa do negócio** (`STATE.forecastEtapa`, chips).

**Metas seguem o filtro ativo** (`metaPeriodo`): sem filtro de data = mês atual (comportamento original); com filtro, a meta soma o período filtrado — meta de leads segue `F.di/F.df` (criação), meta de captação segue `F.vdi/F.vdf` (venda).

## Abas / Views

- **Funil**: sub-abas "Visão Geral" e "Comparativo por Período" (mês/semana por data de criação, tendência ▲/▼). Se a base tombamentos existir, a Visão Geral ganha a 5ª etapa **"Tombados"** (= tombamentos cujo email casa com venda filtrada, dedup por email) com card, barra e KPI Vendas → Tombados.
- **Diária de Leads**: metas + gráfico stacked; breakdown por Funil/Estratégia/Source/Fonte/Canal/**Patrimônio** (faixas em ordem monetária); toggle Diário/Mensal.
- **Diária de Vendas**: sub-views Metas Captação / Origem (Suno claro, Base escuro) / breakdowns (Source/Funil/Estratégia/Fonte/Closer); toggle Diário/Mensal.
- **Tombamento**: seletor de base (`STATE.tombScope`) — **Base Vendas** (padrão: match com as vendas FILTRADAS → a barra de filtros global vale na aba), **Todos os Tombamentos** (única visão com a base completa; ignora filtros globais; sem match, a dimensão vira "(Sem venda)") e **⚠ Alertas** (qualidade da base completa: clientes fora de Vendas com PL, linhas sem email, PL em branco/zerado, PL sem data, taxa >1,5%, + linha de união sem dupla contagem; esconde gráfico/estratificação). Estratificações como na Diária de Vendas (Resumo/Origem/Source/Funil/Estratégia/Fonte/Closer) com **dimensões herdadas da venda casada por email** (primeira venda); gráfico por `data_de_implantacao` com toggles PL ↔ Valor (PL × Taxa) e Diário/Mensal.
- **Reuniões**: volume por `data_da_atividade`; toggle Dia/Semana/Mês; empilhamento por 7 parâmetros; dedup email+tipo; seletor global de modo de contagem (Negócio/Contato/Email+Tipo, `STATE.reuniaoCountMode`).
- **Cohort (Safra)**: toggle `STATE.cohortView` — **Leads → Vendas** (clássica, conversão por mês de criação; código intocado em `renderCohortLeads`) e **Vendas → Tombamento** (`renderCohortTombamento`, 3 tabelas: **Quantidade** — safra = mês da 1ª venda do email, dedup por email, %M0/M+1/M+2; **Valor (PL × Taxa)**; **PL Validado → Implantado** — base = patrimônio validado das vendas do mês, % implantado. Match por email; implantação anterior ao mês da safra fica fora (anomalia); card-sub mostra reconciliação com o funil).
- **Tabela Dinâmica (pivot)**: funil L→M→R→V por parâmetros hierárquicos (drilldown), data mês/semana/dia. Cabeçalho **ordenável por clique** (desc↔asc, `PIVOT_SORT_VAL`). Filtro global restringe a dimensão correspondente (`PIVOT_DIM_SEL_KEY`).
- **Forecast**: projeção de `RAW.negociacao` — conta clientes e soma patrimônio por **Prioridade** (Alta/Média/Baixa) × **fatores editáveis** (`STATE.forecastFactors`, padrão 60/25/5%). Duas tabelas (qtd e patrimônio) + cards. Prioridade fora do padrão → "(Sem prioridade)" com fator 0.

**Toggles de tempo dos gráficos**: `buildTimeAxis(dates, di, df, mode)` — `'dia'` (cap 180d), `'semana'` (segunda a domingo, cap 53), `'mes'` (cap 24m). Linha de Meta somada por bucket.

## Email Diário Automático

Cron via GitHub Actions com 3 tentativas (`43 8,10,12 * * *` UTC = 05:43/07:43/09:43 BRT), pois o agendamento `schedule` do GitHub Actions tem atraso variável (~1h30 a 7h+, observado). A primeira tentativa mira entrega por volta das 09h BRT — não é uma garantia exata. Um job `guard` consulta a API de Actions e pula as tentativas seguintes se uma anterior já enviou o e-mail de hoje com sucesso, evitando duplicidade. Script em `scripts/daily-email.js`.

**Arquitetura:**
```
GitHub Actions → scripts/daily-email.js
  ├── fetchSheets()        — lê as 5 abas do Google Sheets via PapaParse (Node)
  ├── aggregateYesterday() — filtra pelo dia anterior, agrega métricas
  ├── generateAnalysis()   — Claude Haiku gera análise (fetch direto, sem SDK)
  └── sendEmail()          — SendGrid API v3 (fetch direto, sem SDK)
```

**Secrets no GitHub** (nunca hardcoded):
- `ANTHROPIC_KEY` — mesma usada no Vercel
- `SENDGRID_API_KEY` — permissão Mail Send
- `EMAIL_FROM` — remetente verificado no SendGrid
- `EMAIL_RECIPIENTS` — lista separada por vírgula

**Testar manualmente:** Actions → Daily Commercial Summary → Run workflow → campo `yesterday_override: YYYY-MM-DD`

**Dependências:** apenas `papaparse` npm (em `scripts/package.json`). Anthropic e SendGrid via `fetch` nativo do Node 24.

**Quirks:**
- `YESTERDAY_OVERRIDE` env var permite sobrescrever a data para testes
- Utilities (`normalizeKey`, `COL_ALIASES`, `parseDate`, `parsePatrimonio`, etc.) são portadas de `index.html` — manter em sincronia se houver mudanças críticas
- Erro no Anthropic → email enviado sem seção de análise (não bloqueia)
- Erro no SendGrid → `process.exit(1)` (Actions marca o job como falha)

## Aba Pergunte à IA

- Chamada via proxy Vercel `api/ask.js` — evita CORS browser → Anthropic
- Modelo: `claude-haiku-4-5-20251001`; max_tokens: 1500
- **API key em variável de ambiente Vercel** (`ANTHROPIC_KEY`) — **nunca hardcoded** no código ou git (Anthropic revoga automaticamente chaves expostas em repos públicos)
- `AI_CHAT[]` mantém histórico multi-turn; limpo pelo botão "✕ Limpar conversa"
- `buildDataContext()` envia ao modelo: totais por dimensão + cross-tabs mensais e diários (leads, reuniões, vendas) — **não envia linhas brutas** para evitar 413 no Vercel
- `submitAI()` tem guard: se `RAW.leads`, `RAW.reunioes` e `RAW.vendas` estiverem todos vazios, exibe aviso "dados carregando" sem chamar a API
- `renderMarkdown()` converte markdown da IA para HTML nas bolhas do chat
- System prompt inclui: data de hoje/ontem via JS, contexto Suno (ICP, funis, regras), instrução de resposta direta

## Multi-select dropdowns

O painel permanece aberto ao selecionar opções — isso é intencional. Implementado com `panel.addEventListener('click', e => e.stopPropagation())`. Não remover.

## Painel de debug

Clicar no ícone 🔧 no header mostra diagnóstico: formato de data detectado (leads e vendas separados), amostra de datas parseadas, coluna de reunião detectada, totais de patrimônio. Usar para diagnosticar problemas de parsing antes de alterar código.

## Autenticação

Credenciais hardcoded em `USERS` (~linha 416). Sessão via `sessionStorage` (chave `suno_dash_auth`). Limitação conhecida e aceita para uso interno.

## Design system

- Cor primária: `#C82526` (vermelho Suno), variável CSS `--red`
- Fundo: `#F5F7FA`, cards brancos com borda `#E8E8E8`
- Sidebar: 220px, sticky abaixo do header
- Responsivo: media query `max-width: 900px` → 2 colunas nos metric cards
