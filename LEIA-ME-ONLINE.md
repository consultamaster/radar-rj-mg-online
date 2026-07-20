# Radar de Distribuições — Versão Online (gratuita)

Esta pasta é um repositório pronto para publicar no GitHub. Depois de
configurado, roda sozinho todo dia às 08h e você consulta o resultado
por um site, de qualquer lugar — sem precisar do seu computador ligado.

## O que cada parte faz

- `consultar.js` — mesmo motor de busca de antes, mas agora grava os
  resultados em `docs/data/` em vez de só mostrar no terminal.
- `.github/workflows/diario.yml` — agenda o GitHub para rodar o
  `consultar.js` automaticamente todo dia às 08h (Brasília), sempre
  buscando as distribuições do **dia anterior (D-1)** — já que às 8h
  da manhã ainda não há publicação do próprio dia — e publica os
  dados novos.
- `docs/index.html` — o painel web (o mesmo visual que você validou),
  publicado pelo GitHub Pages.

## Passo a passo (only uma vez)

### 1. Criar o repositório no GitHub
1. Entre em github.com (crie uma conta grátis se ainda não tiver).
2. Clique em **New repository**. Nome sugerido: `radar-rj-mg`.
3. Marque como **Private** ou **Public** — os dados são públicos por
   natureza (constam do DataJud), mas privado funciona igual.
4. Não marque "Adicionar README" — vamos subir os arquivos prontos.

### 2. Subir esta pasta pro repositório
Com o Git instalado, no terminal, dentro desta pasta:

```bash
git init
git add .
git commit -m "Primeira versão do radar"
git branch -M main
git remote add origin https://github.com/SEU-USUARIO/radar-rj-mg.git
git push -u origin main
```

(Troque `SEU-USUARIO` pelo seu usuário do GitHub.)

### 3. Dar permissão de escrita para o robô do Actions
1. No repositório, vá em **Settings → Actions → General**.
2. Em "Workflow permissions", marque **Read and write permissions**.
3. Salve.

*(Sem isso, o robô consegue rodar a consulta mas não consegue salvar
o resultado de volta no repositório.)*

### 4. Ativar o GitHub Pages
1. Vá em **Settings → Pages**.
2. Em "Source", escolha **Deploy from a branch**.
3. Branch: `main`, pasta: `/docs`. Salve.
4. Em alguns minutos, o GitHub mostra o link do site (algo como
   `https://seu-usuario.github.io/radar-rj-mg/`).

### 5. Rodar a primeira consulta manualmente
Não precisa esperar até amanhã de manhã:
1. Vá na aba **Actions** do repositório.
2. Clique no workflow "Consulta diária de distribuições (TJMG)".
3. Clique em **Run workflow** → **Run workflow** de novo pra confirmar.
4. Em cerca de 1 minuto, atualize o site — os dados de hoje devem
   aparecer.

## Depois disso

Não precisa fazer mais nada — todo dia às 08h o GitHub roda a consulta
sozinho e atualiza o site automaticamente. Você só acessa o link
quando quiser conferir.

## Se quiser evoluir depois

- E-mail diário automático com o resumo (posso integrar um serviço
  gratuito tipo Resend)
- Domínio próprio em vez do endereço `github.io`
- Filtrar por comarcas específicas de interesse por padrão
