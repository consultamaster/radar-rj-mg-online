#!/usr/bin/env node
/**
 * Radar de Distribuições — Recuperação Judicial e Falência (TJMG e TJSP)
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
 *   node consultar.js                                -> TJMG, período completo (padrão)
 *   node consultar.js --tribunal tjsp                -> TJSP, período completo
 *   node consultar.js --tribunal tjsp --classes      -> lista os códigos de classe (valida 108)
 *   node consultar.js --tribunal tjsp --ultimos      -> 5 processos mais recentes da base
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

// Tribunais suportados. Cada um grava numa pasta própria e tem o seu
// próprio histórico de "já vistos". O TJMG mantém os caminhos originais.
const TRIBUNAIS = {
  tjmg: {
    nome: 'TJMG',
    endpoint: 'https://api-publica.datajud.cnj.jus.br/api_publica_tjmg/_search',
    dirDados: path.join(__dirname, 'docs', 'data'),
    historico: path.join(__dirname, 'visto.json'),
  },
  tjsp: {
    nome: 'TJSP',
    endpoint: 'https://api-publica.datajud.cnj.jus.br/api_publica_tjsp/_search',
    dirDados: path.join(__dirname, 'docs', 'data', 'tjsp'),
    historico: path.join(__dirname, 'visto-tjsp.json'),
  },
};

// Classes processuais de interesse (Tabela Processual Unificada - CNJ)
//   129 = Recuperação Judicial
//   128 = Recuperação Extrajudicial
//   108 = Falência de Empresários, Sociedades Empresariais, ME e EPP
// (confira no log "Distribuição por classe" se o 108 é mesmo Falência)
const CLASSES_DE_INTERESSE = [129, 128, 108];

// Início do período acompanhado por padrão (quando nenhuma data é informada)
const DATA_INICIO_PADRAO = '2026-01-01';

const TAMANHO_PAGINA = 200;

// Tribunal ativo (definido em main) e caminhos derivados dele
let TJ = TRIBUNAIS.tjmg;
let ENDPOINT = TJ.endpoint;
let ARQ_HISTORICO, DIR_DADOS, ARQ_INDICE, ARQ_NOVOS;

function definirTribunal(chave) {
  const t = TRIBUNAIS[chave];
  if (!t) throw new Error(`Tribunal desconhecido: "${chave}". Use: ${Object.keys(TRIBUNAIS).join(', ')}.`);
  TJ = t;
  // DATAJUD_BASE_URL permite apontar para uma API simulada (testes locais).
  ENDPOINT = process.env.DATAJUD_BASE_URL
    ? t.endpoint.replace('https://api-publica.datajud.cnj.jus.br', process.env.DATAJUD_BASE_URL)
    : t.endpoint;
  ARQ_HISTORICO = t.historico;
  DIR_DADOS = t.dirDados;
  ARQ_INDICE = path.join(DIR_DADOS, 'index.json');
  ARQ_NOVOS = path.join(DIR_DADOS, 'novos-ultima-consulta.json');
}
definirTribunal('tjmg');

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
  const opts = { data: null, de: null, ate: null, comarca: null, tribunal: 'tjmg' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--data') opts.data = normalizarData(args[++i]);
    if (args[i] === '--de') opts.de = normalizarData(args[++i]);
    if (args[i] === '--ate') opts.ate = normalizarData(args[++i]);
    if (args[i] === '--comarca') opts.comarca = args[++i];
    if (args[i] === '--tribunal') opts.tribunal = String(args[++i] || '').toLowerCase();
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

const MAX_TENTATIVAS = 8;
const STATUS_TENTAR_DE_NOVO = [429, 500, 502, 503, 504];
const ESPERA_BASE_MS = Number(process.env.ESPERA_BASE_MS || 4000);

// Espera crescente: 4s, 8s, 16s, 32s, 60s, 60s... (limite de 60s)
function esperaDaTentativa(tentativa) {
  return Math.min(60000, ESPERA_BASE_MS * 2 ** (tentativa - 1));
}

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
    if (tentativa < MAX_TENTATIVAS) {
      const espera = esperaDaTentativa(tentativa);
      console.log(`  Falha de conexão (${motivo}) — tentando de novo em ${Math.round(espera / 1000)}s (tentativa ${tentativa}/${MAX_TENTATIVAS})...`);
      await aguardar(espera);
      return requisitar(body, tentativa + 1);
    }
    throw new Error(`Falha de conexão com a API DataJud após ${MAX_TENTATIVAS} tentativas: ${motivo}`);
  }

  // A API pública do CNJ fica sobrecarregada de vez em quando (429/503/504).
  if (STATUS_TENTAR_DE_NOVO.includes(resp.status) && tentativa < MAX_TENTATIVAS) {
    const espera = esperaDaTentativa(tentativa);
    console.log(`  API ocupada (HTTP ${resp.status}) — tentando de novo em ${Math.round(espera / 1000)}s (tentativa ${tentativa}/${MAX_TENTATIVAS})...`);
    await aguardar(espera);
    return requisitar(body, tentativa + 1);
  }

  if (!resp.ok) {
    const texto = (await resp.text()).slice(0, 300);
    throw new Error(`Erro na API DataJud (HTTP ${resp.status}): ${texto}`);
  }

  return resp.json();
}

// Divide o período em blocos de, no máximo, um mês. Cada bloco é paginado
// separadamente — o Elasticsearch do DataJud limita from+size a 10.000
// resultados por consulta, e tribunais grandes (TJSP) podem passar disso
// num período longo.
function dividirEmMeses(deISO, ateISO) {
  const blocos = [];
  let ini = deISO;
  while (ini <= ateISO) {
    const [ano, mes] = ini.split('-').map(Number);
    const ultimoDiaMes = new Date(Date.UTC(ano, mes, 0)).toISOString().split('T')[0];
    const fim = ultimoDiaMes < ateISO ? ultimoDiaMes : ateISO;
    blocos.push([ini, fim]);
    ini = proximoDia(fim);
  }
  return blocos;
}

async function buscarBloco(deISO, ateISO, comarca) {
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
    if (from + TAMANHO_PAGINA > 10000) {
      console.log(`  ATENÇÃO: bloco ${deISO}..${ateISO} passou do limite de 10.000 resultados da API; o restante foi ignorado.`);
      break;
    }
    const body = {
      size: TAMANHO_PAGINA,
      from,
      sort: [{ dataAjuizamento: { order: 'asc' } }],
      query: { bool: { must } },
    };
    const json = await requisitar(body);
    const hits = (json.hits && json.hits.hits) || [];
    todos = todos.concat(hits);
    if (hits.length < TAMANHO_PAGINA) break;
    from += TAMANHO_PAGINA;
    await aguardar(500);
  }
  return todos;
}

// Tempo máximo total gasto em consultas (evita ficar horas esperando uma
// API sobrecarregada). Depois disso, os meses restantes ficam para a próxima.
const PRAZO_MAXIMO_MS = Number(process.env.PRAZO_MAXIMO_MS || 35 * 60 * 1000);

// Busca TODOS os processos do período, mês a mês. Se um mês falhar mesmo
// depois das novas tentativas, ele é registrado em "falhas" e os demais
// continuam — assim um problema do CNJ num mês não perde o resto.
async function buscarIntervalo(deISO, ateISO, comarca) {
  const inicio = Date.now();
  let todos = [];
  const falhas = [];
  for (const [ini, fim] of dividirEmMeses(deISO, ateISO)) {
    if (Date.now() - inicio > PRAZO_MAXIMO_MS) {
      console.log(`  ${ini} a ${fim}: PULADO (tempo máximo atingido)`);
      falhas.push([ini, fim]);
      continue;
    }
    try {
      const hits = await buscarBloco(ini, fim, comarca);
      todos = todos.concat(hits);
      console.log(`  ${ini} a ${fim}: ${hits.length} processo(s) (acumulado: ${todos.length})`);
    } catch (err) {
      console.log(`  ${ini} a ${fim}: FALHOU — ${err.message.split('\n')[0]}`);
      falhas.push([ini, fim]);
    }
    await aguardar(1000);
  }
  return { hits: todos, falhas };
}

// ---------------------------------------------------------------
// EXECUÇÃO PRINCIPAL — RESYNC DO PERÍODO
// ---------------------------------------------------------------

async function rodarResync(deISO, ateISO, comarca) {
  console.log(`\nConsultando ${TJ.nome} — período de ${deISO} até ${ateISO}${comarca ? ` — comarca: ${comarca}` : ''}...`);

  const { hits, falhas } = await buscarIntervalo(deISO, ateISO, comarca);
  const diaEmFalha = (dia) => falhas.some(([i, f]) => dia >= i && dia <= f);
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
    if (diaEmFalha(dia)) continue; // mês que falhou: mantém o arquivo que já existia
    const processosDoDia = porDia.get(dia) || [];
    fs.writeFileSync(path.join(DIR_DADOS, `${dia}.json`), JSON.stringify(processosDoDia, null, 2));
  }

  // Índice: reflete exatamente o período consultado
  const indice = diasDoIntervalo
    .map((dia) => {
      if (diaEmFalha(dia)) {
        // mantém a contagem do arquivo anterior, se existir
        try {
          const antigo = JSON.parse(fs.readFileSync(path.join(DIR_DADOS, `${dia}.json`), 'utf-8'));
          return { data: dia, total: antigo.length };
        } catch (e) {
          return { data: dia, total: 0 };
        }
      }
      return { data: dia, total: (porDia.get(dia) || []).length };
    })
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

  // Distribuição por classe (código + nome) — serve para conferir se os
  // códigos configurados são mesmo os esperados (ex.: 108 = Falência).
  const porClasse = new Map();
  let maisRecente = null;
  for (const hit of hits) {
    const p = hit._source;
    const chave = `${p.classe && p.classe.codigo} - ${p.classe && p.classe.nome}`;
    porClasse.set(chave, (porClasse.get(chave) || 0) + 1);
    if (p.dataAjuizamento && (!maisRecente || p.dataAjuizamento > maisRecente)) maisRecente = p.dataAjuizamento;
  }
  console.log('\nDistribuição por classe:');
  if (porClasse.size === 0) console.log('  (nenhum processo)');
  for (const [chave, qtd] of [...porClasse.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(qtd).padStart(5)}  ${chave}`);
  }
  if (maisRecente) {
    const diaRecente = extrairDia(maisRecente);
    console.log(`Processo mais recente encontrado: distribuído em ${diaRecente}.`);
    const defasagem = Math.round((new Date(`${ateISO}T00:00:00Z`) - new Date(`${diaRecente}T00:00:00Z`)) / 86400000);
    if (defasagem > 7) {
      console.log(`ATENÇÃO: o dado mais recente da base do DataJud tem ${defasagem} dia(s) de defasagem em relação a ${ateISO}. A base pública pode estar desatualizada para este tribunal.`);
    }
  } else {
    console.log('Nenhum processo no período — se isso for inesperado, a base do DataJud pode estar desatualizada.');
  }

  console.log(
    `\nConcluído: ${hits.length} processo(s) no período, ${novosNestaExecucao.length} novo(s) descoberto(s) nesta execução.`
  );

  if (falhas.length > 0) {
    console.log(`\nATENÇÃO: ${falhas.length} período(s) não puderam ser consultados (API do CNJ sobrecarregada): ${falhas.map(([i, f]) => `${i}..${f}`).join(', ')}.`);
    console.log('Os dados desses períodos foram MANTIDOS como estavam. Rode novamente mais tarde.');
    process.exitCode = 1;
  }
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

// Lista, por agregação (consulta leve), quais códigos de classe existem
// entre os candidatos e como cada um se chama — para validar o 108 etc.
async function listarClasses() {
  console.log(`\n=== CLASSES CANDIDATAS (${TJ.nome}) ===\n`);
  const candidatos = [108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 128, 129, 130, 131];
  const json = await requisitar({
    size: 0,
    query: { terms: { 'classe.codigo': candidatos } },
    aggs: { classes: { terms: { field: 'classe.codigo', size: 50 }, aggs: { exemplo: { top_hits: { size: 1, _source: ['classe'] } } } } },
  });
  const buckets = (json.aggregations && json.aggregations.classes && json.aggregations.classes.buckets) || [];
  if (buckets.length === 0) console.log('  (nada retornado)');
  for (const bk of buckets) {
    const h = bk.exemplo && bk.exemplo.hits && bk.exemplo.hits.hits && bk.exemplo.hits.hits[0];
    const nome = h && h._source && h._source.classe && h._source.classe.nome;
    console.log(`  ${String(bk.doc_count).padStart(8)}  ${bk.key} - ${nome}`);
  }
  console.log(`\nCódigos usados atualmente: ${CLASSES_DE_INTERESSE.join(', ')}\n`);
}

// Mostra os 5 processos MAIS RECENTES das classes de interesse (sem filtro
// de data) e a data de atualização da base — responde "a base está parada?".
async function listarUltimos() {
  console.log(`\n=== 5 PROCESSOS MAIS RECENTES NA BASE (${TJ.nome}) ===\n`);
  const json = await requisitar({
    size: 5,
    sort: [{ dataAjuizamento: { order: 'desc' } }],
    query: { terms: { 'classe.codigo': CLASSES_DE_INTERESSE } },
  });
  const total = json.hits && json.hits.total && json.hits.total.value;
  console.log(`Total na base (todas as datas, classes ${CLASSES_DE_INTERESSE.join('/')}): ${total}\n`);
  const hits = (json.hits && json.hits.hits) || [];
  if (hits.length === 0) console.log('  (nenhum processo)');
  for (const h of hits) {
    const p = h._source;
    console.log(`  ${p.numeroProcesso} | classe ${p.classe && p.classe.codigo} ${p.classe && p.classe.nome}`);
    console.log(`     distribuído: ${compactoParaISO(p.dataAjuizamento)} | base atualizada em: ${p.dataHoraUltimaAtualizacao}`);
  }
  console.log('');
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
  const idxTj = process.argv.indexOf('--tribunal');
  definirTribunal(idxTj !== -1 ? String(process.argv[idxTj + 1] || '').toLowerCase() : 'tjmg');

  const idxProcesso = process.argv.indexOf('--processo');
  if (idxProcesso !== -1) {
    await buscarPorNumero(process.argv[idxProcesso + 1]);
    return;
  }
  if (process.argv.includes('--debug')) {
    await diagnosticar();
    return;
  }
  if (process.argv.includes('--classes')) {
    await listarClasses();
    return;
  }
  if (process.argv.includes('--ultimos')) {
    await listarUltimos();
    return;
  }

  const opts = lerArgumentos();
  await rodarResync(opts.de, opts.ate, opts.comarca);
}

main().catch((err) => {
  console.error('Falha na execução:', err.message);
  process.exit(1);
});
