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

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// URLs limpas: redireciona /pagina.html -> /pagina (301, bom para SEO)
app.get(/\.html$/, (req, res) => {
  const limpo = req.path === '/index.html' ? '/' : req.path.slice(0, -5);
  const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  res.redirect(301, limpo + qs);
});
// Serve os arquivos; "extensions:['html']" faz /trabalhe-conosco achar trabalhe-conosco.html
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// CORS (caso o site fique em outro domínio que o backend)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

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
  PRECO = '40',
  PORT = 3000,
  BREVO_API_KEY = '',      // chave da API do Brevo (envio de e-mail por HTTPS)
  NOTIF_EMAIL_FROM = '',   // remetente validado no Brevo
  NOTIF_EMAIL_TO = '',     // quem recebe o aviso interno (ex.: octahealth@hotmail.com)
} = process.env;

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

function cardConsulta(p, protocolo) {
  return `
    <div style="background:#F1FBF9;border:1.5px solid #15A39A;border-radius:14px;padding:18px 22px;margin:16px 0;text-align:center">
      <div style="font-size:13px;color:#5C7178;letter-spacing:1px;text-transform:uppercase">Sua consulta</div>
      <div style="font-size:28px;font-weight:bold;color:#0C4A52;margin:6px 0">${dataBR(p.slot.data)} · ${p.slot.horario}</div>
      <div style="font-size:14px;color:#14333A">👨‍⚕️ Dr. João Pedro Vieira do Prado — CRM-SP 281.239</div>
      <div style="font-size:12px;color:#5C7178;margin-top:6px">Protocolo ${protocolo}</div>
    </div>`;
}

async function avisarNovaConsulta(p, protocolo, paymentId) {
  const dt = dataBR(p.slot.data);
  const corpo = `
    <p style="margin:0"><b>${escHtml(p.paciente.nome || '—')}</b> pagou e agendou:</p>
    ${cardConsulta(p, protocolo)}
    <table style="border-collapse:collapse;width:100%;font-size:15px">
      <tr><td style="padding:5px 0;color:#5C7178">📱 WhatsApp</td><td>${escHtml(p.paciente.telefone || '—')}</td></tr>
      <tr><td style="padding:5px 0;color:#5C7178">✉️ E-mail</td><td>${escHtml(p.paciente.email || '—')}</td></tr>
      <tr><td style="padding:5px 0;color:#5C7178">🎂 Nascimento</td><td>${escHtml(p.paciente.dataNascimento || '—')}</td></tr>
      <tr><td style="padding:5px 0;color:#5C7178">💳 Pagamento MP</td><td>${escHtml(String(paymentId))}</td></tr>
    </table>
    <p style="margin:16px 0 0;color:#5C7178;font-size:13px">Já está na agenda do Shosp. Abra a consulta e <b>confirme o paciente</b> para gerar o link da telemedicina.</p>`;
  try {
    if (await enviarEmail(NOTIF_EMAIL_TO || NOTIF_EMAIL_FROM, '🩺 Nova consulta: ' + dt + ' às ' + p.slot.horario + ' — ' + (p.paciente.nome || 'paciente'), emailShell('🩺 Nova consulta confirmada!', corpo))) {
      console.log('[email] aviso interno enviado (' + dt + ' ' + p.slot.horario + ')');
    }
  } catch (e) { console.error('[email] falha no aviso interno: ' + e.message); }
}

