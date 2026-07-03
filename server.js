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
} = process.env;

// Reserva temporária dos dados do paciente até o Pix ser confirmado.
// (em memória — para MVP. Em produção, troque por um banco de dados.)
const pendentes = new Map();

/* ----------------------------- Shosp ----------------------------------- */
async function shosp(pathname, formObj) {
  const r = await fetch(SHOSP_BASE + pathname, {
    method: 'POST',
    headers: {
      'x-api-key': SHOSP_API_KEY,
      'id': SHOSP_ID,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(formObj).toString(),
  });
  const txt = await r.text();
  let data; try { data = JSON.parse(txt); } catch { data = txt; }
  if (!r.ok) throw new Error('Shosp ' + r.status + ': ' + txt);
  return data;
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
async function mpCriarPix({ valor, email, nome, idem }) {
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
    }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error('MercadoPago ' + r.status + ': ' + JSON.stringify(d));
  const tx = (d.point_of_interaction && d.point_of_interaction.transaction_data) || {};
  return { id: d.id, copiaECola: tx.qr_code, qrBase64: tx.qr_code_base64, ticketUrl: tx.ticket_url };
}

async function mpStatus(id) {
  const r = await fetch('https://api.mercadopago.com/v1/payments/' + id, {
    headers: { 'Authorization': 'Bearer ' + MP_ACCESS_TOKEN },
  });
  const d = await r.json();
  if (!r.ok) throw new Error('MercadoPago status ' + r.status + ': ' + JSON.stringify(d));
  return d.status; // pending | approved | rejected | cancelled ...
}

/* Cria o agendamento no Shosp (idempotente: só agenda uma vez por pagamento) */
async function efetivarAgendamento(paymentId) {
  const p = pendentes.get(String(paymentId));
  if (!p) return { agendado: false, motivo: 'pagamento sem reserva associada' };
  if (p.booked) return { agendado: true, protocolo: p.protocolo, jaAgendado: true };

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
  if (COD_ESPECIALIDADE) form.codigoEspecialidade = COD_ESPECIALIDADE;

  const r = await shosp('/agenda/', form);
  p.booked = true;
  p.protocolo = (r && (r.protocolo || r.codigo || r.id)) || ('CS-' + paymentId);
  pendentes.set(String(paymentId), p);
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
    const { nome, telefone, email, dataNascimento, sexo, data, horario, codigoHorario } = req.body;
    if (!nome || !email || !data || !horario || codigoHorario == null) {
      return res.status(400).json({ ok: false, erro: 'dados incompletos' });
    }
    const idem = 'consultai-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
    const pay = await mpCriarPix({ valor: PRECO, email, nome, idem });
    pendentes.set(String(pay.id), {
      paciente: { nome, telefone, email, dataNascimento, sexo },
      slot: { data, horario, codigoHorario },
      booked: false,
    });
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
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// Webhook do Mercado Pago (configure a URL no painel do MP)
app.post('/api/webhook', async (req, res) => {
  try {
    const id = (req.body && req.body.data && req.body.data.id) || req.query['data.id'];
    if (id) {
      const status = await mpStatus(String(id));
      if (status === 'approved') await efetivarAgendamento(String(id));
    }
  } catch (e) {
    console.error('webhook erro:', e.message);
  }
  res.sendStatus(200); // sempre 200 para o MP não reenviar infinitamente
});

app.get('/api/health', (req, res) => res.json({ ok: true, servico: 'consultai-backend' }));

// Página 404 personalizada (qualquer rota que não exista)
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ ok: false, erro: 'rota não encontrada' });
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

app.listen(PORT, () => console.log('Consultaí backend rodando na porta ' + PORT));
