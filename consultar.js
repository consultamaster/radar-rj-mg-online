#!/usr/bin/env node
/**
 * Radar de Distribuições — Recuperação Judicial e Falência (TJMG)
 * ------------------------------------------------------------------
 * Versão "online": pensada para rodar todo dia via GitHub Actions.
 * Em vez de só imprimir no terminal, grava os resultados dentro de
 * docs/data/ — pasta publicada pelo GitHub Pages — para o painel web
 * (docs/index.html) ler diretamente.
 *
 * Fluxo:
 *  1. Busca no DataJud os processos de RJ/Falência distribuídos na
 *     data informada (padrão: hoje).
 *  2. Grava docs/data/AAAA-MM-DD.json com os processos daquele dia.
 *  3. Atualiza docs/data/index.json (lista de datas disponíveis, para
 *     o painel montar o seletor de datas).
 *  4. Mantém visto.json (fora de docs/, não é publicado) para evitar
 *     duplicar o mesmo processo em relatórios futuros.
 *
 * Uso:
 *   node consultar.js                    -> processos distribuídos hoje
 *   node consultar.js --data 2026-07-15  -> processos distribuídos nessa data
 *   node consultar.js --de 2026-07-01 --ate 2026-07-15  -> intervalo de datas
 *   node consultar.js --comarca "Belo Horizonte"
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

const ARQ_HISTORICO = path.join(__dirname, 'visto.json');
const DIR_DADOS = path.join(__dirname, 'docs', 'data');
const ARQ_INDICE = path.join(DIR_DADOS, 'index.json');

// ---------------------------------------------------------------
// ARGUMENTOS DE LINHA DE COMANDO
// ---------------------------------------------------------------

function dataISO(diasAtras) {
  const d = new Date();
  d.setDate(d.getDate() - diasAtras);
  return d.toISOString().split('T')[0]; // AAAA-MM-DD
}

function lerArgumentos() {
  const args = process.argv.slice(2);
  const opts = { data: null, de: null, ate: null, comarca: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--data') opts.data = args[++i];
    if (args[i] === '--de') opts.de = args[++i];
    if (args[i] === '--ate') opts.ate = args[++i];
    if (args[i] === '--comarca') opts.comarca = args[++i];
  }
  // Sem nada informado, assume hoje. Com --de/--ate, ignora --data.
  if (!opts.de && !opts.ate && !opts.data) opts.data = dataISO(0);
  return opts;
}

function listaDeDias(opts) {
  if (opts.de && opts.ate) {
    const dias = [];
    let atual = opts.de;
    while (atual <= opts.ate) {
      dias.push(atual);
      atual = proximoDia(atual);
    }
    return dias;
  }
  return [opts.data];
}

// ---------------------------------------------------------------
// HISTÓRICO (para não repetir processos já reportados)
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
// CONSULTA À API DATAJUD
// ---------------------------------------------------------------

function proximoDia(dataStr) {
  const d = new Date(`${dataStr}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0];
}

// A API do DataJud guarda dataAjuizamento como "AAAAMMDDHHmmss" (sem
// separadores). Para filtrar por dia, convertemos os limites pra esse
// mesmo formato — senão a busca não dá erro, mas também não acha nada.
function paraCompacto(dataISO) {
  return `${dataISO.replace(/-/g, '')}000000`;
}

// Converte "AAAAMMDDHHmmss" (formato bruto da API) pra "AAAA-MM-DDTHH:mm:ss"
// (mais fácil de exibir e de o painel web interpretar).
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

function aguardar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function buscarProcessos({ data, comarca }, tentativa = 1) {
  const inicioDoDia = paraCompacto(data);
  const inicioDoDiaSeguinte = paraCompacto(proximoDia(data));

  const must = [
    { terms: { 'classe.codigo': CLASSES_DE_INTERESSE } },
    {
      range: {
        dataAjuizamento: {
          gte: inicioDoDia,
          lt: inicioDoDiaSeguinte,
        },
      },
    },
  ];

  if (comarca) {
    must.push({ match: { 'orgaoJulgador.nome': comarca } });
  }

  const body = {
    size: 100,
    sort: [{ dataAjuizamento: { order: 'desc' } }],
    query: { bool: { must } },
  };

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
    // Falha de conexão (não chegou a ter resposta HTTP) — mostra o motivo
    // real em vez de só "fetch failed", e tenta de novo algumas vezes.
    const motivo = (err.cause && (err.cause.code || err.cause.message)) || err.message;
    if (tentativa <= 5) {
      const espera = 3000 * tentativa;
      console.log(`  Falha de conexão (${motivo}) — tentando de novo em ${espera / 1000}s (tentativa ${tentativa}/5)...`);
      await aguardar(espera);
      return buscarProcessos({ data, comarca }, tentativa + 1);
    }
    throw new Error(`Falha de conexão com a API DataJud após 5 tentativas: ${motivo}`);
  }

  // A API pública do CNJ tem limite de requisições simultâneas. Em vez de
  // travar tudo, espera um pouco e tenta de novo (até 5 vezes).
  if ((resp.status === 429 || resp.status === 503) && tentativa <= 5) {
    const espera = 2000 * tentativa; // 2s, 4s, 6s, 8s, 10s
    console.log(`  API ocupada (HTTP ${resp.status}) — tentando de novo em ${espera / 1000}s (tentativa ${tentativa}/5)...`);
    await aguardar(espera);
    return buscarProcessos({ data, comarca }, tentativa + 1);
  }

  if (!resp.ok) {
    const texto = await resp.text();
    throw new Error(`Erro na API DataJud (HTTP ${resp.status}): ${texto}`);
  }

  const json = await resp.json();
  return (json.hits && json.hits.hits) || [];
}

// ---------------------------------------------------------------
// ÍNDICE DE DATAS (para o painel web)
// ---------------------------------------------------------------

function carregarIndice() {
  if (!fs.existsSync(ARQ_INDICE)) return [];
  return JSON.parse(fs.readFileSync(ARQ_INDICE, 'utf-8'));
}

function atualizarIndice(data, total) {
  const indice = carregarIndice();
  const semEssaData = indice.filter((item) => item.data !== data);
  semEssaData.push({ data, total });
  semEssaData.sort((a, b) => (a.data < b.data ? 1 : -1)); // mais recente primeiro
  fs.writeFileSync(ARQ_INDICE, JSON.stringify(semEssaData, null, 2));
}

// ---------------------------------------------------------------
// EXECUÇÃO PRINCIPAL
// ---------------------------------------------------------------

async function consultarUmDia(data, comarca, vistos) {
  console.log(`\nConsultando TJMG — distribuições do dia ${data}${comarca ? ` — comarca: ${comarca}` : ''}...`);

  const hits = await buscarProcessos({ data, comarca });
  const processos = [];

  for (const hit of hits) {
    const p = hit._source;
    const numero = p.numeroProcesso;

    processos.push({
      numeroProcesso: numero,
      classeId: p.classe && p.classe.codigo,
      classe: p.classe && p.classe.nome,
      dataAjuizamento: compactoParaISO(p.dataAjuizamento),
      orgaoJulgador: p.orgaoJulgador && p.orgaoJulgador.nome,
      assuntos: (p.assuntos || []).map((a) => a.nome),
      novo: !vistos.has(numero),
    });
    vistos.add(numero);
  }

  console.log(
    processos.length === 0
      ? 'Nenhum processo encontrado nessa data.'
      : `${processos.length} processo(s) encontrado(s) (${processos.filter((p) => p.novo).length} novo(s)).`
  );

  if (!fs.existsSync(DIR_DADOS)) fs.mkdirSync(DIR_DADOS, { recursive: true });
  const arqDoDia = path.join(DIR_DADOS, `${data}.json`);
  fs.writeFileSync(arqDoDia, JSON.stringify(processos, null, 2));
  atualizarIndice(data, processos.length);

  return processos.length;
}

async function diagnosticar() {
  console.log('\n=== MODO DIAGNÓSTICO ===\n');

  // 1) Quantos processos existem no índice do TJMG só com as classes de
  //    interesse, sem filtro de data — confirma se "classe.codigo" é o
  //    campo certo e se essas classes realmente existem no índice.
  console.log('1) Testando filtro por classe (sem data)...');
  const resp1 = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `APIKey ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      size: 1,
      query: { terms: { 'classe.codigo': CLASSES_DE_INTERESSE } },
    }),
  });
  const json1 = await resp1.json();
  if (!resp1.ok) {
    console.log(`   Erro HTTP ${resp1.status}:`, JSON.stringify(json1).slice(0, 500));
  } else {
    const total1 = json1.hits && json1.hits.total && json1.hits.total.value;
    console.log(`   Total encontrado (todas as datas): ${total1}`);
  }

  // 2) Pega 1 processo das nossas classes de interesse e mostra os campos
  //    reais, incluindo a lista de "movimentos" — é lá que deve estar o
  //    movimento específico de Distribuição (código 26 na tabela do CNJ),
  //    que é diferente da data de ajuizamento/publicação.
  console.log('\n2) Pegando 1 processo de exemplo (dentro das classes de interesse)...');
  const resp2 = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `APIKey ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      size: 1,
      query: { terms: { 'classe.codigo': CLASSES_DE_INTERESSE } },
    }),
  });
  const json2 = await resp2.json();
  if (!resp2.ok) {
    console.log(`   Erro HTTP ${resp2.status}:`, JSON.stringify(json2).slice(0, 500));
  } else {
    const hit = json2.hits && json2.hits.hits && json2.hits.hits[0];
    if (hit) {
      const src = hit._source;
      console.log('   Campos disponíveis no documento:', Object.keys(src).join(', '));
      console.log('   Exemplo de "classe":', JSON.stringify(src.classe));
      console.log('   Exemplo de "dataAjuizamento":', src.dataAjuizamento);
      console.log('   Exemplo de "orgaoJulgador":', JSON.stringify(src.orgaoJulgador));

      if (Array.isArray(src.movimentos)) {
        console.log(`\n   Documento tem ${src.movimentos.length} movimento(s). Lista completa:`);
        console.log(JSON.stringify(src.movimentos, null, 2));

        const distribuicao = src.movimentos.find(
          (m) => m.nome && m.nome.toLowerCase().includes('distribui')
        );
        if (distribuicao) {
          console.log('\n   >>> Movimento de Distribuição encontrado:', JSON.stringify(distribuicao));
        } else {
          console.log('\n   >>> Nenhum movimento com "distribuição" no nome foi encontrado nesse exemplo.');
        }
      } else {
        console.log('   (Esse documento não tem um campo "movimentos" — ver campos disponíveis acima.)');
      }
    } else {
      console.log('   Nenhum documento retornado.');
    }
  }

  console.log('\n=== FIM DO DIAGNÓSTICO ===\n');
}

async function buscarPorNumero(numero) {
  console.log(`\n=== BUSCANDO PROCESSO ${numero} ===\n`);
  const numeroLimpo = numero.replace(/\D/g, '');

  const resp = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `APIKey ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      size: 1,
      query: { term: { numeroProcesso: numeroLimpo } },
    }),
  });
  const json = await resp.json();

  if (!resp.ok) {
    console.log(`Erro HTTP ${resp.status}:`, JSON.stringify(json).slice(0, 800));
    return;
  }

  const hit = json.hits && json.hits.hits && json.hits.hits[0];
  if (!hit) {
    console.log('Processo não encontrado nesse índice (pode levar um tempo entre a distribuição real e a indexação no DataJud).');
    return;
  }

  console.log('Documento completo retornado pela API:\n');
  console.log(JSON.stringify(hit._source, null, 2));
}

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
  const dias = listaDeDias(opts);
  const vistos = carregarHistorico();

  let totalGeral = 0;
  for (let i = 0; i < dias.length; i++) {
    totalGeral += await consultarUmDia(dias[i], opts.comarca, vistos);
    if (i < dias.length - 1) await aguardar(700); // respiro entre requisições
  }

  if (dias.length > 1) {
    console.log(`\nIntervalo concluído: ${dias[0]} a ${dias[dias.length - 1]} — ${totalGeral} processo(s) no total.`);
  }

  salvarHistorico(vistos);
}

main().catch((err) => {
  console.error('Falha na execução:', err.message);
  process.exit(1);
});
