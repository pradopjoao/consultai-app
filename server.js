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
app.use(express.static(path.join(__dirname, 'public'))); // serve o chatbot

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
  NOTIF_EMAIL_USER = '',   // Gmail que ENVIA o aviso (ex.: seuemail@gmail.com)
  NOTIF_EMAIL_PASS = '',   // senha de app do Gmail (16 letras, sem espaços)
  NOTIF_EMAIL_TO = '',     // quem RECEBE o aviso (se vazio, usa o próprio NOTIF_EMAIL_USER)
} = process.env;

/* ------------------- Aviso por e-mail (nova consulta) ------------------- */
const nodemailer = require('nodemailer');
const mailer = (NOTIF_EMAIL_USER && NOTIF_EMAIL_PASS)
  ? nodemailer.createTransport({ service: 'gmail', auth: { user: NOTIF_EMAIL_USER, pass: NOTIF_EMAIL_PASS } })
  : null;

async function avisarNovaConsulta(p, protocolo, paymentId) {
  if (!mailer) { console.log('[email] aviso não configurado (defina NOTIF_EMAIL_USER e NOTIF_EMAIL_PASS)'); return; }
  const [y, m, d] = String(p.slot.data).split('-');
  const dataBR = d + '/' + m + '/' + y;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;border:1px solid #E3EFEC;border-radius:12px;overflow:hidden">
      <div style="background:linear-gradient(135deg,#15A39A,#0C4A52);color:#fff;padding:18px 22px">
        <h2 style="margin:0;font-size:20px">🩺 Nova consulta confirmada!</h2>
      </div>
      <div style="padding:22px;color:#14333A;font-size:15px;line-height:1.7">
        <p style="margin:0 0 14px"><b>${p.paciente.nome || '—'}</b> pagou e agendou:</p>
        <table style="border-collapse:collapse;width:100%;font-size:15px">
          <tr><td style="padding:6px 0;color:#5C7178">📅 Data</td><td><b>${dataBR}</b></td></tr>
          <tr><td style="padding:6px 0;color:#5C7178">🕐 Horário</td><td><b>${p.slot.horario}</b></td></tr>
          <tr><td style="padding:6px 0;color:#5C7178">📱 WhatsApp</td><td>${p.paciente.telefone || '—'}</td></tr>
          <tr><td style="padding:6px 0;color:#5C7178">✉️ E-mail</td><td>${p.paciente.email || '—'}</td></tr>
          <tr><td style="padding:6px 0;color:#5C7178">🎂 Nascimento</td><td>${p.paciente.dataNascimento || '—'}</td></tr>
          <tr><td style="padding:6px 0;color:#5C7178">📋 Protocolo</td><td>${protocolo}</td></tr>
          <tr><td style="padding:6px 0;color:#5C7178">💳 Pagamento MP</td><td>${paymentId}</td></tr>
        </table>
        <p style="margin:16px 0 0;color:#5C7178;font-size:13px">A consulta já está na agenda do Shosp. Lembre de enviar o link da videochamada no WhatsApp do paciente.</p>
      </div>
    </div>`;
  try {
    await mailer.sendMail({
      from: '"Consultaí" <' + NOTIF_EMAIL_USER + '>',
      to: NOTIF_EMAIL_TO || NOTIF_EMAIL_USER,
      subject: '🩺 Nova consulta: ' + dataBR + ' às ' + p.slot.horario + ' — ' + (p.paciente.nome || 'paciente'),
      html,
    });
    console.log('[email] aviso de nova consulta enviado (' + dataBR + ' ' + p.slot.horario + ')');
  } catch (e) {
    console.error('[email] falha ao enviar aviso: ' + e.message);
  }
}

// Reserva temporária dos dados do paciente até o Pix ser confirmado.
// (em memória — para MVP. Em produção, troque por um banco de dados.)
const pendentes = new Map();

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
   Na busca (/cadastro/paciente) o Shosp chama o código de "prontuario". */
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
  let esc = null;
  if (alvo && alvo.cpf) {
    const c = String(alvo.cpf).replace(/\D/g, '');
    esc = lista.find(x => String(x.cpf || '').replace(/\D/g, '') === c);
  }
  if (!esc && alvo && alvo.nome) {
    const nm = String(alvo.nome).trim().toLowerCase();
    esc = lista.find(x => String(x.nome || '').trim().toLowerCase() === nm);
  }
  if (!esc) esc = lista[0];
  return esc.prontuario != null ? esc.prontuario : esc.codigoPaciente;
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
    email: p.paciente.email,
    dataNascimento: p.paciente.dataNascimento,
    sexo: p.paciente.sexo,
  };
  if (p.paciente.cpf) form.cpf = String(p.paciente.cpf).replace(/\D/g, '');
  if (COD_ESPECIALIDADE) form.codigoEspecialidade = COD_ESPECIALIDADE;

  console.log('[agenda] enviando ao Shosp (' + tag + '): ' + JSON.stringify(form));
  let r = await shosp('/agenda/', form);
  console.log('[agenda] resposta do Shosp (' + tag + '): ' + JSON.stringify(r).slice(0, 400));

  // O Shosp sinaliza sucesso com ret:"1". ret:"0" é RECUSA (ex.: paciente já cadastrado).
  if (!r || r.ret !== '1') {
    const msg = (r && (r.msg || r.mensagem)) || JSON.stringify(r);
    if (/j[áa] foi cadastrado/i.test(msg)) {
      console.log('[agenda] paciente já existe no Shosp — buscando codigoPaciente…');
      const query = { nome: p.paciente.nome };
      if (p.paciente.cpf) query.cpf = String(p.paciente.cpf).replace(/\D/g, '');
      const busca = await shospGet('/cadastro/paciente', query);
      const cod = acharCodigoPaciente(busca, p.paciente);
      if (!cod) throw new Error('Shosp: paciente já cadastrado, mas a busca não retornou o codigoPaciente');
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

  const r = await agendarNoShosp(p, 'pagamento ' + paymentId);

  p.booked = true;
  p.protocolo = (r && r.dados && (r.dados.codigoAgendamento || r.dados.protocolo)) ||
                (r && (r.protocolo || r.codigo || r.id)) || ('CS-' + paymentId);
  pendentes.set(String(paymentId), p);
  console.log('[agenda] ✔ consulta agendada — ' + p.slot.data + ' ' + p.slot.horario + ' — ' + (p.paciente.nome || '') + ' — protocolo ' + p.protocolo);
  avisarNovaConsulta(p, p.protocolo, paymentId); // e-mail em segundo plano (não trava a resposta)
  return { agendado: true, protocolo: p.protocolo };
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
    res.json({ ok: true, slots: normalizarHorarios(data) });
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
    console.log('[checkout] Pix criado — pagamento ' + pay.id + ' — ' + data + ' ' + horario + ' — ' + nome);
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
      const r = await efetivarAgendamento(id);
      return res.json({ ok: true, status, ...r });
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

app.get('/api/health', (req, res) => res.json({ ok: true, servico: 'consultai-backend' }));

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
