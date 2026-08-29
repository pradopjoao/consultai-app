/* =========================================================================
   Consultaí — Mini-backend (o "porteiro")
   Liga o chatbot de agendamento ao Shosp (agenda) e ao Mercado Pago (Pix).
   As chaves secretas NUNCA ficam neste arquivo: são lidas de variáveis de
   ambiente (.env / painel da hospedagem). Veja .env.example.
   Rotas:
     GET  /api/horarios        -> horários livres (Shosp /agenda/get/)
     POST /api/checkout        -> cria a cobrança Pix (Mercado Pago) e reserva os dados
     GET  /api/checkout/:id    -> verifica o pagamento; se aprovado, agenda no Shosp
     POST /api/webhook         -> aviso automático do Mercado Pago quando paga
   ========================================================================= */
require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');   // só para gravar as marcações da recuperação de Pix
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
/* CORS + headers de segurança.
   ATENCAO AO LUGAR: este bloco PRECISA vir antes do express.static.
   Antes ele estava DEPOIS, e como o express.static responde e encerra a
   requisicao, nenhuma pagina HTML do site recebia esses cabecalhos de
   seguranca. So as rotas /api recebiam. Movido para ca em 31/07/2026. */
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || 'https://vemconsultai.com.br');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('X-Content-Type-Options', 'nosniff');
  res.header('X-Frame-Options', 'SAMEORIGIN');
  res.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.header('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  // Nada de /api pode ser guardado em cache/edge — sempre resposta fresca (pagamento, horários).
  if (req.path.startsWith('/api/')) res.header('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
/* ======================================================================
   TAG DO GOOGLE ADS INJETADA NO <head>                    (29/08/2026)
   ----------------------------------------------------------------------
   O site é HTML estático. Colar o mesmo bloco à mão em dezenas de
   arquivos significa esquecer nos próximos, e foi assim que a tag ficou
   um mês inteiro sem nunca ser instalada. Aqui ela entra sozinha, logo
   depois do <head>, em toda página HTML dos DOIS domínios.

   POR QUE ESTE BLOCO É O PRIMEIRO DEPOIS DO CORS: mais abaixo existem
   rotas que respondem com sendFile (a raiz do clinicogeralonline, o
   /blog) e o express.static, que respondem e ENCERRAM a requisição.
   Qualquer coisa colada depois deles nunca rodaria para essas páginas.
   Mesmo motivo que já obrigou a mover o bloco de CORS uma vez.

   O QUE ESTE BLOCO NÃO TOCA, de propósito:
     - qualquer endereço terminado em .html, para não atropelar nem o
       redirecionamento de URLs limpas nem os arquivos de verificação
       do Search Console, que são .html e precisam sair crus;
     - /api/ e qualquer coisa que não seja GET ou HEAD;
     - endereços com ponto no último trecho (.css, .png, .xml, .txt).
   ====================================================================== */
/* ----------------------------------------------------------------------
   As quatro variáveis de ambiente da medição. Ficam AQUI, e não no bloco
   grande de process.env mais abaixo, porque este bloco é executado antes
   dele: uma const declarada depois ainda não existe quando esta linha
   roda, e o servidor nem sobe (testado em 29/08/2026).

   TODAS NASCEM VAZIAS DE PROPÓSITO. Enquanto GADS_TAG_ID estiver em
   branco, nada deste bloco roda e o site sai exatamente como antes.
   -------------------------------------------------------------------- */
const GADS_TAG_ID      = process.env.GADS_TAG_ID      || '';  // AW-18333144388
const GADS_LABEL_AGEND = process.env.GADS_LABEL_AGEND || '';  // AW-18333144388/Q9_hCLHFh9McEMSq9qVE
const GADS_CONV_PAGA   = process.env.GADS_CONV_PAGA   || 'Consulta paga';  // nome EXATO da ação de importação
const GADS_CSV_TOKEN   = process.env.GADS_CSV_TOKEN   || '';  // senha do CSV. Sem ela, o endereço responde 403.

const GADS_CACHE = new Map();   // caminho do arquivo -> { mtime, html }

/* O trecho que vai para dentro do <head>. Monta uma vez, na subida. */
const GADS_TRECHO = !GADS_TAG_ID ? '' : `
<!-- Google Ads: tag base, captura do gclid e conversão de agendamento (29/08/2026) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=${GADS_TAG_ID}"></script>
<script>
(function () {
  window.dataLayer = window.dataLayer || [];
  function gtag(){ dataLayer.push(arguments); }
  window.gtag = window.gtag || gtag;
  gtag('js', new Date());
  gtag('config', '${GADS_TAG_ID}');

  /* 1) GUARDA O IDENTIFICADOR DO CLIQUE NO ANÚNCIO.
        O Google carimba ?gclid=... na URL de quem chega pelo anúncio. Ele
        vive só naquela primeira página, e o agendamento acontece em outra.
        Guardamos por 90 dias, que é a janela de conversão configurada na
        conta. Cookie próprio, do mesmo domínio, sem terceiros. */
  try {
    var q = new URLSearchParams(location.search);
    ['gclid', 'wbraid', 'gbraid'].forEach(function (n) {
      var v = q.get(n);
      if (!v) return;
      document.cookie = 'cs_' + n + '=' + encodeURIComponent(v) +
        ';max-age=' + (90 * 24 * 3600) + ';path=/;SameSite=Lax;Secure';
    });
  } catch (e) {}

  /* 2) DISPARA A CONVERSÃO DE AGENDAMENTO.
        Não olha o HTML da página, de propósito: escuta a resposta de
        /api/checkout/<id>, que é o endereço que o próprio site já
        consulta para saber se o Pix caiu. Assim o disparo continua
        funcionando mesmo que a tela de confirmação seja redesenhada.
        O transaction_id evita contar duas vezes se a pessoa recarregar. */
  var LABEL = '${GADS_LABEL_AGEND}';
  function contar(id) {
    if (!LABEL || !id) return;
    try { if (sessionStorage.getItem('cs_conv_' + id) === '1') return; } catch (e) {}
    try { sessionStorage.setItem('cs_conv_' + id, '1'); } catch (e) {}
    gtag('event', 'conversion', { 'send_to': LABEL, 'transaction_id': String(id) });
  }
  window.consultaiConversaoAgendada = contar;  // gancho manual, caso um dia precise

  var fetchOriginal = window.fetch;
  if (typeof fetchOriginal === 'function') {
    window.fetch = function () {
      var args = arguments;
      return fetchOriginal.apply(this, args).then(function (resp) {
        try {
          var url = (typeof args[0] === 'string') ? args[0] : ((args[0] && args[0].url) || '');
          var m = String(url).match(/\\/api\\/checkout\\/([^?#\\/]+)/);
          if (m && resp && resp.ok) {
            resp.clone().json().then(function (d) {
              if (d && d.status === 'approved') contar(m[1]);
            }).catch(function () {});
          }
        } catch (e) {}
        return resp;
      });
    };
  }
})();
</script>`;

app.use((req, res, next) => {
  if (!GADS_TRECHO) return next();
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const caminho = req.path;
  if (caminho.startsWith('/api/')) return next();
  if (/\.[a-z0-9]+$/i.test(caminho)) return next();  // .html, .css, .png, .xml... passam direto

  // Descobre qual arquivo o express.static entregaria para este endereço.
  const raiz = path.join(__dirname, 'public');
  const clinico = (req.headers.host || '').toLowerCase().includes('clinicogeralonline');
  const candidatos = caminho === '/'
    ? [path.join(raiz, clinico ? 'clinico' : '', 'index.html')]
    : [path.join(raiz, caminho + '.html'), path.join(raiz, caminho, 'index.html')];

  for (const arquivo of candidatos) {
    // Cinto de segurança contra path traversal: nada fora de public/.
    if (!arquivo.startsWith(raiz)) continue;
    let st;
    try { st = fs.statSync(arquivo); } catch (e) { continue; }
    if (!st.isFile()) continue;

    // Cache em memória por data de modificação: o disco só é lido quando o
    // arquivo muda, e uma publicação nova invalida sozinha.
    const guardado = GADS_CACHE.get(arquivo);
    let html;
    if (guardado && guardado.mtime === st.mtimeMs) {
      html = guardado.html;
    } else {
      try { html = fs.readFileSync(arquivo, 'utf8'); } catch (e) { return next(); }
      html = html.includes('googletagmanager.com/gtag/js')
        ? html                                   // já tem a tag: não duplica
        : html.replace(/<head([^>]*)>/i, '<head$1>' + GADS_TRECHO);
      GADS_CACHE.set(arquivo, { mtime: st.mtimeMs, html });
    }
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return res.type('html').send(html);
  }
  next();
});
/* ----------------------------------------------------------------------
   ARQUIVOS DE VERIFICACAO DO GOOGLE SEARCH CONSOLE        (23/08/2026)
   ----------------------------------------------------------------------
   TEM QUE FICAR AQUI, ANTES DA REGRA DE URLS LIMPAS LOGO ABAIXO.

   O Google verifica a posse de um site pedindo um arquivo com nome tipo
   googleXXXXXXXX.html e exigindo resposta 200 NAQUELE endereco exato.
   A regra seguinte redireciona TUDO que termina em .html para o endereco
   sem extensao. Testado: sem esta excecao, o pedido do Google recebia
   "301 Moved Permanently" em vez do arquivo, e a verificacao falharia.

   A excecao e estreita de proposito: so nomes no formato google + letras
   e numeros + .html. Nenhuma outra pagina do site e afetada.
   -------------------------------------------------------------------- */
app.get(/^\/google[0-9a-z]+\.html$/i, (req, res, next) => {
  res.set('Cache-Control', 'public, max-age=0, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', path.basename(req.path)), (err) => {
    if (err) next(err);
  });
});

// URLs limpas: redireciona /pagina.html -> /pagina (301, bom para SEO).
// Qualquer ".../index.html" cai na raiz da pasta: /index.html -> /  e
// /blog/index.html -> /blog. Sem isso sobrava um endereço duplicado (/blog/index)
// servindo exatamente a mesma página.
app.get(/\.html$/, (req, res) => {
  const limpo = req.path.endsWith('/index.html')
    ? (req.path.slice(0, -'/index.html'.length) || '/')
    : req.path.slice(0, -5);
  const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  res.redirect(301, limpo + qs);
});
/* /blog é o ÚNICO endereço do site que é uma PASTA e não um arquivo .html.
   Por padrão o express.static responde 301 de "/blog" para "/blog/", e esse
   salto extra foi o que o Google marcou como "Erro de redirecionamento" no
   Search Console (era a única página da lista, justamente por ser pasta).
   Aqui entregamos o arquivo direto, com status 200, sem redirecionar.
   O "redirect: false" logo abaixo desliga o 301 automático de pastas. */
app.get('/blog', (req, res, next) => {
  res.set('Cache-Control', 'public, max-age=0, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'blog', 'index.html'), (err) => {
    if (err) next(err);
  });
});
/* ======================================================================
   SEGUNDO DOMINIO: clinicogeralonline.com.br            (21/08/2026)
   ----------------------------------------------------------------------
   Pre-venda com endereco proprio, servida por ESTE mesmo servidor.
   Nao existe redirecionamento entre dominios, que o Google Ads proibe:
   a barra de enderecos do visitante nunca muda. O servidor apenas olha
   o nome que veio no pedido e, se for o dominio novo, entrega outra
   pagina inicial.

   POR QUE AQUI E NAO DEPOIS: o express.static logo abaixo responde e
   encerra a requisicao. Qualquer rota colada depois dele nunca seria
   executada para a pagina inicial. Mesmo motivo do bloco de CORS la em
   cima, que ja precisou ser movido uma vez por isso.

   O QUE CONTINUA VINDO DE public/: politica de privacidade, termos,
   /agendamento, /api e tudo o mais. So a raiz "/" e trocada.
   ====================================================================== */
