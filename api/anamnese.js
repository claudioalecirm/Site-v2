/**
 * Homem de Governo | Anamnese e alinhamento
 * Função do Vercel: recebe o formulário, salva no Supabase e envia o e-mail.
 *
 * Onde colocar: /api/anamnese.js na raiz do repositório do site.
 * Sem dependências (usa o fetch nativo do Node 18+).
 *
 * Variáveis de ambiente (Vercel > Project > Settings > Environment Variables):
 *   SUPABASE_URL                https://SEU-PROJETO.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY   chave secreta do projeto (service_role ou sb_secret_...)
 *   RESEND_API_KEY              chave da API do Resend
 *   EMAIL_DESTINO   (opcional)  padrão: suadevolutiva@gmail.com
 *   EMAIL_REMETENTE (opcional)  padrão: Homem de Governo <onboarding@resend.dev>
 *
 * As duas entregas são independentes: se o Supabase falhar, o e-mail ainda sai
 * (com aviso no topo); se o e-mail falhar, a resposta ainda fica salva.
 * O formulário só mostra erro para o mentorado quando as duas falham.
 *
 * GET /api/anamnese faz uma consulta leve no Supabase. Serve para o cron diário
 * do Vercel manter o projeto do Supabase ativo (o plano gratuito pausa por inatividade).
 * Trecho para o vercel.json:
 *   { "crons": [ { "path": "/api/anamnese", "schedule": "0 12 * * *" } ] }
 */

const TABELA = 'homem_de_governo_anamnese';
const DESTINO_PADRAO = 'suadevolutiva@gmail.com';
const REMETENTE_PADRAO = 'Homem de Governo <onboarding@resend.dev>';
const PRAZO_MS = 4500;
const TAMANHO_MAXIMO = 80000; // caracteres do corpo em JSON

/* ---------- utilitários ---------- */

function comPrazo(url, opcoes, ms) {
  const controle = new AbortController();
  const relogio = setTimeout(() => controle.abort(), ms);
  return fetch(url, { ...opcoes, signal: controle.signal }).finally(() => clearTimeout(relogio));
}

function txt(v, max) {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}

function num(v, min, max) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

function nota(v) {
  const n = num(v, 0, 10);
  return n === null ? null : Math.round(n);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// aceita só a estrutura esperada: [{ bloco, itens: [{ pergunta, resposta }] }]
function limparLeitura(leitura) {
  if (!Array.isArray(leitura)) return [];
  return leitura.slice(0, 20).map((b) => ({
    bloco: txt(b && b.bloco, 80) || 'Bloco',
    itens: (Array.isArray(b && b.itens) ? b.itens : []).slice(0, 40).map((i) => ({
      pergunta: txt(i && i.pergunta, 300) || '',
      resposta: txt(i && i.resposta, 3200) || ''
    })).filter((i) => i.pergunta && i.resposta)
  })).filter((b) => b.itens.length);
}

function configSupabase() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const chave = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '';
  return url && chave ? { url, chave } : null;
}

/* ---------- Supabase ---------- */

