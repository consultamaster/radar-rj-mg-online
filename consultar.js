#!/usr/bin/env node
/**
 * Radar de Distribuições — Recuperação Judicial e Falência (TJMG)
 * ------------------------------------------------------------------
 * Todo dia, reconsulta o PERÍODO INTEIRO (de 2026-01-01 até hoje) numa
 * busca paginada só — em vez de um dia por vez — porque o DataJud às
 * vezes indexa processos com atraso (um processo distribuído em março
 * pode só aparecer na base em julho). Reconsultar tudo garante que
 * esses atrasados sejam capturados no dia em que aparecerem.
 *
 * Fluxo:
 *  1. Busca no DataJud todos os processos de RJ/Falência entre --de e
 *     --ate (padrão: 2026-01-01 até hoje), com paginação.
 *  2. Agrupa os resultados por dia de ajuizamento e regrava
 *     docs/data/AAAA-MM-DD.json para cada dia do período.
 *  3. Regrava docs/data/index.json com a contagem de cada dia do período.
 *  4. Grava docs/data/novos-ultima-consulta.json — só os processos que
 *     nunca tinham sido vistos antes (comparando com visto.json),
 *     independente da data de ajuizamento deles. É o que alimenta a
 *     seção "novos nesta consulta" do painel.
 *  5. Atualiza visto.json (histórico de processos já vistos).
 *
 * Uso:
 *   node consultar.js                                -> período completo (padrão)
 *   node consultar.js --de 2026-07-01 --ate 2026-07-15  -> intervalo específico
 *   node consultar.js --data 2026-07-15              -> um único dia
 *   node consultar.js --comarca "Belo Horizonte"     -> filtra por comarca
 *   node consultar.js --processo 5001234-56.2026.8.13.0024  -> busca 1 processo
 *   node consultar.js --debug                        -> diagnóstico da API
 * ------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------
// CONFIGURAÇÃO
// ---------------------------------------------------------------

// Chave pública oficial do DataJud/CNJ — documentada e divulgada
// publicamente pelo próprio CNJ (a mesma para todos os usuários).
// Se parar de funcionar, confira a chave vigente em:
// https://datajud-wiki.cnj.jus.br/api-publica/acesso
const API_KEY = 'cDZHYzlZa0JadVREZDJCendQbXY6SkJlTzNjLV9TRENyQk1RdnFKZGRQdw==';

const ENDPOINT = 'https://api-publica.datajud.cnj.jus.br/api_publica_tjmg/_search';

// Classes processuais de interesse (Tabela Processual Unificada - CNJ)
//   129 = Recuperação Judicial
//   128 = Recuperação Extrajudicial
//   108 = Falência de Empresários, Sociedades Empresariais, ME e EPP
const CLASSES_DE_INTERESSE = [129, 128, 108];

// Início do período acompanhado por padrão (quando nenhuma data é informada)
const DATA_INICIO_PADRAO = '2026-01-01';

const TAMANHO_PAGINA = 200;

const ARQ_HISTORICO = path.join(__dirname, 'visto.json');
const DIR_DADOS = path.join(__dirname, 'docs', 'data');
const ARQ_INDICE = path.join(DIR_DADOS, 'index.json');
const ARQ_NOVOS = path.join(DIR_DADOS, 'novos-ultima-consulta.json');

// ---------------------------------------------------------------
// DATAS
// ---------------------------------------------------------------

function dataISO(diasAtras = 0) {
  const d = new Date();
  d.setDate(d.getDate() - diasAtras);
  return d.toISOString().split('T')[0]; // AAAA-MM-DD
}

function proximoDia(dataStr) {
  const d = new Date(`${dataStr}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0];
}

// Aceita tanto "AAAA-MM-DD" quanto "DD/MM/AAAA" (formato brasileiro comum
// de digitar sem querer) e sempre devolve "AAAA-MM-DD".
function normalizarData(valor) {
  if (!valor) return valor;
  const match = valor.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (match) {
    const [, dia, mes, ano] = match;
    return `${ano}-${mes}-${dia}`;
  }
  return valor;
}

// A API do DataJud guarda dataAjuizamento como "AAAAMMDDHHmmss" (sem
// separadores). Para filtrar por período, convertemos os limites pra
// esse mesmo formato — senão a busca não dá erro, mas também não acha nada.
function paraCompacto(dataISOStr) {
  return `${dataISOStr.replace(/-/g, '')}000000`;
}

// Converte "AAAAMMDDHHmmss" (formato bruto da API) pra "AAAA-MM-DDTHH:mm:ss"
function compactoParaISO(bruto) {
  if (!bruto || typeof bruto !== 'string' || bruto.length < 14) return bruto;
  const ano = bruto.slice(0, 4);
  const mes = bruto.slice(4, 6);
  const dia = bruto.slice(6, 8);
  const hora = bruto.slice(8, 10);
  const min = bruto.slice(10, 12);
  const seg = bruto.slice(12, 14);
  return `${ano}-${mes}-${dia}T${hora}:${min}:${seg}`;
}

// "AAAAMMDD..." -> "AAAA-MM-DD" (só a parte do dia)
function extrairDia(bruto) {
  if (!bruto || typeof bruto !== 'string' || bruto.length < 8) return null;
  return `${bruto.slice(0, 4)}-${bruto.slice(4, 6)}-${bruto.slice(6, 8)}`;
}

function aguardar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------
// ARGUMENTOS DE LINHA DE COMANDO
// ---------------------------------------------------------------

function lerArgumentos() {
  const args = process.argv.slice(2);
  const opts = { data: null, de: null, ate: null, comarca: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--data') opts.data = normalizarData(args[++i]);
    if (args[i] === '--de') opts.de = normalizarData(args[++i]);
    if (args[i] === '--ate') opts.ate = normalizarData(args[++i]);
    if (args[i] === '--comarca') opts.comarca = args[++i];
  }
  // Sem nada informado: resync completo, do início do acompanhamento até hoje.
  if (!opts.de && !opts.ate && !opts.data) {
    opts.de = DATA_INICIO_PADRAO;
    opts.ate = dataISO(0);
  }
  // --data sozinho equivale a --de X --ate X (um único dia)
  if (opts.data && !opts.de && !opts.ate) {
    opts.de = opts.data;
    opts.ate = opts.data;
  }
  return opts;
}

// ---------------------------------------------------------------
// HISTÓRICO (para saber o que já foi visto antes, e marcar "novo")
// ---------------------------------------------------------------

function carregarHistorico() {
  if (!fs.existsSync(ARQ_HISTORICO)) return new Set();
  const dados = JSON.parse(fs.readFileSync(ARQ_HISTORICO, 'utf-8'));
  return new Set(dados);
}

function salvarHistorico(set) {
  fs.writeFileSync(ARQ_HISTORICO, JSON.stringify([...set], null, 2));
}

// ---------------------------------------------------------------
// CONSULTA À API DATAJUD (com nova tentativa automática em falhas)
// ---------------------------------------------------------------

async function requisitar(body, tentativa = 1) {
  let resp;
  try {
    resp = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `APIKey ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // Falha de conexão (não chegou a ter resposta HTTP)
    const motivo = (err.cause && (err.cause.code || err.cause.message)) || err.message;
    if (tentativa <= 5) {
      const espera = 3000 * tentativa;
      console.log(`  Falha de conexão (${motivo}) — tentando de novo em ${espera / 1000}s (tentativa ${tentativa}/5)...`);
      await aguardar(espera);
      return requisitar(body, tentativa + 1);
    }
    throw new Error(`Falha de conexão com a API DataJud após 5 tentativas: ${motivo}`);
  }

  // A API pública do CNJ tem limite de requisições simultâneas.
  if ((resp.status === 429 || resp.status === 503) && tentativa <= 5) {
    const espera = 2000 * tentativa;
    console.log(`  API ocupada (HTTP ${resp.status}) — tentando de novo em ${espera / 1000}s (tentativa ${tentativa}/5)...`);
    await aguardar(espera);
    return requisitar(body, tentativa + 1);
  }

  if (!resp.ok) {
    const texto = await resp.text();
    throw new Error(`Erro na API DataJud (HTTP ${resp.status}): ${texto}`);
  }

  return resp.json();
}

// Busca TODOS os processos de um período (com paginação), numa consulta
// só — muito mais eficiente do que uma busca por dia.
async function buscarIntervalo(deISO, ateISO, comarca) {
  const gte = paraCompacto(deISO);
  const lt = paraCompacto(proximoDia(ateISO));

  const must = [
    { terms: { 'classe.codigo': CLASSES_DE_INTERESSE } },
    { range: { dataAjuizamento: { gte, lt } } },
  ];
  if (comarca) must.push({ match: { 'orgaoJulgador.nome': comarca } });

  let todos = [];
  let from = 0;
  while (true) {
    const body = {
      size: TAMANHO_PAGINA,
      from,
      sort: [{ dataAjuizamento: { order: 'asc' } }],
      query: { bool: { must } },
    };
    const json = await requisitar(body);
    const hits = (json.hits && json.hits.hits) || [];
    todos = todos.concat(hits);
    if (hits.length > 0) {
      console.log(`  ...${todos.length} processo(s) obtidos até agora`);
    }
    if (hits.length < TAMANHO_PAGINA) break;
    from += TAMANHO_PAGINA;
    await aguardar(500);
  }
  return todos;
}

// ---------------------------------------------------------------
// EXECUÇÃO PRINCIPAL — RESYNC DO PERÍODO
// ---------------------------------------------------------------

async function rodarResync(deISO, ateISO, comarca) {
  console.log(`\nConsultando TJMG — período de ${deISO} até ${ateISO}${comarca ? ` — comarca: ${comarca}` : ''}...`);

  const hits = await buscarIntervalo(deISO, ateISO, comarca);
  const vistos = carregarHistorico();
  const porDia = new Map();
  const novosNestaExecucao = [];

  for (const hit of hits) {
    const p = hit._source;
    const numero = p.numeroProcesso;
    const dia = extrairDia(p.dataAjuizamento);
    if (!dia) continue;

    const ehNovo = !vistos.has(numero);
    const processo = {
      numeroProcesso: numero,
      classeId: p.classe && p.classe.codigo,
      classe: p.classe && p.classe.nome,
      dataAjuizamento: compactoParaISO(p.dataAjuizamento),
      orgaoJulgador: p.orgaoJulgador && p.orgaoJulgador.nome,
      assuntos: (p.assuntos || []).map((a) => a.nome),
      novo: ehNovo,
    };

    if (!porDia.has(dia)) porDia.set(dia, []);
    porDia.get(dia).push(processo);

    if (ehNovo) {
      novosNestaExecucao.push(processo);
      vistos.add(numero);
    }
  }

  if (!fs.existsSync(DIR_DADOS)) fs.mkdirSync(DIR_DADOS, { recursive: true });

  // Regrava um arquivo por dia do período (mesmo os sem processo, com [])
  const diasDoIntervalo = [];
  let atual = deISO;
  while (atual <= ateISO) {
    diasDoIntervalo.push(atual);
    atual = proximoDia(atual);
  }
  for (const dia of diasDoIntervalo) {
    const processosDoDia = porDia.get(dia) || [];
    fs.writeFileSync(path.join(DIR_DADOS, `${dia}.json`), JSON.stringify(processosDoDia, null, 2));
  }

  // Índice: reflete exatamente o período consultado
  const indice = diasDoIntervalo
    .map((dia) => ({ data: dia, total: (porDia.get(dia) || []).length }))
    .sort((a, b) => (a.data < b.data ? 1 : -1));
  fs.writeFileSync(ARQ_INDICE, JSON.stringify(indice, null, 2));

  // Novos descobertos NESTA execução (pode incluir processos com data de
  // ajuizamento antiga, que só agora apareceram na base do CNJ)
  fs.writeFileSync(ARQ_NOVOS, JSON.stringify({
    executadoEm: new Date().toISOString(),
    total: novosNestaExecucao.length,
    processos: novosNestaExecucao,
  }, null, 2));

  salvarHistorico(vistos);

  console.log(
    `\nConcluído: ${hits.length} processo(s) no período, ${novosNestaExecucao.length} novo(s) descoberto(s) nesta execução.`
  );
}

// ---------------------------------------------------------------
// DIAGNÓSTICO
// ---------------------------------------------------------------

async function diagnosticar() {
  console.log('\n=== MODO DIAGNÓSTICO ===\n');

  console.log('1) Testando filtro por classe (sem data)...');
  const json1 = await requisitar({ size: 1, query: { terms: { 'classe.codigo': CLASSES_DE_INTERESSE } } });
  const total1 = json1.hits && json1.hits.total && json1.hits.total.value;
  console.log(`   Total encontrado (todas as datas): ${total1}`);

  console.log('\n2) Pegando 1 processo de exemplo (dentro das classes de interesse)...');
  const json2 = await requisitar({ size: 1, query: { terms: { 'classe.codigo': CLASSES_DE_INTERESSE } } });
  const hit = json2.hits && json2.hits.hits && json2.hits.hits[0];
  if (hit) {
    const src = hit._source;
    console.log('   Campos disponíveis no documento:', Object.keys(src).join(', '));
    console.log('   Exemplo de "classe":', JSON.stringify(src.classe));
    console.log('   Exemplo de "dataAjuizamento":', src.dataAjuizamento);
    console.log('   Exemplo de "orgaoJulgador":', JSON.stringify(src.orgaoJulgador));
  } else {
    console.log('   Nenhum documento retornado.');
  }

  console.log('\n=== FIM DO DIAGNÓSTICO ===\n');
}

async function buscarPorNumero(numero) {
  console.log(`\n=== BUSCANDO PROCESSO ${numero} ===\n`);
  const numeroLimpo = numero.replace(/\D/g, '');
  const json = await requisitar({ size: 1, query: { term: { numeroProcesso: numeroLimpo } } });
  const hit = json.hits && json.hits.hits && json.hits.hits[0];
  if (!hit) {
    console.log('Processo não encontrado nesse índice (pode levar um tempo entre a distribuição real e a indexação no DataJud).');
    return;
  }
  console.log('Documento completo retornado pela API:\n');
  console.log(JSON.stringify(hit._source, null, 2));
}

// ---------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------

async function main() {
  const idxProcesso = process.argv.indexOf('--processo');
  if (idxProcesso !== -1) {
    await buscarPorNumero(process.argv[idxProcesso + 1]);
    return;
  }
  if (process.argv.includes('--debug')) {
    await diagnosticar();
    return;
  }

  const opts = lerArgumentos();
  await rodarResync(opts.de, opts.ate, opts.comarca);
}

main().catch((err) => {
  console.error('Falha na execução:', err.message);
  process.exit(1);
});