const ehClinico = (req) =>
  (req.headers.host || '').toLowerCase().includes('clinicogeralonline');

app.get('/', (req, res, next) => {
  if (!ehClinico(req)) return next();
  res.set('Cache-Control', 'public, max-age=0, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'clinico', 'index.html'), (err) => {
    if (err) next(err);
  });
});

/* ----------------------------------------------------------------------
   robots.txt e sitemap.xml POR DOMINIO                    (23/08/2026)
   ----------------------------------------------------------------------
   Os dois arquivos sao, por definicao, de UM dominio so. Como este mesmo
   servidor atende os dois enderecos, quem abrisse
   clinicogeralonline.com.br/robots.txt recebia o da Consultai, que aponta
   o mapa do site para vemconsultai.com.br. O dominio novo estava mandando
   o Google procurar o mapa dele na casa do vizinho.

   Aqui, quando o pedido chega pelo dominio novo, entregamos os arquivos
   de public/clinico/. Pelo dominio da Consultai nada muda: o
   express.static logo abaixo continua entregando os originais.

   Mesmo motivo do bloco acima para colar isto ANTES do express.static:
   depois dele a rota nunca seria executada.
   -------------------------------------------------------------------- */
['/robots.txt', '/sitemap.xml'].forEach((rota) => {
  app.get(rota, (req, res, next) => {
    if (!ehClinico(req)) return next();
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    res.sendFile(path.join(__dirname, 'public', 'clinico', rota.slice(1)), (err) => {
      if (err) next(err);
    });
  });
});
// Serve os arquivos; "extensions:['html']" faz /trabalhe-conosco achar trabalhe-conosco.html
// setHeaders define o cache com segurança: páginas HTML sempre revalidam (nunca
// servem versão velha); imagens/CSS/JS podem ser guardados por 1 dia. Isso deixa
// o "edge caching" do Render seguro de ligar — as rotas /api ganham "no-store" abaixo.
app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  redirect: false,
  setHeaders: (res, filePath) => {
    /* ATENCAO: sitemap.xml e robots.txt entram JUNTO com o HTML, e nao no
       balde de 24 horas. Eles nao terminam em .html, entao antes caiam na
       regra do "else" e ficavam guardados por um dia inteiro.
       Foi isso que fez o Dr. Joao abrir /sitemap.xml em 04/08/2026 e ver a
       versao da vespera, com 19 enderecos em vez de 20, e concluir que o
       arquivo nao tinha subido. Pior: o proprio Googlebot podia estar
       segurando a copia velha pelo mesmo motivo.
       Sao arquivos minusculos e de controle, que mudam a cada publicacao.
       Guardar em cache nao economiza nada e atrasa a indexacao. */
    if (/\.html$/i.test(filePath) || /[\\/](sitemap\.xml|robots\.txt)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    } else if (/\.(css|js|woff2?|ttf)$/i.test(filePath)) {
      /* CSS, JavaScript e fontes ficam 30 dias no navegador do visitante,
         em vez de 1 dia.                                    (23/08/2026)
         ---------------------------------------------------------------
         ISTO SO E SEGURO POR CAUSA DO "?v=" NO FIM DO ENDERECO.
         O HTML chama /style.css?v=14. Para o navegador, ?v=14 e ?v=15 sao
         arquivos DIFERENTES, entao mudar o numero entrega a versao nova na
         hora, sem esperar o cache vencer.
         >>> SEMPRE que o style.css for alterado, SUBA O NUMERO DA VERSAO
         >>> em todas as paginas. Se esquecer, quem ja visitou o site
         >>> continua vendo o CSS antigo por ate 30 dias.
         Escolhi 30 dias em vez de 1 ano, que e o padrao recomendado, de
         proposito: se um dia a versao for esquecida, o estrago se corrige
         sozinho em um mes em vez de durar o ano inteiro.
         As fontes (.woff2) entram na mesma regra: os nomes dos arquivos nao
         mudam, mas o conteudo tambem nao muda nunca. */
      res.setHeader('Cache-Control', 'public, max-age=2592000');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }
  },
}));
// Rate limit simples em memória (sem dependência) — protege contra abuso/spam
const _rl = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const key = ip + '|' + req.path;
    const now = Date.now();
    let e = _rl.get(key);
    if (!e || now > e.reset) { e = { count: 0, reset: now + windowMs }; _rl.set(key, e); }
    e.count++;
    if (e.count > max) return res.status(429).json({ ok: false, erro: 'Muitas tentativas. Aguarde alguns minutos.' });
    next();
  };
}
/* Lê um cookie do pedido, sem dependência nova.            (29/08/2026)
   Usado só para o gclid do Google Ads. Devolve string vazia se não existir. */