async function salvar(linha) {
  const sb = configSupabase();
  if (!sb) return { ok: false, motivo: 'Supabase não configurado no Vercel' };
  try {
    const r = await comPrazo(`${sb.url}/rest/v1/${TABELA}`, {
      method: 'POST',
      headers: {
        apikey: sb.chave,
        Authorization: `Bearer ${sb.chave}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(linha)
    }, PRAZO_MS);
    if (r.ok) return { ok: true };
    // registra só código e mensagem, nunca o conteúdo das respostas
    const erro = await r.json().catch(() => ({}));
    return { ok: false, motivo: `Supabase respondeu ${r.status}${erro && erro.message ? ': ' + String(erro.message).slice(0, 140) : ''}` };
  } catch (e) {
    return { ok: false, motivo: e && e.name === 'AbortError' ? 'Supabase não respondeu a tempo, o projeto pode estar pausado' : 'Falha de rede ao falar com o Supabase' };
  }
}

/* ---------- e-mail ---------- */

function montarEmail({ nome, linha, leitura, salvo, duracao }) {
  const contato = [linha.whatsapp, linha.email, linha.cidade].filter(Boolean).map(esc).join(' &nbsp;|&nbsp; ');
  const aviso = salvo.ok
    ? ''
    : `<p style="margin:0 0 20px;padding:12px 14px;background:#FDECEA;border:1px solid #E5A79C;color:#7A1E12;font-size:14px">
         <strong>Atenção:</strong> esta resposta não foi salva no Supabase. Motivo: ${esc(salvo.motivo)}. Guarde este e-mail.
       </p>`;

  const blocos = leitura.map((b) => `
    <h2 style="margin:28px 0 6px;padding-bottom:6px;border-bottom:2px solid #C9A24B;font:600 19px Georgia,serif;color:#1A1A1A">${esc(b.bloco)}</h2>
    ${b.itens.map((i) => `
      <p style="margin:14px 0 2px;font-size:13px;color:#6B6455">${esc(i.pergunta)}</p>
      <p style="margin:0;font-size:16px;line-height:1.5;color:#111;white-space:pre-wrap">${esc(i.resposta)}</p>`).join('')}`).join('');

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#EDEDED;font-family:Arial,Helvetica,sans-serif">
    <div style="max-width:640px;margin:0 auto;padding:28px;background:#FFFFFF;border-top:4px solid #C9A24B">
      <p style="margin:0;font-size:13px;color:#6B6455">Homem de Governo | Anamnese e alinhamento</p>
      <h1 style="margin:4px 0 6px;font:700 26px Georgia,serif;color:#111">${esc(nome)}</h1>
      <p style="margin:0 0 20px;font-size:14px;color:#444">${contato}${duracao ? `<br>Tempo de preenchimento: ${duracao} min` : ''}</p>
      ${aviso}${blocos}
    </div></body></html>`;

  const texto = [`Homem de Governo | Anamnese de ${nome}`, salvo.ok ? '' : `ATENÇÃO: não salvou no Supabase. Motivo: ${salvo.motivo}.`]
    .concat(leitura.map((b) => `\n== ${b.bloco} ==\n` + b.itens.map((i) => `${i.pergunta}\n> ${i.resposta}`).join('\n\n')))
    .filter(Boolean).join('\n');

  return { html, texto };
}

async function enviarEmail(dados) {
  const chave = process.env.RESEND_API_KEY;
  if (!chave) return { ok: false, motivo: 'Resend não configurado no Vercel' };
  const { html, texto } = montarEmail(dados);
  const corpo = {
    from: process.env.EMAIL_REMETENTE || REMETENTE_PADRAO,
    to: [process.env.EMAIL_DESTINO || DESTINO_PADRAO],
    subject: `Anamnese Homem de Governo: ${dados.nome}${dados.salvo.ok ? '' : ' [não salvou no Supabase]'}`,
    html,
    text: texto
  };
  if (dados.linha.email) corpo.reply_to = dados.linha.email;
  try {
    const r = await comPrazo('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${chave}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo)
    }, PRAZO_MS);
    if (r.ok) return { ok: true };
    const erro = await r.json().catch(() => ({}));
    return { ok: false, motivo: `Resend respondeu ${r.status}${erro && erro.message ? ': ' + String(erro.message).slice(0, 140) : ''}` };
  } catch (e) {
    return { ok: false, motivo: e && e.name === 'AbortError' ? 'Resend não respondeu a tempo' : 'Falha de rede ao falar com o Resend' };
  }
}

/* ---------- ping (cron) ---------- */

async function ping(res) {
  const sb = configSupabase();
  if (!sb) return res.status(503).json({ ok: false, erro: 'supabase_nao_configurado' });
  try {
    const r = await comPrazo(`${sb.url}/rest/v1/${TABELA}?select=id&limit=1`, {
      headers: { apikey: sb.chave, Authorization: `Bearer ${sb.chave}` }
    }, PRAZO_MS);
    return res.status(r.ok ? 200 : 503).json({ ok: r.ok });
  } catch (e) {
    return res.status(503).json({ ok: false });
  }
}

/* ---------- handler ---------- */

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') return ping(res);
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, erro: 'metodo_nao_permitido' });
  }

  // só aceita envio vindo do próprio site
  const origem = req.headers.origin;
  if (origem) {
    let hostOrigem = '';
    try { hostOrigem = new URL(origem).host; } catch (e) { /* origem inválida */ }
    const hosts = [req.headers.host, req.headers['x-forwarded-host']].filter(Boolean);
    if (!hosts.includes(hostOrigem)) return res.status(403).json({ ok: false, erro: 'origem_nao_permitida' });
  }

  let corpo = req.body;
  if (typeof corpo === 'string') { try { corpo = JSON.parse(corpo); } catch (e) { corpo = null; } }
  if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo)) return res.status(400).json({ ok: false, erro: 'corpo_invalido' });
  if (JSON.stringify(corpo).length > TAMANHO_MAXIMO) return res.status(413).json({ ok: false, erro: 'corpo_grande_demais' });

  // campo-isca preenchido = robô. Responde "ok" e descarta.
  if (corpo.site) return res.status(200).json({ ok: true });

  const r = corpo.respostas && typeof corpo.respostas === 'object' && !Array.isArray(corpo.respostas) ? corpo.respostas : {};
  const nome = txt(r.nome, 120);
  const whatsapp = txt(r.whatsapp, 30);
  if (!nome || nome.length < 2 || !whatsapp || whatsapp.replace(/\D/g, '').length < 10 || r.termo_aceito !== true) {
    return res.status(422).json({ ok: false, erro: 'dados_obrigatorios_ausentes' });
  }

  const leitura = limparLeitura(corpo.leitura);
  const duracao = num(corpo.meta && corpo.meta.duracao_min, 1, 1440);
  const idade = num(r.idade, 18, 99);
  const horasSemana = num(r.horas_semana, 1, 140);

  const linha = {
    etapa: 'inicial',
    nome,
    email: txt(r.email, 160),
    whatsapp,
    cidade: txt(r.cidade, 120),
    idade: idade === null ? null : Math.round(idade),
    dependencia_negocio: nota(r.dependencia_negocio),
    casamento_nota: nota(r.casamento_nota),
    casamento_nota_esposa: nota(r.casamento_nota_esposa),
    filhos_presenca: nota(r.filhos_presenca),
    filhos_nota: nota(r.filhos_nota),
    fe_pratica: nota(r.fe_pratica),
    energia: nota(r.energia),
    clareza_visao: nota(r.clareza_visao),
    horas_semana: horasSemana === null ? null : Math.round(horasSemana),
    horas_sono: num(r.horas_sono, 1, 14),
    duracao_min: duracao === null ? null : Math.round(duracao),
    respostas: r,
    leitura
  };

  const salvo = await salvar(linha);
  const email = await enviarEmail({ nome, linha, leitura, salvo, duracao: linha.duracao_min });

  if (!salvo.ok) console.error('[anamnese] não salvou:', salvo.motivo);
  if (!email.ok) console.error('[anamnese] e-mail não enviado:', email.motivo);

  if (!salvo.ok && !email.ok) return res.status(502).json({ ok: false, erro: 'indisponivel' });
  return res.status(200).json({ ok: true, salvo: salvo.ok, email: email.ok });
};
