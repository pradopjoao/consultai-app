# Consultaí — Backend + Chatbot de Agendamento

Liga o chatbot ao **Shosp** (agenda) e ao **Mercado Pago** (Pix). Você não precisa
programar — só criar contas, preencher as chaves e publicar. Onde tiver dúvida, me chame.

## O que tem aqui
- `server.js` — o mini-backend (o "porteiro").
- `public/agendamento.html` — o chatbot (já servido pelo backend, mesmo domínio).
- `.env.example` — modelo das chaves (copie para `.env`).
- `package.json` — dependências.

## Como funciona (resumo)
1. O chatbot pergunta ao backend os **horários livres** → backend consulta o Shosp.
2. Paciente escolhe horário e preenche os dados.
3. Backend cria a **cobrança Pix** no Mercado Pago e mostra o QR/copia-e-cola.
4. Quando o Pix é aprovado, o backend **cria a consulta no Shosp** automaticamente.

## Passo a passo para publicar

### 1. Tenha as chaves em mãos
- Shosp: `API_KEY` e `ID` (Configurações → Minha Conta → Integrações).
- Mercado Pago: `Access Token` de produção (mercadopago.com.br/developers → Suas integrações).

### 2. Entenda as "chaves" (variáveis de ambiente) — você é leigo? Sem problema
Essas chaves secretas (Shosp e Mercado Pago) **não ficam num site separado nem dentro do código**.
Elas são as chamadas *variáveis de ambiente*: uma listinha de `NOME = valor` que você cadastra
**no próprio painel da hospedagem** — no passo 3, na aba **Environment** do Render. Você só digita
nos campos do site; **não precisa criar nem editar nenhum arquivo à mão.**

O arquivo `.env.example` aqui da pasta é apenas um **modelo de referência**: ele mostra QUAIS chaves
existem e os nomes exatos delas (ex.: `SHOSP_API_KEY`, `MP_ACCESS_TOKEN`). Use-o só para saber o que
preencher lá no site.

> (Criar um arquivo `.env` de verdade só é necessário se um dia você for rodar isto no seu próprio
> computador. Para publicar no Render, esqueça o arquivo — tudo é feito na tela do Render.)

### 3. Publique (sugestão: Render — tem plano gratuito)
1. Crie um repositório no GitHub com esta pasta (sem o `.env`).
2. Em render.com → New → Web Service → conecte o repositório.
3. Build Command: `npm install` · Start Command: `npm start`.
4. Em **Environment**, adicione cada variável do `.env` (uma a uma).
5. Deploy. Você recebe uma URL, ex.: `https://consultai.onrender.com`.

> Alternativas: Railway, Fly.io, ou uma VPS. Qualquer uma que rode Node 18+ serve.

### 4. Aponte seu domínio
No painel da hospedagem, adicione o domínio `consultai.app.br` (custom domain) e
ajuste o DNS no registro.br conforme as instruções que a hospedagem mostrar.

### 5. Configure o webhook do Mercado Pago
No painel do Mercado Pago (sua aplicação → Webhooks/Notificações), aponte para:
`https://SEU-DOMINIO/api/webhook` e marque o evento de **pagamentos**.

### 6. Teste de ponta a ponta
1. Abra `https://SEU-DOMINIO/agendamento.html`.
2. Agende um horário, pague um Pix de teste e confirme que a consulta **aparece na agenda do Shosp**.
3. O link do chatbot é o que vai na **bio do Instagram**.

## Pré-visualizar sem backend
No `public/agendamento.html`, troque `const DEMO = false;` para `true` e abra o arquivo
no navegador — ele roda com dados de exemplo (sem Shosp/Pix).

## Ponto que pode precisar de 1 ajuste
A leitura dos horários do Shosp (`/agenda/get/`) foi feita de forma defensiva, porque
a forma exata do JSON só dá para confirmar com uma chamada real. Se na hora do teste os
horários não aparecerem, me mande um exemplo da resposta do Shosp que eu ajusto em 1 linha.