function lerCookie(req, nome) {
  const bruto = String(req.headers.cookie || '');
  const m = bruto.match(new RegExp('(?:^|;\\s*)' + nome + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : '';
}
const {
  SHOSP_BASE = 'https://sistema.shosp.com.br/api',
  SHOSP_API_KEY,
  SHOSP_ID,
  COD_PRESTADOR = '1',
  COD_UNIDADE = '1',
  COD_SERVICO = '1',
  COD_PLANO = '1',
  COD_ESPECIALIDADE = '',
  MP_ACCESS_TOKEN,
  // Segredo do webhook (painel do Mercado Pago → Suas integrações → Webhooks).
  // Enquanto estiver vazio, a validação fica desligada e nada muda no fluxo atual.
  MP_WEBHOOK_SECRET = '',
  // '1' = recusa avisos com assinatura inválida. Deixe vazio no começo: assim o
  // servidor só REGISTRA no log quando a assinatura não bate, sem bloquear nada.
  MP_WEBHOOK_STRICT = '',
  PRECO = '40',
  PORT = 3000,
  BREVO_API_KEY = '',      // chave da API do Brevo (envio de e-mail por HTTPS)
  NOTIF_EMAIL_FROM = '',   // remetente validado no Brevo
  NOTIF_EMAIL_TO = '',     // quem recebe o aviso interno (ex.: octahealth@hotmail.com)
  // Meta CAPI (Conversions API) — envio de vendas pelo servidor, que o navegador perde.
  META_DATASET_ID = '1369928625011386', // = ID do seu pixel (já preenchido)
  META_CAPI_TOKEN = '',                 // GERAR no Gerenciador de Eventos → Conversions API
  META_TEST_EVENT_CODE = '',            // opcional: só p/ testar em "Testar eventos"
  // Recuperação de Pix não pago. Nasce DESLIGADA de propósito: só começa a
  // enviar quando o Dr. João criar RECUPERACAO=on no painel do Render.
  RECUPERACAO = '',
  // As variáveis do Google Ads (GADS_*) NÃO estão aqui de propósito: elas
  // são lidas lá em cima, junto do bloco que injeta a tag, porque aquele
  // bloco roda antes desta linha. Ver "TAG DO GOOGLE ADS" no começo do arquivo.
} = process.env;
/* ======================================================================
   VERSÃO EM TEXTO PURO DOS E-MAILS
   ----------------------------------------------------------------------
   Todo e-mail bem formado viaja em duas versões dentro do mesmo envelope:
   a bonita, em HTML, e uma simples, em texto. Quem manda só HTML leva
   penalidade no SpamAssassin, a regra MIME_HTML_ONLY, e o mail-tester
   apontou isso no teste de 12/08/2026: "Você deve incluir uma versão de
   texto em sua mensagem (txt/plain)". Também ajuda no outro apontamento,
   o de que a mensagem tinha só 15% de texto.

   ESCOLHA DE PROJETO: o texto é GERADO a partir do HTML, e não escrito à
   mão. Duas versões escritas separadamente divergem na primeira pressa,
   e aí o cliente de e-mail antigo mostra um conteúdo diferente do que o
   moderno mostra. Gerando, as duas nunca saem do lugar.

   Os links viram "texto do link (endereço)", porque em texto puro um
   botão sem endereço ao lado é um beco sem saída.
   ====================================================================== */
function htmlParaTexto(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    // <a href="X">Y</a>  ->  Y (X)
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (todo, href, dentro) => {
      const txt = dentro.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      // botão (display:block) ocupa uma linha só, então fecha com quebra de linha;
      // link no meio de uma frase continua na mesma linha.
      const fim = /display\s*:\s*block/i.test(todo) ? '\n' : '';
      if (!txt) return href + fim;
      if (!href || href === txt || /^mailto:/i.test(href)) return txt + fim;
      return txt + ' (' + href + ')' + fim;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
/* --------- E-mails via Brevo (API HTTPS — o Render bloqueia SMTP) -------- */
async function enviarEmail(para, assunto, html, replyTo) {
  if (!BREVO_API_KEY || !NOTIF_EMAIL_FROM) {
    console.log('[email] não configurado (defina BREVO_API_KEY e NOTIF_EMAIL_FROM)');
    return false;
  }
  // aceita vários destinatários separados por vírgula
  const destinatarios = String(para).split(',').map(e => ({ email: e.trim() })).filter(d => d.email);
  const corpo = {
    sender: { name: 'Consultaí', email: NOTIF_EMAIL_FROM },
    to: destinatarios,
    subject: assunto,
    htmlContent: html,
    textContent: htmlParaTexto(html),   // ver htmlParaTexto acima: tira a penalidade MIME_HTML_ONLY
  };
  if (replyTo) corpo.replyTo = { email: replyTo }; // "responder" vai direto pra quem escreveu
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json', 'accept': 'application/json' },
    body: JSON.stringify(corpo),
  });
  if (!r.ok) throw new Error('Brevo ' + r.status + ': ' + (await r.text()).slice(0, 200));
  return true;
}
function escHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function dataBR(iso) { const [y, m, d] = String(iso).split('-'); return d + '/' + m + '/' + y; }
/* Moldura padrão dos e-mails — identidade visual da Consultaí */
const LOGO_URL = 'https://vemconsultai.com.br/apple-touch-icon.png';
function emailShell(headline, corpo, corHeader) {
  return `
  <div style="background:#F1FBF9;padding:26px 12px;font-family:Arial,Helvetica,sans-serif">
    <div style="max-width:540px;margin:0 auto;background:#ffffff;border:1px solid #E3EFEC;border-radius:16px;overflow:hidden">
      <div style="background:${corHeader || '#0C4A52'};padding:22px 26px">
        <table cellpadding="0" cellspacing="0" border="0"><tr>
          <td><img src="${LOGO_URL}" width="42" height="42" alt="Consultaí" style="border-radius:10px;display:block"></td>
          <td style="padding-left:12px;color:#ffffff;font-size:23px;font-weight:bold;letter-spacing:-.5px">Consult<span style="color:#FF8A6E">aí</span></td>
        </tr></table>
        <h2 style="margin:18px 0 0;color:#ffffff;font-size:21px;line-height:1.3">${headline}</h2>
      </div>
      <div style="padding:26px;color:#14333A;font-size:15px;line-height:1.7">${corpo}</div>
      <div style="background:#F1FBF9;border-top:1px solid #E3EFEC;padding:16px 26px;color:#5C7178;font-size:12px;line-height:1.7">
        <b style="color:#0C4A52">Consultaí</b> · uma iniciativa Octa Health<br>
        Consulta médica online por R$ 40 · <a href="https://vemconsultai.com.br" style="color:#15A39A;text-decoration:none">vemconsultai.com.br</a><br>
        Telemedicina conforme a Resolução CFM nº 2.314/2022
      </div>
    </div>
  </div>`;
}
/* ===== Blocos dos e-mails: modelo "barra lateral", aprovado em 05/08/2026 =====
   O cabeçalho continua sendo a faixa verde escura de sempre (emailShell).
   O que mudou foi o miolo: os destaques ganharam uma barra da cor da marca na
   lateral, e as listas ganharam um quadradinho no lugar do emoji.
   POR QUE QUADRADO E NÃO ÍCONE: e-mail não é site. O Gmail apaga SVG e a maioria
   dos programas bloqueia imagem até a pessoa clicar em "exibir imagens". Um
   quadrado feito com cor de fundo aparece em qualquer programa, sempre.
   NÃO voltar a usar emoji aqui: decisão do Dr. João em 05/08/2026. A única
   exceção combinada é a mensagem de texto do WhatsApp, onde emoji é natural. */
function blocoLateral(rotulo, destaque, apoio) {
  return '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:14px 0">' +
    '<tr><td width="4" style="background:#0F766E;border-radius:3px 0 0 3px">&nbsp;</td>' +
    '<td style="background:#F7FCFB;padding:14px 18px;border-radius:0 10px 10px 0">' +
    '<div style="font-size:11px;letter-spacing:1.1px;text-transform:uppercase;color:#5C7178">' + rotulo + '</div>' +
    '<div style="font-size:24px;font-weight:bold;color:#0C4A52;margin:4px 0 4px;letter-spacing:-.5px">' + destaque + '</div>' +
    (apoio ? '<div style="font-size:13px;color:#5C7178;line-height:1.5">' + apoio + '</div>' : '') +
    '</td></tr></table>';
}
function itemLista(texto) {
  return '<table cellpadding="0" cellspacing="0" border="0" style="margin:0 0 9px"><tr>' +
    '<td valign="top" style="padding:7px 10px 0 0"><div style="width:7px;height:7px;background:#0F766E;border-radius:2px;font-size:0;line-height:0">&nbsp;</div></td>' +
    '<td style="font-size:15px;line-height:1.6;color:#14333A">' + texto + '</td></tr></table>';
}
function linhaDado(rotulo, valor) {
  return '<tr><td style="padding:5px 0;color:#5C7178;width:38%">' + rotulo + '</td><td>' + valor + '</td></tr>';
}
function cardConsulta(p, protocolo) {
  return blocoLateral('Sua consulta',
    dataBR(p.slot.data) + ' · ' + p.slot.horario,
    'Dr. João Pedro Vieira do Prado — Médico — CRM-SP 281.239<br>Protocolo ' + protocolo);
}
/* ======================================================================
   WHATSAPP DE UM TOQUE
   ----------------------------------------------------------------------
   Aprovado pelo Dr. João em 12/08/2026, depois de os e-mails caírem no
   lixo eletrônico do Hotmail. A ideia é simples: o WhatsApp é lido, o
   e-mail nem sempre. Então, em cada momento importante, o SISTEMA avisa
   o médico por e-mail e já monta um botão verde. Um toque abre o
   WhatsApp no número do paciente, com o texto inteiro escrito. O médico
   só confere e envia.

   NÃO é envio automático. Quem aperta enviar continua sendo uma pessoa.
   Envio automático de verdade exigiria a API oficial do WhatsApp
   Business, com aprovação da Meta e custo por mensagem.

   O mecanismo já existia no lembrete de 10 minutos (enviarLembreteWhats).
   Aqui ele foi generalizado para os três momentos que faltavam.

   No WhatsApp, texto entre *asteriscos* aparece em negrito.
   Os textos NÃO prometem documento, cura nem resultado, e todos trazem
   o aviso de urgência com o 192, como manda a nossa regra.
   ====================================================================== */
function linkWhats(telefone, mensagem) {
  const tel = String(telefone || '').replace(/\D/g, '');
  if (tel.length < 10) return '';                       // sem telefone não há botão
  const tel55 = tel.startsWith('55') ? tel : '55' + tel;
  return 'https://wa.me/' + tel55 + '?text=' + encodeURIComponent(mensagem);
}
function botaoWhats(telefone, mensagem, rotulo) {
  const url = linkWhats(telefone, mensagem);
  if (!url) {
    return '<p style="margin:16px 0 0;color:#c0392b;font-size:13px">' +
      'Telefone ausente ou inválido, não deu para montar o botão do WhatsApp.</p>';
  }
  return '<a href="' + url + '" style="display:block;background:#25D366;color:#ffffff;' +
    'text-decoration:none;text-align:center;font-weight:bold;font-size:16px;padding:14px;' +
    'border-radius:12px;margin:18px 0 6px">' + (rotulo || 'Enviar WhatsApp pro paciente') + '</a>' +
    '<p style="margin:0;color:#5C7178;font-size:12.5px;text-align:center">' +
    'Abre o WhatsApp no número do paciente com o texto pronto. Confira e envie.</p>';
}
function primeiroNome(nome) { return String(nome || '').trim().split(/\s+/)[0] || 'tudo bem'; }

function textoWhatsConfirmada(nome, dataISO, horario) {
  return 'Olá, ' + primeiroNome(nome) + '! Aqui é da Consultaí.\n\n' +
    'Sua consulta está *confirmada*:\n' +
    '*' + dataBR(dataISO) + ', às ' + horario + '*\n\n' +
    'Quem vai te atender é o Dr. João Pedro Vieira do Prado, Médico, CRM-SP 281.239.\n\n' +
    'Uns 10 minutos antes do horário eu te mando o link da videochamada aqui mesmo. ' +
    'A conversa dura de 10 a 15 minutos.\n\n' +
    'Para a consulta render, deixe em mãos:\n' +
    '- os remédios que você usa hoje, ou a caixa deles\n' +
    '- exames recentes, se tiver\n' +
    '- um canto com boa luz e internet estável\n\n' +
    'Receita, atestado e pedido de exames saem quando o médico indicar.\n\n' +
    'Se precisar remarcar, é só responder aqui.\n\n' +
    'Não atendemos urgência nem emergência. Nesses casos, procure um pronto-socorro ou ligue 192 (SAMU).';
}
function textoWhatsPixPendente(nome, horario) {
  return 'Olá, ' + primeiroNome(nome) + '! Aqui é da Consultaí.\n\n' +
    'Vi que você escolheu o horário das *' + horario + '* e o Pix foi gerado, ' +
    'mas o pagamento ainda não chegou até aqui.\n\n' +
    '*Seu horário fica guardado por mais 5 minutos.* Depois disso ele volta para a lista ' +
    'e outra pessoa pode escolher.\n\n' +
    'Se quiser seguir, é só concluir o pagamento na tela onde você parou. ' +
    'Se preferir, me avise aqui que eu te mando o código de novo.\n\n' +
    'Para você saber o que vem depois:\n' +
    '1. o Pix cai e a consulta entra na agenda na hora\n' +
    '2. o link da videochamada chega aqui no WhatsApp\n' +
    '3. a conversa com o médico dura de 10 a 15 minutos\n\n' +
    'Se mudou de ideia, não precisa fazer nada. O horário volta sozinho e ninguém é cobrado.';
}
function textoWhatsDiaSeguinte(nome) {
  return 'Olá, ' + primeiroNome(nome) + '! Aqui é da Consultaí.\n\n' +
    'Ontem você começou a agendar uma consulta e o pagamento não foi concluído. ' +
    'O horário que você tinha escolhido já voltou para a lista, mas tem outros abertos.\n\n' +
    'Em vez de insistir, prefiro responder as três dúvidas que mais aparecem:\n\n' +
    '*É médico mesmo?*\nDr. João Pedro Vieira do Prado, Médico, CRM-SP 281.239. ' +
    'O registro é público e dá para conferir no site do Conselho Federal de Medicina.\n\n' +
    '*Vou sair com atestado?*\nDepende da avaliação. Não vendemos documento e não prometemos o que não podemos.\n\n' +
    '*Será que serve para o meu caso?*\nEscrevi um texto sobre exatamente isso:\n' +
    'vemconsultai.com.br/blog/o-que-consulta-online-nao-resolve\n\n' +
    'Se quiser agendar: vemconsultai.com.br/agendamento\n' +
    'E se ficou outra dúvida, pode perguntar aqui, sem compromisso.\n\n' +
    'Não atendemos urgência nem emergência. Nesses casos, pronto-socorro ou 192 (SAMU).';
}
/* Aviso ao médico com o botão pronto, usado nos dois momentos do Pix não pago. */
async function avisarWhatsRecuperacao(m, qual) {
  const tel = m.telefone || '';
  const texto = qual === 1 ? textoWhatsPixPendente(m.nome, m.horario) : textoWhatsDiaSeguinte(m.nome);
  const titulo = qual === 1 ? 'Pix pendente: horário ainda reservado' : 'Pix não pago ontem';
  const corpo =
    '<p style="margin:0 0 6px"><b>' + escHtml(m.nome || '—') + '</b> · ' +
    escHtml(dataBR(m.data)) + ' às <b>' + escHtml(m.horario) + '</b> · ' + escHtml(tel || '—') + '</p>' +
    '<p style="margin:0;color:#5C7178;font-size:13.5px">' +
    (qual === 1
      ? 'Gerou o Pix há uns 7 minutos e não pagou. O horário ainda está travado.'
      : 'Gerou o Pix ontem e não pagou. O horário já voltou para a lista.') + '</p>' +
    botaoWhats(tel, texto, 'Enviar WhatsApp pro paciente');
  try {
    await enviarEmail(NOTIF_EMAIL_TO || NOTIF_EMAIL_FROM,
      titulo + ' — ' + (m.nome || 'paciente'),
      emailShell(titulo, corpo, qual === 1 ? '#FF6B4A' : '#0F766E'));
    console.log('[whats] aviso ' + qual + ' enviado ao médico — ' + (m.nome || ''));
  } catch (e) { console.error('[whats] falha no aviso ' + qual + ': ' + e.message); }
}
async function avisarNovaConsulta(p, protocolo, paymentId) {
  const dt = dataBR(p.slot.data);
  const corpo = `
    <p style="margin:0"><b>${escHtml(p.paciente.nome || '—')}</b> pagou e agendou:</p>
    ${cardConsulta(p, protocolo)}
    <table style="border-collapse:collapse;width:100%;font-size:15px">
      <tr><td style="padding:5px 0;color:#5C7178">WhatsApp</td><td>${escHtml(p.paciente.telefone || '—')}</td></tr>
      <tr><td style="padding:5px 0;color:#5C7178">E-mail</td><td>${escHtml(p.paciente.email || '—')}</td></tr>
      <tr><td style="padding:5px 0;color:#5C7178">Nascimento</td><td>${escHtml(p.paciente.dataNascimento || '—')}</td></tr>
      <tr><td style="padding:5px 0;color:#5C7178">Pagamento MP</td><td>${escHtml(String(paymentId))}</td></tr>
    </table>
    <p style="margin:16px 0 0;color:#5C7178;font-size:13px">Já está na agenda do Shosp. Abra a consulta e <b>confirme o paciente</b> para gerar o link da telemedicina.</p>
    ${botaoWhats(p.paciente.telefone, textoWhatsConfirmada(p.paciente.nome, p.slot.data, p.slot.horario), 'Enviar confirmação no WhatsApp')}`;
  try {
    if (await enviarEmail(NOTIF_EMAIL_TO || NOTIF_EMAIL_FROM, 'Nova consulta: ' + dt + ' às ' + p.slot.horario + ' — ' + (p.paciente.nome || 'paciente'), emailShell('Nova consulta confirmada', corpo))) {
      console.log('[email] aviso interno enviado (' + dt + ' ' + p.slot.horario + ')');
    }
  } catch (e) { console.error('[email] falha no aviso interno: ' + e.message); }
}
async function confirmarPaciente(p, protocolo) {
  if (!p.paciente.email) return;
  const dt = dataBR(p.slot.data);
  const corpo = `
    <p style="margin:0">Olá, <b>${escHtml((p.paciente.nome || '').split(' ')[0])}</b>! Seu pagamento foi aprovado e sua consulta está marcada.</p>
    ${cardConsulta(p, protocolo)}
    ${itemLista('O <b>link da videochamada</b> chega no seu WhatsApp pouco antes do horário.')}
    ${itemLista('Esteja num lugar tranquilo e com boa internet.')}
    ${itemLista('Tenha em mãos seus exames ou receitas anteriores, se tiver.')}
    <p style="margin:12px 0 0;color:#5C7178;font-size:13px">Precisa reagendar? É só chamar no WhatsApp <a href="https://wa.me/5511976544002" style="color:#0F766E;text-decoration:none"><b>(11) 97654-4002</b></a>.</p>`;
  try {
    if (await enviarEmail(p.paciente.email, 'Consulta confirmada — ' + dt + ' às ' + p.slot.horario + ' | Consultaí', emailShell('Consulta confirmada', corpo))) {
      console.log('[email] confirmação enviada ao paciente ' + p.paciente.email);
    }
  } catch (e) { console.error('[email] falha na confirmação ao paciente: ' + e.message); }
}
// Reserva temporária dos dados do paciente até o Pix ser confirmado.
// (em memória — para MVP. Em produção, troque por um banco de dados.)
const pendentes = new Map();
const agendando = new Set(); // pagamentos em processo de agendamento — trava anti-corrida (polling + webhook)
/* Trava de horário: quando um paciente gera o Pix, o horário fica "reservado"
   por 12 min (tempo de vida do Pix). Enquanto travado, some da lista dos outros.
   Pagou -> vira reserva firme. Não pagou -> destrava sozinho. Evita 2 pessoas
   pagarem o mesmo horário. */
const travas = new Map(); // chave `data|horario` -> expira em (ms)
const TRAVA_MS = 12 * 60 * 1000;
// IMPORTANTE: travar pelo HORÁRIO específico (ex.: "09:00"), NÃO pelo codigoHorario.
// No Shosp, um mesmo codigoHorario cobre um BLOCO inteiro de horários (ex.: 07:00–19:20),
// então travar pelo código escondia o dia todo por 12 min sempre que alguém iniciava um
// checkout. Pelo horário, trava apenas aquele slot exato.
const chaveTrava = (data, horario) => String(data) + '|' + String(horario);
function travar(data, horario) { travas.set(chaveTrava(data, horario), Date.now() + TRAVA_MS); }
function destravar(data, horario) { travas.delete(chaveTrava(data, horario)); }
function estaTravado(data, horario) {
  const exp = travas.get(chaveTrava(data, horario));
  if (!exp) return false;
  if (Date.now() > exp) { travas.delete(chaveTrava(data, horario)); return false; } // expirou
  return true;
}
/* ----------------------------- Shosp ----------------------------------- */
async function shospRequest(pathname, formObj, modo) {
  const headers = { 'x-api-key': SHOSP_API_KEY, 'id': SHOSP_ID, 'accept': 'application/json' };
  let body;
  if (modo === 'multipart') {
    body = new FormData(); // igual ao Swagger — o fetch define o boundary sozinho
    Object.entries(formObj).forEach(([k, v]) => body.append(k, String(v)));
  } else {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(formObj).toString();
  }
  const r = await fetch(SHOSP_BASE + pathname, { method: 'POST', headers, body });
  const txt = await r.text();
  let data; try { data = JSON.parse(txt); } catch { data = txt; }
  if (!r.ok) throw new Error('Shosp ' + r.status + ': ' + txt);
  // O Shosp às vezes devolve uma TELA DE ERRO com status 200 — detecta e trata como falha:
  if (typeof data === 'string' && /<script|alerta\(|algo deu errado|comportou mal/i.test(data)) {
    const e = new Error('Shosp retornou erro interno: ' + txt.replace(/\s+/g, ' ').slice(0, 200));
    e.shospInterno = true;
    throw e;
  }
  return data;
}
async function shosp(pathname, formObj) {
  try {
    return await shospRequest(pathname, formObj, 'urlencoded');
  } catch (e) {
    if (!e.shospInterno) throw e;
    console.log('[shosp] erro interno com urlencoded em ' + pathname + ' — tentando multipart/form-data…');
    return await shospRequest(pathname, formObj, 'multipart');
  }
}
async function shospGet(pathname, queryObj) {
  const qs = new URLSearchParams(queryObj).toString();
  const r = await fetch(SHOSP_BASE + pathname + '?' + qs, {
    headers: { 'x-api-key': SHOSP_API_KEY, 'id': SHOSP_ID, 'accept': 'application/json' },
  });
  const txt = await r.text();
  let data; try { data = JSON.parse(txt); } catch { data = txt; }
  if (!r.ok) throw new Error('Shosp GET ' + r.status + ': ' + txt);
  return data;
}
/* Acha o código do paciente na resposta da busca.
   Na busca (/cadastro/paciente) o Shosp chama o código de "prontuario".
   Critério seguro: CPF igual > nome exato > resultado único. Nunca chuta. */
function acharCodigoPaciente(data, alvo) {
  const lista = [];
  (function walk(n) {
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n && typeof n === 'object') {
      if (n.prontuario != null || n.codigoPaciente != null) { lista.push(n); return; }
      Object.values(n).forEach(walk);
    }
  })(data);
  if (!lista.length) return null;
  const cod = (x) => (x.prontuario != null ? x.prontuario : x.codigoPaciente);
  const cpfA = alvo && alvo.cpf ? String(alvo.cpf).replace(/\D/g, '') : '';
  if (cpfA) {
    const m = lista.find(x => String(x.cpf || '').replace(/\D/g, '') === cpfA);
    if (m) return cod(m);
  }
  const nmA = alvo && alvo.nome ? String(alvo.nome).trim().toLowerCase() : '';
  if (nmA) {
    const m = lista.find(x => String(x.nome || '').trim().toLowerCase() === nmA);
    if (m) return cod(m);
  }
  if (lista.length === 1) return cod(lista[0]);
  return null;
}
/* Busca em cascata: o Shosp exige que TODOS os parâmetros batam, então
   se nome+cpf não achar (ex.: cadastro sem CPF), tenta combinações mais soltas. */
async function buscarPaciente(paciente) {
  const cpf = paciente.cpf ? String(paciente.cpf).replace(/\D/g, '') : '';
  const primeiro = String(paciente.nome || '').trim().split(/\s+/)[0] || '';
  const tentativas = [];
  if (cpf) tentativas.push({ nome: paciente.nome, cpf });
  tentativas.push({ nome: paciente.nome });
  if (cpf && primeiro) tentativas.push({ nome: primeiro, cpf });
  if (paciente.email) tentativas.push({ nome: primeiro || paciente.nome, email: paciente.email });
  for (const q of tentativas) {
    try {
      const res = await shospGet('/cadastro/paciente', q);
      console.log('[agenda] busca paciente ' + JSON.stringify(q) + ' → ' + JSON.stringify(res).slice(0, 300));
      const cod = acharCodigoPaciente(res, paciente);
      if (cod != null) return cod;
    } catch (e) {
      console.log('[agenda] busca ' + JSON.stringify(q) + ' falhou: ' + e.message);
    }
  }
  return null;
}
/* Normaliza a resposta de /agenda/get/ em uma lista simples:
   [{ data:'YYYY-MM-DD', horario:'HH:MM', codigoHorario:123 }]
   OBS: a forma exata do JSON do Shosp só dá pra confirmar com uma chamada
   real. Este coletor é defensivo; se vier vazio, me mande um exemplo da
   resposta que eu ajusto 1 linha. */
function normalizarHorarios(data) {
  const out = [];
  (function walk(node, ctxData) {
    if (Array.isArray(node)) { node.forEach((n) => walk(n, ctxData)); return; }
    if (node && typeof node === 'object') {
      const d = node.data || node.dataAgenda || node.dia || ctxData;
      const horario = node.horario || node.hora;
      if (node.codigoHorario != null && horario) {
        const disp = node.disponivel ?? node.livre ??
          (node.status ? /dispon|livre/i.test(String(node.status)) : true);
        if (disp !== false) out.push({ data: d, horario, codigoHorario: node.codigoHorario });
      }
      Object.values(node).forEach((v) => walk(v, d));
    }
  })(data, null);
  return out;
}
/* --------------------------- Mercado Pago ------------------------------ */
async function mpCriarPix({ valor, email, nome, idem, metadata }) {
  const r = await fetch('https://api.mercadopago.com/v1/payments', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + MP_ACCESS_TOKEN,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': idem,
    },
    body: JSON.stringify({
      transaction_amount: Number(valor),
      description: 'Consulta médica online — Consultaí',
      payment_method_id: 'pix',
      payer: { email, first_name: (nome || '').split(' ')[0] || 'Paciente' },
      // Os dados da reserva viajam DENTRO do pagamento: se o servidor
      // reiniciar, a reserva é reconstruída a partir daqui.
      metadata: metadata || {},
    }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error('MercadoPago ' + r.status + ': ' + JSON.stringify(d));
  const tx = (d.point_of_interaction && d.point_of_interaction.transaction_data) || {};
  return { id: d.id, copiaECola: tx.qr_code, qrBase64: tx.qr_code_base64, ticketUrl: tx.ticket_url };
}
async function mpGetPayment(id) {
  const r = await fetch('https://api.mercadopago.com/v1/payments/' + id, {
    headers: { 'Authorization': 'Bearer ' + MP_ACCESS_TOKEN },
  });
  const d = await r.json();
  if (!r.ok) throw new Error('MercadoPago status ' + r.status + ': ' + JSON.stringify(d));
  return d;
}
async function mpStatus(id) {
  return (await mpGetPayment(id)).status; // pending | approved | rejected ...
}
/* Confere se o aviso (webhook) veio mesmo do Mercado Pago.
   O MP assina cada notificação com um segredo que fica no painel dele. Aqui a
   gente refaz a mesma conta e compara. Sem MP_WEBHOOK_SECRET definido, a
   checagem é ignorada e nada muda no funcionamento atual. */
function validarAssinaturaMP(req) {
  if (!MP_WEBHOOK_SECRET) return { ok: true, motivo: 'validação desligada (sem MP_WEBHOOK_SECRET)' };
  try {
    const bruto = String(req.headers['x-signature'] || '');
    if (!bruto) return { ok: false, motivo: 'sem cabeçalho x-signature' };
    const partes = {};
    bruto.split(',').forEach((p) => {
      const i = p.indexOf('=');
      if (i > 0) partes[p.slice(0, i).trim()] = p.slice(i + 1).trim();
    });
    const ts = partes.ts, v1 = partes.v1;
    if (!ts || !v1) return { ok: false, motivo: 'x-signature incompleto' };
    const dataId = String((req.body && req.body.data && req.body.data.id) || req.query['data.id'] || '');
    const reqId = String(req.headers['x-request-id'] || '');
    // Modelo do MP: id:<data.id>;request-id:<x-request-id>;ts:<ts>;
    // Partes ausentes são simplesmente omitidas.
    let manifest = '';
    if (dataId) manifest += 'id:' + dataId.toLowerCase() + ';';
    if (reqId) manifest += 'request-id:' + reqId + ';';
    manifest += 'ts:' + ts + ';';
    const calculado = crypto.createHmac('sha256', MP_WEBHOOK_SECRET).update(manifest).digest('hex');
    const a = Buffer.from(calculado, 'utf8');
    const b = Buffer.from(String(v1), 'utf8');
    const confere = a.length === b.length && crypto.timingSafeEqual(a, b);
    return { ok: confere, motivo: confere ? '' : 'assinatura não confere' };
  } catch (e) {
    return { ok: false, motivo: 'erro ao validar: ' + e.message };
  }
}
/* --------------------- Meta CAPI (Conversions API) ----------------------
   Envia os eventos de conversão pelo SERVIDOR, direto à Meta. Isso recupera
   as vendas que o pixel do navegador NÃO consegue registrar (o navegador
   dentro do Instagram/Facebook bloqueia cookies e scripts). O mesmo evento é
   deduplicado com o pixel pelo event_id — a Meta junta os dois e conta 1 só.
   Dados pessoais (e-mail, telefone, CPF, nome) são enviados com hash SHA-256,
   como a Meta exige. Sem META_CAPI_TOKEN definido, vira um no-op silencioso. */
function _sha256(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s) return null;
  return crypto.createHash('sha256').update(s).digest('hex');
}
function _hashTelefone(tel) {
  let d = String(tel || '').replace(/\D/g, '');
  if (!d) return null;
  if (!d.startsWith('55')) d = '55' + d; // padrão internacional (Brasil)
  return crypto.createHash('sha256').update(d).digest('hex');
}
function _construirUserData(paciente, tracking) {
  const t = tracking || {};
  const ud = {};
  const nome = String(paciente.nome || '').trim();
  const primeiro = nome.split(/\s+/)[0] || '';
  const ultimo = nome.split(/\s+/).slice(1).join(' ');
  const cpf = String(paciente.cpf || '').replace(/\D/g, '');
  const em = _sha256(paciente.email);
  const ph = _hashTelefone(paciente.telefone);
  const fn = _sha256(primeiro);
  const ln = _sha256(ultimo);
  const ext = cpf ? crypto.createHash('sha256').update(cpf).digest('hex') : null;
  if (em) ud.em = [em];
  if (ph) ud.ph = [ph];
  if (fn) ud.fn = [fn];
  if (ln) ud.ln = [ln];
  if (ext) ud.external_id = [ext];        // CPF com hash = casamento forte
  if (t.ip) ud.client_ip_address = t.ip;  // IP e user-agent NÃO levam hash
  if (t.ua) ud.client_user_agent = t.ua;
  if (t.fbp) ud.fbp = t.fbp;              // cookies do pixel = casamento ainda melhor
  if (t.fbc) ud.fbc = t.fbc;
  return ud;
}
async function enviarEventoCapi(eventName, eventId, paciente, tracking, extra) {
  if (!META_CAPI_TOKEN) {
    console.log('[capi] não configurado (defina META_CAPI_TOKEN) — ' + eventName + ' não enviado');
    return false;
  }
  try {
    const evento = {
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      event_id: eventId, // MESMO id do pixel do navegador → deduplicação
      action_source: 'website',
      event_source_url: (tracking && tracking.eventSourceUrl) || 'https://vemconsultai.com.br/agendamento',
      user_data: _construirUserData(paciente || {}, tracking),
      custom_data: Object.assign({ currency: 'BRL', value: Number(PRECO) }, extra || {}),
    };
    const corpo = { data: [evento] };
    if (META_TEST_EVENT_CODE) corpo.test_event_code = META_TEST_EVENT_CODE;
    const url = 'https://graph.facebook.com/v21.0/' + META_DATASET_ID +
      '/events?access_token=' + encodeURIComponent(META_CAPI_TOKEN);
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('[capi] erro ' + r.status + ' em ' + eventName + ': ' + JSON.stringify(d).slice(0, 250));
      return false;
    }
    console.log('[capi] ✔ ' + eventName + ' enviado (event_id ' + eventId + ', ' +
      Object.keys(evento.user_data).length + ' campos de casamento)');
    return true;
  } catch (e) {
    console.error('[capi] falha ao enviar ' + eventName + ': ' + e.message);
    return false;
  }
}
/* Garante que o paciente existe no cadastro com a ficha completa (incl. celular).
   Tenta cadastrar via POST /cadastro/paciente; se já existir, busca o código. */
async function garantirPaciente(paciente) {
  const form = {
    nome: paciente.nome,
    sexo: paciente.sexo,
    dataNascimento: paciente.dataNascimento,
    telefone: paciente.telefone,
    celular: paciente.telefone, // o número do chatbot é celular — grava nos 2 campos
    email: paciente.email,
  };
  if (paciente.cpf) form.cpf = String(paciente.cpf).replace(/\D/g, '');
  try {
    const r = await shosp('/cadastro/paciente', form);
    console.log('[cadastro] resposta: ' + JSON.stringify(r).slice(0, 250));
    if (r && r.ret === '1') {
      const cod = acharCodigoPaciente(r, paciente);
      if (cod != null) return cod;
    }
  } catch (e) {
    console.log('[cadastro] criação falhou (' + String(e.message).slice(0, 120) + ') — buscando existente…');
  }
  return await buscarPaciente(paciente);
}
/* Motor de agendamento no Shosp — usado pela produção E pelo diagnóstico.
   Trata a recusa "paciente já cadastrado" buscando o codigoPaciente e reagendando. */
async function agendarNoShosp(p, tag) {
  const form = {
    codigoPrestador: COD_PRESTADOR,
    codigoUnidade: COD_UNIDADE,
    codigoServico: COD_SERVICO,
    codigoPlanoSaude: COD_PLANO,
    data: p.slot.data,
    horario: p.slot.horario,
    codigoHorario: p.slot.codigoHorario,
    nome: p.paciente.nome,
    telefone: p.paciente.telefone,
    celular: p.paciente.telefone, // o Shosp tem 2 campos; o número do chatbot é celular
    email: p.paciente.email,
    dataNascimento: p.paciente.dataNascimento,
    sexo: p.paciente.sexo,
  };
  if (p.paciente.cpf) form.cpf = String(p.paciente.cpf).replace(/\D/g, '');
  if (COD_ESPECIALIDADE) form.codigoEspecialidade = COD_ESPECIALIDADE;
  // Cadastra/acha o paciente ANTES (ficha completa, com celular) e agenda pelo código
  try {
    const codPrevio = await garantirPaciente(p.paciente);
    if (codPrevio != null) { form.codigoPaciente = codPrevio; console.log('[agenda] usando codigoPaciente ' + codPrevio); }
  } catch (e) { console.log('[agenda] garantirPaciente falhou: ' + e.message); }
  console.log('[agenda] enviando ao Shosp (' + tag + '): ' + JSON.stringify(form));
  let r = await shosp('/agenda/', form);
  console.log('[agenda] resposta do Shosp (' + tag + '): ' + JSON.stringify(r).slice(0, 400));
  // O Shosp sinaliza sucesso com ret:"1". ret:"0" é RECUSA (ex.: paciente já cadastrado).
  if (!r || r.ret !== '1') {
    const msg = (r && (r.msg || r.mensagem)) || JSON.stringify(r);
    if (/j[áa] foi cadastrado/i.test(msg)) {
      console.log('[agenda] paciente já existe no Shosp — buscando codigoPaciente…');
      const cod = await buscarPaciente(p.paciente);
      if (cod == null) throw new Error('Shosp: paciente já cadastrado, mas nenhuma busca retornou o codigoPaciente');
      console.log('[agenda] codigoPaciente encontrado: ' + cod + ' — reagendando com ele…');
      r = await shosp('/agenda/', { ...form, codigoPaciente: cod });
      console.log('[agenda] resposta do reagendamento (' + tag + '): ' + JSON.stringify(r).slice(0, 400));
      if (!r || r.ret !== '1') {
        throw new Error('Shosp recusou o agendamento (mesmo com codigoPaciente): ' + ((r && (r.msg || r.mensagem)) || JSON.stringify(r)));
      }
    } else {
      throw new Error('Shosp recusou o agendamento: ' + msg);
    }
  }
  return r;
}
/* Cria o agendamento no Shosp (idempotente: só agenda uma vez por pagamento) */
async function efetivarAgendamento(paymentId) {
  let p = pendentes.get(String(paymentId));
  if (!p) {
    // Reserva perdida (servidor reiniciou)? Reconstrói do metadata do pagamento.
    // OBS: o Mercado Pago converte as chaves do metadata para minúsculas.
    try {
      const pay = await mpGetPayment(paymentId);
      const m = pay.metadata || {};
      if (m.data && m.horario && m.codigohorario != null) {
        p = {
          paciente: { nome: m.nome, cpf: m.cpf, telefone: m.telefone, email: m.email, dataNascimento: m.datanascimento, sexo: m.sexo },
          slot: { data: m.data, horario: m.horario, codigoHorario: m.codigohorario },
          // ip e ua também viajam no metadata: sem eles, o evento recuperado
          // chegaria à Meta com menos sinais de casamento (EMQ mais baixo).
          tracking: { ip: m.ip, ua: m.ua, fbp: m.fbp, fbc: m.fbc, eventSourceUrl: 'https://vemconsultai.com.br/agendamento' },
          booked: false,
        };
        pendentes.set(String(paymentId), p);
        console.log('[recuperação] reserva reconstruída do metadata — pagamento ' + paymentId);
      }
    } catch (e) {
      console.error('[recuperação] falhou ao ler pagamento ' + paymentId + ': ' + e.message);
    }
  }
  if (!p) {
    console.error('[agenda] pagamento ' + paymentId + ' sem reserva e sem metadata — impossível agendar');
    return { agendado: false, motivo: 'pagamento sem reserva associada' };
  }
  if (p.booked) return { agendado: true, protocolo: p.protocolo, jaAgendado: true };
  // Trava síncrona anti-corrida: o polling do navegador e o webhook do MP podem
  // chamar quase juntos. Como marcamos ANTES de qualquer await, só o primeiro segue;
  // o segundo sai aqui, evitando agendamento duplicado no Shosp.
  if (agendando.has(String(paymentId))) return { agendado: false, emAndamento: true };
  agendando.add(String(paymentId));
  let r;
  try {
    r = await agendarNoShosp(p, 'pagamento ' + paymentId);
  } catch (e) {
    agendando.delete(String(paymentId)); // libera para nova tentativa
    // REDE DE SEGURANÇA: paciente pagou mas o Shosp recusou (ex.: colisão de horário
    // que escapou da trava). Alerta o médico na hora para resolver manualmente — o
    // dinheiro já entrou, então honramos o atendimento de um jeito ou de outro.
    console.error('[agenda] ⚠ FALHA pós-pagamento ' + paymentId + ': ' + e.message);
    alertarFalhaAgendamento(p, paymentId, e.message);
    throw e;
  }
  agendando.delete(String(paymentId));
  destravar(p.slot.data, p.slot.horario); // reserva virou firme
  p.booked = true;
  p.protocolo = (r && r.dados && (r.dados.codigoAgendamento || r.dados.protocolo)) ||
                (r && (r.protocolo || r.codigo || r.id)) || ('CS-' + paymentId);
  pendentes.set(String(paymentId), p);
  console.log('[agenda] ✔ consulta agendada — ' + p.slot.data + ' ' + p.slot.horario + ' — ' + (p.paciente.nome || '') + ' — protocolo ' + p.protocolo);
  avisarNovaConsulta(p, p.protocolo, paymentId); // aviso interno em segundo plano
  confirmarPaciente(p, p.protocolo);             // confirmação ao paciente em segundo plano
  // VENDA pela CAPI: mesmo event_id do pixel do navegador ('purchase_'+protocolo) → sem contagem dupla.
  enviarEventoCapi('Purchase', 'purchase_' + p.protocolo, p.paciente, p.tracking, { content_name: 'Consulta médica online' })
    .catch(() => {}); // em segundo plano — não trava o agendamento
  return { agendado: true, protocolo: p.protocolo };
}
/* Alerta urgente ao médico quando um pagamento aprovado NÃO virou agenda */
async function alertarFalhaAgendamento(p, paymentId, motivo) {
  try {
    const corpo = `
      <p style="margin:0 0 12px;color:#9a2a12;font-weight:bold">Um paciente PAGOU mas a consulta não entrou na agenda. Resolva manualmente e entre em contato com ele.</p>
      <table style="border-collapse:collapse;width:100%;font-size:15px">
        <tr><td style="padding:5px 0;color:#5C7178">Paciente</td><td><b>${escHtml(p.paciente.nome || '—')}</b></td></tr>
        <tr><td style="padding:5px 0;color:#5C7178">Horário desejado</td><td>${dataBR(p.slot.data)} · ${p.slot.horario}</td></tr>
        <tr><td style="padding:5px 0;color:#5C7178">WhatsApp</td><td>${escHtml(p.paciente.telefone || '—')}</td></tr>
        <tr><td style="padding:5px 0;color:#5C7178">E-mail</td><td>${escHtml(p.paciente.email || '—')}</td></tr>
        <tr><td style="padding:5px 0;color:#5C7178">Pagamento MP</td><td>${paymentId}</td></tr>
        <tr><td style="padding:5px 0;color:#5C7178">Motivo</td><td>${String(motivo).slice(0, 160)}</td></tr>
      </table>`;
    await enviarEmail(NOTIF_EMAIL_TO || NOTIF_EMAIL_FROM, 'URGENTE: pagamento sem agenda — ' + (p.paciente.nome || 'paciente'), emailShell('Pagamento sem agenda', corpo, '#c0392b'));
  } catch (e) { console.error('[alerta] falhou: ' + e.message); }
}
/* ------------------------------ Rotas ---------------------------------- */
app.get('/api/horarios', async (req, res) => {
  try {
    const { dataInicial, dias = '14' } = req.query;
    if (!dataInicial) return res.status(400).json({ ok: false, erro: 'informe dataInicial' });
    const data = await shosp('/agenda/get/', {
      codigoUnidade: COD_UNIDADE,
      codigoPrestador: COD_PRESTADOR,
      dataInicial,
      diasMostrar: dias,
    });
    // Remove horários que já passaram (ou que começam em menos de 20 min),
    // no fuso de São Paulo (UTC-3):
    const MARGEM_MIN = 20;
    const sp = new Date(Date.now() - 3 * 3600 * 1000 + MARGEM_MIN * 60 * 1000);
    const hojeSP = sp.toISOString().slice(0, 10);
    const horaMin = sp.toISOString().slice(11, 16);
    const slots = normalizarHorarios(data)
      .filter(s => String(s.data) > hojeSP || (String(s.data) === hojeSP && String(s.horario) >= horaMin))
      .filter(s => !estaTravado(s.data, s.horario)); // esconde APENAS o horário reservado em checkout
    res.json({ ok: true, slots });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});
app.post('/api/checkout', rateLimit(8, 10 * 60 * 1000), async (req, res) => {
  try {
    const { nome, cpf, telefone, email, dataNascimento, sexo, data, horario, codigoHorario } = req.body;
    if (!nome || !email || !data || !horario || codigoHorario == null) {
      return res.status(400).json({ ok: false, erro: 'dados incompletos' });
    }
    // Dados de rastreio p/ a CAPI (vêm do navegador do paciente): IP, aparelho e
    // cookies do pixel (_fbp/_fbc). Melhoram muito o "casamento" do evento na Meta.
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const ua = String(req.headers['user-agent'] || '');
    const fbp = req.body._fbp || '';
    let fbc = req.body._fbc || '';
    if (!fbc && req.body.fbclid) fbc = 'fb.1.' + Date.now() + '.' + req.body.fbclid;
    const tracking = { ip, ua, fbp, fbc, eventSourceUrl: req.body.pageUrl || 'https://vemconsultai.com.br/agendamento' };
    /* Identificador do clique no Google Ads.                (29/08/2026)
       Lido do cookie que a tag injetada gravou quando o paciente chegou
       pelo anúncio. Vem pelo cabeçalho Cookie sozinho, então NÃO foi
       preciso mexer em nenhum arquivo do site para isto funcionar.
       Vai junto no metadata do pagamento porque o Mercado Pago é a nossa
       única memória que sobrevive a um reinício do servidor, e é de lá
       que o CSV de conversões pagas é montado depois. */
    const gclid  = String(req.body.gclid  || lerCookie(req, 'cs_gclid')  || '').slice(0, 200);
    const wbraid = String(req.body.wbraid || lerCookie(req, 'cs_wbraid') || '').slice(0, 200);
    const gbraid = String(req.body.gbraid || lerCookie(req, 'cs_gbraid') || '').slice(0, 200);
    const idem = 'consultai-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
    const pay = await mpCriarPix({
      valor: PRECO, email, nome, idem,
      // fbp/fbc/ip/ua viajam no metadata p/ sobreviver a um reinício do servidor
      metadata: { nome, cpf, telefone, email, datanascimento: dataNascimento, sexo, data, horario, codigohorario: codigoHorario, fbp, fbc, ip, ua: ua.slice(0, 250), gclid, wbraid, gbraid },
    });
    pendentes.set(String(pay.id), {
      paciente: { nome, cpf, telefone, email, dataNascimento, sexo },
      slot: { data, horario, codigoHorario },
      tracking,
      booked: false,
    });
    travar(data, horario); // reserva SÓ este horário por 12 min — some da lista dos outros
    console.log('[checkout] Pix criado — pagamento ' + pay.id + ' — ' + data + ' ' + horario + ' — ' + nome + ' (horário travado)');
    // Início de agendamento pela CAPI (mesmo id do pixel: 'ic_'+pay.id → sem duplicar).
    enviarEventoCapi('InitiateCheckout', 'ic_' + pay.id, { nome, cpf, telefone, email }, tracking).catch(() => {});
    res.json({ ok: true, paymentId: pay.id, copiaECola: pay.copiaECola, qrBase64: pay.qrBase64, ticketUrl: pay.ticketUrl, valor: Number(PRECO) });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});
app.get('/api/checkout/:id', async (req, res) => {
  try {
    const id = String(req.params.id);
    const status = await mpStatus(id);
    if (status === 'approved') {
      try {
        const r = await efetivarAgendamento(id);
        return res.json({ ok: true, status, ...r });
      } catch (e) {
        // Pagou, mas o agendamento falhou. NÃO derruba o fluxo do paciente:
        // o alerta interno já foi disparado; devolvemos aprovado + agendado:false
        // para o front mostrar "pagamento recebido, confirmando manualmente".
        console.error('[checkout/status] pago mas sem agenda ' + id + ': ' + e.message);
        return res.json({ ok: true, status, agendado: false });
      }
    }
    res.json({ ok: true, status });
  } catch (e) {
    console.error('[checkout/status] erro no pagamento ' + req.params.id + ': ' + e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
});
// Webhook do Mercado Pago (configure a URL no painel do MP)
app.post('/api/webhook', async (req, res) => {
  try {
    // Confere a assinatura do MP. Em modo normal apenas registra no log quando
    // não bate; só bloqueia de verdade se MP_WEBHOOK_STRICT estiver ligado.
    const v = validarAssinaturaMP(req);
    if (!v.ok) {
      console.warn('[webhook] ⚠ assinatura não validada: ' + v.motivo);
      if (MP_WEBHOOK_STRICT === '1') {
        console.warn('[webhook] modo estrito ativo — aviso recusado');
        return res.sendStatus(401);
      }
    }
    const id = (req.body && req.body.data && req.body.data.id) || req.query['data.id'];
    console.log('[webhook] notificação recebida do MP — id: ' + (id || '(sem id)'));
    if (id) {
      // Segurança de fato: nunca confiamos no corpo do aviso. Sempre perguntamos
      // ao Mercado Pago qual é o status real do pagamento antes de agendar.
      const status = await mpStatus(String(id));
      console.log('[webhook] pagamento ' + id + ' status: ' + status);
      if (status === 'approved') await efetivarAgendamento(String(id));
    }
  } catch (e) {
    console.error('webhook erro:', e.message);
  }
  res.sendStatus(200); // sempre 200 para o MP não reenviar infinitamente
});
// Formulário "Trabalhe conosco" — envia a mensagem por e-mail via Brevo
app.post('/api/contato', rateLimit(5, 10 * 60 * 1000), async (req, res) => {
  try {
    const { nome, email, assunto, mensagem, site } = req.body || {};
    if (site) return res.json({ ok: true }); // honeypot: robôs de spam preenchem este campo invisível
    if (!nome || !email || !assunto || !mensagem) {
      return res.status(400).json({ ok: false, erro: 'preencha todos os campos' });
    }
    const corpo = `
      <p style="margin:0 0 10px">Nova mensagem enviada pelo site (página Trabalhe conosco):</p>
      <table style="border-collapse:collapse;width:100%;font-size:15px">
        <tr><td style="padding:5px 0;color:#5C7178">Nome</td><td>${escHtml(String(nome).slice(0, 120))}</td></tr>
        <tr><td style="padding:5px 0;color:#5C7178">E-mail</td><td>${escHtml(String(email).slice(0, 120))}</td></tr>
        <tr><td style="padding:5px 0;color:#5C7178">Assunto</td><td>${escHtml(String(assunto).slice(0, 150))}</td></tr>
      </table>
      <div style="background:#F1FBF9;border-radius:10px;padding:14px 16px;margin-top:12px;white-space:pre-wrap">${escHtml(String(mensagem).slice(0, 4000))}</div>
      <p style="margin:14px 0 0;color:#5C7178;font-size:13px">Para responder, é só responder este e-mail — vai direto pro remetente.</p>`;
    await enviarEmail(
      NOTIF_EMAIL_TO || NOTIF_EMAIL_FROM,
      'Trabalhe conosco: ' + String(assunto).slice(0, 80) + ' — ' + String(nome).slice(0, 60),
      emailShell('Nova mensagem — Trabalhe conosco', corpo),
      String(email).slice(0, 120)
    );
    console.log('[contato] mensagem recebida de ' + String(email).slice(0, 120));
    res.json({ ok: true });
  } catch (e) {
    console.error('[contato] erro: ' + e.message);
    res.status(500).json({ ok: false, erro: 'não foi possível enviar agora' });
  }
});
app.get('/api/health', (req, res) => res.json({ ok: true, servico: 'consultai-backend' }));
/* ======================================================================
   CONVERSÕES PAGAS PARA O GOOGLE ADS                      (29/08/2026)
   ----------------------------------------------------------------------
   POR QUE ISTO EXISTE. A consulta é paga por Pix. O Pix compensa do lado
   do servidor, minutos depois, com o navegador do paciente possivelmente
   já fechado. Uma tag que roda no navegador não enxerga esse momento.
   Se a gente contasse a conversão na tela do "Pix gerado", estaria
   medindo intenção e ensinando o Google a comprar cliques de quem gera
   Pix e não paga.

   COMO FUNCIONA. Este endereço devolve, em CSV, os pagamentos APROVADOS
   dos últimos 90 dias que vieram de um clique no anúncio. O Google Ads
   busca este endereço sozinho, uma vez por dia (Metas > Uploads >
   Agendar uploads > HTTPS). Não há upload manual, não há chave de API,
   não há token de desenvolvedor.

   DE ONDE VÊM OS DADOS. Direto do Mercado Pago, não de um arquivo local.
   Isso é de propósito: o disco do Render é efêmero e some a cada
   publicação. O Mercado Pago é a única fonte que sabe de verdade quem
   pagou, e o gclid viaja no metadata do pagamento desde o /api/checkout.

   SEGURANÇA. A tela de upload agendado do Google só aceita um endereço
   HTTPS, sem cabeçalho de autenticação. Por isso a senha vai na própria
   URL, em GADS_CSV_TOKEN. Sem a variável, este endereço responde 403 e
   não vaza nada. Nenhum dado de saúde sai daqui: só o identificador do
   clique, a data, o valor e a moeda. Nome, CPF, e-mail e motivo da
   consulta NÃO entram no arquivo.
   ====================================================================== */
async function mpBuscarAprovados(desdeISO) {
  const fim = new Date().toISOString();
  const achados = [];
  for (let offset = 0; offset < 1000; offset += 50) {
    const url = 'https://api.mercadopago.com/v1/payments/search?status=approved' +
      '&range=date_approved&begin_date=' + encodeURIComponent(desdeISO) +
      '&end_date=' + encodeURIComponent(fim) + '&limit=50&offset=' + offset;
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + MP_ACCESS_TOKEN } });
    const d = await r.json();
    if (!r.ok) throw new Error('MP search aprovados ' + r.status + ': ' + JSON.stringify(d).slice(0, 150));
    const lote = d.results || [];
    achados.push(...lote);
    if (lote.length < 50) break;
  }
  return achados;
}
/* Data no formato que o Google Ads exige: "AAAA-MM-DD HH:MM:SS", no fuso
   declarado na primeira linha do arquivo. O Brasil acabou com o horário de
   verão em 2019, então é UTC-3 fixo, o mesmo truque já usado em /api/horarios. */
function horarioGoogleAds(iso) {
  const d = new Date(new Date(iso).getTime() - 3 * 3600 * 1000);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}
app.get('/api/google-ads/conversoes.csv', async (req, res) => {
  if (!GADS_CSV_TOKEN || String(req.query.token || '') !== GADS_CSV_TOKEN) {
    return res.status(403).type('text/plain').send('acesso negado');
  }
  const linhas = [
    'Parameters:TimeZone=America/Sao_Paulo',
    'Google Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency',
  ];
  try {
    // 89 dias, e não 90: o Google recusa qualquer conversão mais velha que a
    // janela de conversão da ação, e um dia de folga evita rejeição na virada.
    const desde = new Date(Date.now() - 89 * 24 * 3600 * 1000).toISOString();
    const pagamentos = await mpBuscarAprovados(desde);
    let comClique = 0;
    for (const pay of pagamentos) {
      const m = pay.metadata || {};   // o Mercado Pago devolve as chaves em minúsculas
      const clique = String(m.gclid || '').trim();
      if (!clique) continue;          // pagamento que não veio do Google Ads
      if (clique.includes(',') || clique.includes('"')) continue;  // nunca quebra o CSV
      const quando = horarioGoogleAds(pay.date_approved || pay.date_created);
      const valor = Number(pay.transaction_amount || PRECO).toFixed(2);
      linhas.push([clique, GADS_CONV_PAGA, quando, valor, 'BRL'].join(','));
      comClique++;
    }
    console.log('[google-ads] CSV servido — ' + pagamentos.length + ' pagamentos aprovados, ' + comClique + ' vindos de anúncio');
  } catch (e) {
    // Devolve o cabeçalho vazio em vez de erro: um upload agendado que recebe
    // 500 é marcado como falha no Google e enche a conta de aviso. Zero linha
    // é um resultado legítimo, e o motivo real fica no log.
    console.error('[google-ads] falha ao montar o CSV: ' + e.message);
  }
  res.header('Cache-Control', 'no-store');
  res.type('text/csv').send(linhas.join('\n') + '\n');
});
/* ------------- Lembrete de consulta (~10 min antes) via e-mail -------------
   A cada 3 min, busca no Mercado Pago os pagamentos aprovados e, quando uma
   consulta está a ~10 min de começar, envia um e-mail ao médico com um botão
   que abre o WhatsApp do paciente com a mensagem pronta (1 toque = enviado). */
const lembretesEnviados = new Set();
/* ======================================================================
   RECUPERAÇÃO DE PIX NÃO PAGO
   ----------------------------------------------------------------------
   O paciente preencheu os dados, o Pix foi gerado e o pagamento não veio.
   Dois avisos, aprovados pelo Dr. João em 05/08/2026:

     E-mail 1, aos 7 minutos  -> o horário AINDA está reservado (a trava dura
                                 12 min), então a frase "guardado por mais 5
                                 minutos" é verdadeira. Vai com o Pix dentro.
     E-mail 2, no dia seguinte -> sem urgência, convidando a escolher outro
                                 horário. Esse tem link de descadastro.

   >>> ATENÇÃO AO QUE OS 12 MINUTOS SÃO <<<
   Não é a validade do Pix. Em mpCriarPix a gente NÃO define date_of_expiration,
   então o código segue a validade padrão da conta no Mercado Pago, que é bem
   maior. Os 12 min são a TRAVA_MS, o tempo em que a gente segura o horário para
   não vender o mesmo slot duas vezes. Por isso o texto do e-mail fala em
   "horário reservado", nunca em "código vai expirar". Se um dia alguém mudar a
   TRAVA_MS, os 7 minutos aqui embaixo têm que mudar junto.

   POR QUE LER DO MERCADO PAGO E NÃO DA MEMÓRIA
   O mapa `pendentes` vive na memória do processo. Se o Render reinicia entre o
   checkout e o minuto 7, o registro some e o e-mail nunca sairia. Como todos os
   dados viajam dentro do metadata do próprio pagamento (ver mpCriarPix), dá
   para reconstruir tudo perguntando ao Mercado Pago quais pagamentos estão
   pendentes. É o que esta rotina faz.

   NATUREZA JURÍDICA: isto é e-mail TRANSACIONAL, não publicidade. Avisa sobre
   uma operação que a própria pessoa começou. Por isso o primeiro não tem oferta
   nem descadastro, e o segundo, que já se aproxima de marketing, tem.
   ====================================================================== */
const RECUPERACAO_LIGADA = String(RECUPERACAO).toLowerCase() === 'on';
const RECUP_MIN_1 = 7;            // minutos após criar o Pix
const RECUP_MIN_2 = 24 * 60;      // no dia seguinte
const recupEnviados = new Map();  // id -> { e1:bool, e2:bool }
const RECUP_ARQUIVO = path.join(__dirname, '.recuperacao.json');
/* Marcações gravadas em disco, para um reinício não reenviar o mesmo e-mail.
   Melhor esforço: se o disco for somente leitura, o servidor segue normalmente
   e o pior caso é um e-mail repetido depois de um reinício. */
(function carregarRecup() {
  try {
    const bruto = JSON.parse(fs.readFileSync(RECUP_ARQUIVO, 'utf8'));
    for (const [k, v] of Object.entries(bruto || {})) recupEnviados.set(k, v);
    console.log('[recuperacao] ' + recupEnviados.size + ' marcações lidas do disco');
  } catch (e) { /* primeira execução, ou disco somente leitura */ }
})();
function salvarRecup() {
  try { fs.writeFileSync(RECUP_ARQUIVO, JSON.stringify(Object.fromEntries(recupEnviados))); }
  catch (e) { /* melhor esforço */ }
}
async function mpBuscarPendentes() {
  const fim = new Date().toISOString();
  const ini = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
  const url = 'https://api.mercadopago.com/v1/payments/search?status=pending&range=date_created' +
    '&begin_date=' + encodeURIComponent(ini) + '&end_date=' + encodeURIComponent(fim) + '&limit=50';
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + MP_ACCESS_TOKEN } });
  const d = await r.json();
  if (!r.ok) throw new Error('MP search pendentes ' + r.status + ': ' + JSON.stringify(d).slice(0, 150));
  return d.results || [];
}
function botaoEmail(texto, href) {
  return '<a href="' + href + '" style="display:block;background:#E52A00;color:#ffffff;text-decoration:none;' +
    'text-align:center;font-weight:bold;font-size:16px;padding:14px;border-radius:12px;margin:14px 0 6px">' +
    texto + '</a>';
}
function corpoRecup1(m, copiaECola) {
  const primeiro = escHtml(String(m.nome || '').trim().split(/\s+/)[0] || 'tudo bem');
  const pix = copiaECola
    ? '<div style="border:1.5px dashed #CDEBE5;background:#FAFDFC;border-radius:12px;padding:13px 15px;margin:14px 0">' +
      '<div style="font-size:11.5px;color:#5C7178;letter-spacing:.8px;text-transform:uppercase;margin-bottom:6px">' +
      'Pix copia e cola · R$ ' + escHtml(String(PRECO)) + ',00</div>' +
      '<div style="font-family:monospace;font-size:11.5px;color:#14333A;word-break:break-all;line-height:1.5">' +
      escHtml(copiaECola) + '</div></div>'
    : '';
  return '<p style="margin:0 0 12px">Olá, <b>' + primeiro + '</b>! Você escolheu um horário e o Pix foi gerado, ' +
    'mas o pagamento ainda não chegou até aqui.</p>' +
    blocoLateral('Horário reservado para você',
      dataBR(m.data) + ' · ' + escHtml(m.horario),
      'Dr. João Pedro Vieira do Prado — Médico — CRM-SP 281.239') +
    '<p style="margin:0 0 12px">Esse horário fica guardado <b>por mais 5 minutos</b>. Depois disso ele volta ' +
    'para a lista e outra pessoa pode escolher.</p>' + pix +
    botaoEmail('Pagar e confirmar minha consulta', 'https://vemconsultai.com.br/agendamento') +
    '<p style="margin:12px 0 0;font-size:13px;color:#5C7178">Se você mudou de ideia, não precisa fazer nada. ' +
    'O horário volta sozinho para a lista e ninguém é cobrado.</p>' +
    '<p style="margin:10px 0 0;font-size:12px;color:#5C7178">Você recebeu este aviso porque iniciou um agendamento ' +
    'no nosso site. Não é publicidade.</p>';
}
function corpoRecup2(m) {
  const primeiro = escHtml(String(m.nome || '').trim().split(/\s+/)[0] || 'tudo bem');
  return '<p style="margin:0 0 12px">Olá, <b>' + primeiro + '</b>! Ontem você começou a agendar uma consulta e o ' +
    'pagamento não foi concluído. O horário que você tinha escolhido já voltou para a lista, mas tem outros abertos.</p>' +
    '<p style="margin:0 0 12px">A consulta é por vídeo, com médico de CRM ativo, custa <b>R$ ' + escHtml(String(PRECO)) +
    ' no Pix</b> e leva de 10 a 15 minutos. Receita, atestado e pedido de exames saem quando o médico indicar.</p>' +
    botaoEmail('Escolher um novo horário', 'https://vemconsultai.com.br/agendamento') +
    '<p style="margin:12px 0 0;font-size:13px;color:#5C7178">Se preferir falar com uma pessoa antes, é só chamar no ' +
    'WhatsApp <b>(11) 97654-4002</b>.</p>' +
    '<p style="margin:8px 0 0;font-size:13px;color:#5C7178">Não atendemos urgência nem emergência. Nesses casos, ' +
    'procure um pronto-socorro ou ligue 192 (SAMU).</p>' +
    '<p style="margin:10px 0 0;font-size:12px;color:#5C7178">Você recebeu este aviso porque iniciou um agendamento ' +
    'no nosso site. Se não quiser mais receber, responda este e-mail com "sair".</p>';
}
async function rodarRecuperacao() {
  try {
    if (!RECUPERACAO_LIGADA) return;
    if (!BREVO_API_KEY || !NOTIF_EMAIL_FROM || !MP_ACCESS_TOKEN) return;
    const pend = await mpBuscarPendentes();
    let enviados = 0;
    for (const pg of pend) {
      if (enviados >= 10) break;                       // trava de rajada
      const id = String(pg.id);
      const m = pg.metadata || {};
      if (!m.email || !m.data || !m.horario) continue;  // sem e-mail não há o que fazer
      if (agendando.has(id)) continue;                  // já está virando consulta
      const p = pendentes.get(id);
      if (p && p.booked) continue;                      // já agendou
      const idade = (Date.now() - new Date(pg.date_created).getTime()) / 60000;
      const marca = recupEnviados.get(id) || { e1: false, e2: false };
      const assinatura = 'Consultaí';
      if (!marca.e1 && idade >= RECUP_MIN_1 && idade < 30) {
        const copia = (p && p.copiaECola) || (pg.point_of_interaction
          && pg.point_of_interaction.transaction_data
          && pg.point_of_interaction.transaction_data.qr_code) || '';
        const ok = await enviarEmail(m.email,
          'Seu horário de ' + dataBR(m.data) + ' às ' + m.horario + ' ainda está reservado',
          emailShell('Seu horário ainda está reservado', corpoRecup1(m, copia)));
        marca.e1 = true; recupEnviados.set(id, marca); salvarRecup(); enviados++;
        console.log('[recuperacao] e-mail 1 ' + (ok ? 'enviado' : 'FALHOU') + ' — ' + id + ' — ' + m.email);
        await avisarWhatsRecuperacao(m, 1);   // e-mail pro médico com o botão do WhatsApp
      } else if (!marca.e2 && idade >= RECUP_MIN_2 && idade < RECUP_MIN_2 + 180) {
        const ok = await enviarEmail(m.email,
          'Você começou um agendamento na ' + assinatura,
          emailShell('Ficou faltando só o pagamento', corpoRecup2(m), '#0F766E'));
        marca.e2 = true; recupEnviados.set(id, marca); salvarRecup(); enviados++;
        console.log('[recuperacao] e-mail 2 ' + (ok ? 'enviado' : 'FALHOU') + ' — ' + id + ' — ' + m.email);
        await avisarWhatsRecuperacao(m, 2);   // e-mail pro médico com o botão do WhatsApp
      }
    }
    // limpeza: marcações com mais de 3 dias não servem para mais nada
    if (recupEnviados.size > 400) { recupEnviados.clear(); salvarRecup(); }
  } catch (e) { console.error('[recuperacao] erro: ' + e.message); }
}
async function mpBuscarAprovados() {
  const fim = new Date().toISOString();
  const ini = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const url = 'https://api.mercadopago.com/v1/payments/search?status=approved&range=date_approved' +
    '&begin_date=' + encodeURIComponent(ini) + '&end_date=' + encodeURIComponent(fim) + '&limit=50';
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + MP_ACCESS_TOKEN } });
  const d = await r.json();
  if (!r.ok) throw new Error('MP search ' + r.status + ': ' + JSON.stringify(d).slice(0, 150));
  return d.results || [];
}
function minutosAteConsulta(dataISO, horario) {
  const agoraSP = new Date(Date.now() - 3 * 3600 * 1000); // São Paulo = UTC-3
  const alvo = new Date(dataISO + 'T' + horario + ':00Z');  // interpretado no "relógio SP"
  return (alvo - agoraSP) / 60000;
}
async function enviarLembreteWhats(m, paymentId) {
  const tel = String(m.telefone || '').replace(/\D/g, '');
  const tel55 = tel.startsWith('55') ? tel : '55' + tel;
  const primeiro = String(m.nome || '').trim().split(/\s+/)[0] || 'paciente';
  const sala = process.env.SALA_LINK || '';
  const msg = 'Olá, ' + primeiro + '! 👋 Aqui é o Dr. João Pedro, da Consultaí. Sua consulta por vídeo começa às '
    + m.horario + '. ' + (sala ? ('Entre na sala por este link: ' + sala) : 'Segue o link da nossa sala de vídeo: ');
  const wa = 'https://wa.me/' + tel55 + '?text=' + encodeURIComponent(msg);
  const corpo = `
    <p style="margin:0 0 8px"><b>${m.nome || '—'}</b> · hoje às <b>${m.horario}</b> · ${m.telefone || '—'}</p>
    <p style="margin:0 0 18px;color:#5C7178;font-size:13.5px">Toque no botão: o WhatsApp abre com a mensagem pronta pro paciente${sala ? ' (link da sala já incluído)' : ' — só colar o link da sala do Shosp'}.</p>
    <a href="${wa}" style="display:inline-block;background:#25D366;color:#fff;text-decoration:none;font-weight:bold;padding:14px 26px;border-radius:10px;font-size:16px">Enviar WhatsApp pro paciente</a>`;
  await enviarEmail(NOTIF_EMAIL_TO || NOTIF_EMAIL_FROM, 'Consulta em ~10 min: ' + m.horario + ' — ' + (m.nome || ''), emailShell('Consulta começando em ~10 minutos', corpo, '#FF6B4A'));
  console.log('[lembrete] enviado — consulta ' + m.data + ' ' + m.horario + ' (pagamento ' + paymentId + ')');
}
async function rodarLembretes() {
  try {
    if (!BREVO_API_KEY || !NOTIF_EMAIL_FROM || !MP_ACCESS_TOKEN) return;
    const pagos = await mpBuscarAprovados();
    for (const pg of pagos) {
      const m = pg.metadata || {};
      if (!m.data || !m.horario || !m.telefone) continue;
      const id = String(pg.id);
      if (lembretesEnviados.has(id)) continue;
      const min = minutosAteConsulta(m.data, m.horario);
      if (min > 2 && min <= 12) {
        lembretesEnviados.add(id);
        await enviarLembreteWhats(m, id);
      }
    }
  } catch (e) { console.error('[lembrete] erro: ' + e.message); }
}
setInterval(rodarLembretes, 3 * 60 * 1000);
/* Recuperação de Pix: varre a cada minuto. Nasce desligada; ligue com
   RECUPERACAO=on nas variáveis de ambiente do Render. */
setInterval(rodarRecuperacao, 60 * 1000);
console.log('[recuperacao] ' + (RECUPERACAO_LIGADA ? 'LIGADA' : 'desligada (defina RECUPERACAO=on para ativar)'));
/* OBS: aqui existia um "despertador" que dava um auto-ping a cada 10 min.
   Ele servia para o plano gratuito do Render, que colocava o serviço para
   dormir após ~15 min sem visitas. No plano Starter (pago) o serviço não
   dorme, então o ping virou código morto e foi removido. Se um dia o plano
   voltar a ser o gratuito, é só reativar essa rotina. */
// Página 404 personalizada (qualquer rota que não exista)
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ ok: false, erro: 'rota não encontrada' });
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});
app.listen(PORT, () => console.log('Consultaí backend rodando na porta ' + PORT));