async function confirmarPaciente(p, protocolo) {
  if (!p.paciente.email) return;
  const dt = dataBR(p.slot.data);
  const corpo = `
    <p style="margin:0">Olá, <b>${escHtml((p.paciente.nome || '').split(' ')[0])}</b>! 👋 Seu pagamento foi aprovado e sua consulta está marcada.</p>
    ${cardConsulta(p, protocolo)}
    <p style="margin:0 0 10px">📱 O <b>link da videochamada</b> chega no seu WhatsApp pouco antes do horário. Fique de olho!</p>
    <p style="margin:0 0 10px;color:#5C7178;font-size:14px">Dicas para a consulta: esteja num lugar tranquilo, com boa internet, e tenha em mãos seus exames ou receitas anteriores, se tiver.</p>
    <p style="margin:0;color:#5C7178;font-size:13px">Precisa reagendar? É só chamar no WhatsApp <a href="https://wa.me/5511976544002" style="color:#15A39A;text-decoration:none"><b>(11) 97654-4002</b></a>.</p>`;
  try {
    if (await enviarEmail(p.paciente.email, '✅ Consulta confirmada — ' + dt + ' às ' + p.slot.horario + ' | Consultaí', emailShell('Consulta confirmada! 🎉', corpo))) {
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
const travas = new Map(); // chave `data|codigoHorario` -> expira em (ms)
const TRAVA_MS = 12 * 60 * 1000;
const chaveTrava = (data, cod) => String(data) + '|' + String(cod);
function travar(data, cod) { travas.set(chaveTrava(data, cod), Date.now() + TRAVA_MS); }
function destravar(data, cod) { travas.delete(chaveTrava(data, cod)); }
function estaTravado(data, cod) {
  const exp = travas.get(chaveTrava(data, cod));
  if (!exp) return false;
  if (Date.now() > exp) { travas.delete(chaveTrava(data, cod)); return false; } // expirou
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

  destravar(p.slot.data, p.slot.codigoHorario); // reserva virou firme
  p.booked = true;
  p.protocolo = (r && r.dados && (r.dados.codigoAgendamento || r.dados.protocolo)) ||
                (r && (r.protocolo || r.codigo || r.id)) || ('CS-' + paymentId);
  pendentes.set(String(paymentId), p);
  console.log('[agenda] ✔ consulta agendada — ' + p.slot.data + ' ' + p.slot.horario + ' — ' + (p.paciente.nome || '') + ' — protocolo ' + p.protocolo);
  avisarNovaConsulta(p, p.protocolo, paymentId); // aviso interno em segundo plano
  confirmarPaciente(p, p.protocolo);             // confirmação ao paciente em segundo plano
  return { agendado: true, protocolo: p.protocolo };
}

/* Alerta urgente ao médico quando um pagamento aprovado NÃO virou agenda */
async function alertarFalhaAgendamento(p, paymentId, motivo) {
  try {
    const corpo = `
      <p style="margin:0 0 12px;color:#9a2a12;font-weight:bold">⚠️ Um paciente PAGOU mas a consulta não entrou na agenda. Resolva manualmente e entre em contato com ele.</p>
      <table style="border-collapse:collapse;width:100%;font-size:15px">
        <tr><td style="padding:5px 0;color:#5C7178">Paciente</td><td><b>${escHtml(p.paciente.nome || '—')}</b></td></tr>
        <tr><td style="padding:5px 0;color:#5C7178">Horário desejado</td><td>${dataBR(p.slot.data)} · ${p.slot.horario}</td></tr>
        <tr><td style="padding:5px 0;color:#5C7178">WhatsApp</td><td>${escHtml(p.paciente.telefone || '—')}</td></tr>
        <tr><td style="padding:5px 0;color:#5C7178">E-mail</td><td>${escHtml(p.paciente.email || '—')}</td></tr>
        <tr><td style="padding:5px 0;color:#5C7178">Pagamento MP</td><td>${paymentId}</td></tr>
        <tr><td style="padding:5px 0;color:#5C7178">Motivo</td><td>${String(motivo).slice(0, 160)}</td></tr>
      </table>`;
    await enviarEmail(NOTIF_EMAIL_TO || NOTIF_EMAIL_FROM, '🚨 URGENTE: pagamento sem agenda — ' + (p.paciente.nome || 'paciente'), emailShell('🚨 Pagamento sem agenda', corpo, '#c0392b'));
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
      .filter(s => !estaTravado(s.data, s.codigoHorario)); // esconde horários reservados em checkout
    res.json({ ok: true, slots });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

app.post('/api/checkout', async (req, res) => {
  try {
    const { nome, cpf, telefone, email, dataNascimento, sexo, data, horario, codigoHorario } = req.body;
    if (!nome || !email || !data || !horario || codigoHorario == null) {
      return res.status(400).json({ ok: false, erro: 'dados incompletos' });
    }
    const idem = 'consultai-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
    const pay = await mpCriarPix({
      valor: PRECO, email, nome, idem,
      metadata: { nome, cpf, telefone, email, datanascimento: dataNascimento, sexo, data, horario, codigohorario: codigoHorario },
    });
    pendentes.set(String(pay.id), {
      paciente: { nome, cpf, telefone, email, dataNascimento, sexo },
      slot: { data, horario, codigoHorario },
      booked: false,
    });
    travar(data, codigoHorario); // reserva o horário por 12 min — some da lista dos outros
    console.log('[checkout] Pix criado — pagamento ' + pay.id + ' — ' + data + ' ' + horario + ' — ' + nome + ' (horário travado)');
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
    const id = (req.body && req.body.data && req.body.data.id) || req.query['data.id'];
    console.log('[webhook] notificação recebida do MP — id: ' + (id || '(sem id)'));
    if (id) {
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
app.post('/api/contato', async (req, res) => {
  try {
    const { nome, email, assunto, mensagem, site } = req.body || {};
    if (site) return res.json({ ok: true }); // honeypot: robôs de spam preenchem este campo invisível
    if (!nome || !email || !assunto || !mensagem) {
      return res.status(400).json({ ok: false, erro: 'preencha todos os campos' });
    }
    const corpo = `
      <p style="margin:0 0 10px">Nova mensagem enviada pelo site (página Trabalhe conosco):</p>
      <table style="border-collapse:collapse;width:100%;font-size:15px">
        <tr><td style="padding:5px 0;color:#5C7178">👤 Nome</td><td>${escHtml(String(nome).slice(0, 120))}</td></tr>
        <tr><td style="padding:5px 0;color:#5C7178">✉️ E-mail</td><td>${escHtml(String(email).slice(0, 120))}</td></tr>
        <tr><td style="padding:5px 0;color:#5C7178">📌 Assunto</td><td>${escHtml(String(assunto).slice(0, 150))}</td></tr>
      </table>
      <div style="background:#F1FBF9;border-radius:10px;padding:14px 16px;margin-top:12px;white-space:pre-wrap">${escHtml(String(mensagem).slice(0, 4000))}</div>
      <p style="margin:14px 0 0;color:#5C7178;font-size:13px">Para responder, é só responder este e-mail — vai direto pro remetente.</p>`;
    await enviarEmail(
      NOTIF_EMAIL_TO || NOTIF_EMAIL_FROM,
      '💼 Trabalhe conosco: ' + String(assunto).slice(0, 80) + ' — ' + String(nome).slice(0, 60),
      emailShell('💼 Nova mensagem — Trabalhe conosco', corpo),
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

/* ------------- Lembrete de consulta (~10 min antes) via e-mail -------------
   A cada 3 min, busca no Mercado Pago os pagamentos aprovados e, quando uma
   consulta está a ~10 min de começar, envia um e-mail ao médico com um botão
   que abre o WhatsApp do paciente com a mensagem pronta (1 toque = enviado). */
const lembretesEnviados = new Set();

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
    <p style="margin:0 0 8px"><b>${m.nome || '—'}</b> · hoje às <b>${m.horario}</b> · 📱 ${m.telefone || '—'}</p>
    <p style="margin:0 0 18px;color:#5C7178;font-size:13.5px">Toque no botão: o WhatsApp abre com a mensagem pronta pro paciente${sala ? ' (link da sala já incluído)' : ' — só colar o link da sala do Shosp'}.</p>
    <a href="${wa}" style="display:inline-block;background:#25D366;color:#fff;text-decoration:none;font-weight:bold;padding:14px 26px;border-radius:10px;font-size:16px">📲 Enviar WhatsApp pro paciente</a>`;
  await enviarEmail(NOTIF_EMAIL_TO || NOTIF_EMAIL_FROM, '⏰ Consulta em ~10 min: ' + m.horario + ' — ' + (m.nome || ''), emailShell('⏰ Consulta começando em ~10 minutos!', corpo, '#FF6B4A'));
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

/* Despertador anti-cochilo: no plano gratuito o Render "dorme" após ~15 min
   sem visitas (e o 1º acesso demora 50s+). Este auto-ping a cada 10 min
   mantém o serviço acordado. */
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    fetch(process.env.RENDER_EXTERNAL_URL + '/api/health').catch(() => {});
  }, 10 * 60 * 1000);
  console.log('[despertador] auto-ping ativado a cada 10 min → ' + process.env.RENDER_EXTERNAL_URL);
}

// Página 404 personalizada (qualquer rota que não exista)
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ ok: false, erro: 'rota não encontrada' });
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

app.listen(PORT, () => console.log('Consultaí backend rodando na porta ' + PORT));
