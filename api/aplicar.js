/**
 * Claudio Alecrim | Aplicações do site
 * Recebe o formulário de /aplicar, salva no Supabase e avisa o Claudio por e-mail e WhatsApp.
 * Sem dependências (fetch nativo do Node 18+).
 *
 * Variáveis de ambiente (Vercel > Project > Settings > Environment Variables):
 *   SUPABASE_URL                https://SEU-PROJETO.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY   chave secreta do projeto (service_role)
 *   RESEND_API_KEY              chave da API do Resend
 *   CALLMEBOT_PHONE             número do Claudio com DDI, só dígitos (ex.: 5543999999999)
 *   CALLMEBOT_APIKEY            chave recebida do CallMeBot
 *   EMAIL_DESTINO   (opcional)  padrão: suadevolutiva@gmail.com
 *   EMAIL_REMETENTE (opcional)  padrão: Site Claudio Alecrim <onboarding@resend.dev>
 *
 * As três entregas são independentes: se uma falhar, as outras seguem.
 * O visitante só vê erro quando não salvou E nenhum aviso saiu.
 *
 * GET /api/aplicar faz uma consulta leve no Supabase (cron diário para o projeto não pausar).
 */

const TABELA = 'aplicacoes_site';
const DESTINO_PADRAO = 'suadevolutiva@gmail.com';
const REMETENTE_PADRAO = 'Site Claudio Alecrim <onboarding@resend.dev>';
const PRAZO_MS = 5000;
const TAMANHO_MAXIMO = 20000;

const BUSCAS = {
  'governo-pessoal': 'Governo Pessoal',
  'mesa-de-decisao': 'Mesa de Decisão',
  'mente-blindada': 'Mente Blindada',
  'ainda-nao-sei': 'Ainda não sei'
};
const FORMATOS = { presencial: 'Presencial (Londrina)', online: 'Online' };
const PARTICIPANTES = { 'ate-20': 'Até 20', '21-50': '21 a 50', '51-100': '51 a 100', 'acima-100': 'Acima de 100' };

/* ---------- utilitários ---------- */

function comPrazo(url, opcoes, ms) {
  const controle = new AbortController();
  const relogio = setTimeout(() => controle.abort(), ms);
  return fetch(url, { ...opcoes, signal: controle.signal }).finally(() => clearTimeout(relogio));
}

function txt(v, max) {
  return typeof v === 'string' && v.trim() ? v.trim().replace(/\s+\n/g, '\n').slice(0, max) : null;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function resumo(s, max) {
  if (!s) return '';
  const limpo = s.replace(/\s+/g, ' ').trim();
  return limpo.length > max ? limpo.slice(0, max - 1) + '…' : limpo;
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
      headers: { apikey: sb.chave, Authorization: `Bearer ${sb.chave}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify(linha)
    }, PRAZO_MS);
    if (r.ok) {
      const dados = await r.json().catch(() => []);
      return { ok: true, id: dados && dados[0] && dados[0].id };
    }
    const erro = await r.json().catch(() => ({}));
    return { ok: false, motivo: `Supabase respondeu ${r.status}${erro && erro.message ? ': ' + String(erro.message).slice(0, 140) : ''}` };
  } catch (e) {
    return { ok: false, motivo: e && e.name === 'AbortError' ? 'Supabase não respondeu a tempo (projeto pode estar pausado)' : 'Falha de rede ao falar com o Supabase' };
  }
}

async function marcarAvisos(id, email, whatsapp) {
  const sb = configSupabase();
  if (!sb || !id) return;
  try {
    await comPrazo(`${sb.url}/rest/v1/${TABELA}?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { apikey: sb.chave, Authorization: `Bearer ${sb.chave}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ aviso_email: email, aviso_whatsapp: whatsapp })
    }, PRAZO_MS);
  } catch (e) { /* só registro, não afeta o visitante */ }
}

/* ---------- textos do aviso ---------- */

function linhasDetalhe(l) {
  const itens = [];
  if (l.busca === 'mente-blindada') {
    itens.push(['Empresa', l.empresa], ['Cargo', l.cargo], ['Participantes', PARTICIPANTES[l.participantes]], ['Maior desafio da equipe', l.desafio_equipe]);
  } else {
    itens.push(['Formato', FORMATOS[l.formato]], ['O que o trouxe até aqui', l.motivo], ['Disposição', l.disposicao === null ? null : `${l.disposicao}/10`]);
  }
  return itens.filter((i) => i[1] !== null && i[1] !== undefined && i[1] !== '');
}

function textoWhatsapp(l) {
  const partes = [
    `🔔 Nova aplicação: ${BUSCAS[l.busca]}`,
    `${l.nome} · ${l.cidade || '-'} · ${l.whatsapp}`
  ];
  if (l.busca === 'mente-blindada') {
    partes.push(`${l.empresa} (${l.cargo}) · ${PARTICIPANTES[l.participantes] || '-'} pessoas`);
    partes.push(`"${resumo(l.desafio_equipe, 160)}"`);
  } else {
    partes.push(`"${resumo(l.motivo, 160)}"${l.disposicao !== null ? ` · Disposição: ${l.disposicao}/10` : ''}`);
  }
  partes.push(`Responder: https://wa.me/${l.whatsapp.replace(/\D/g, '').replace(/^(?!55)/, '55')}`);
  return partes.join('\n');
}

function montarEmail(l, salvo) {
  const aviso = salvo.ok ? '' :
    `<p style="margin:0 0 20px;padding:12px 14px;background:#FDECEA;border:1px solid #E5A79C;color:#7A1E12;font-size:14px"><strong>Atenção:</strong> esta aplicação não foi salva no Supabase (${esc(salvo.motivo)}). Guarde este e-mail.</p>`;
  const wa = l.whatsapp.replace(/\D/g, '').replace(/^(?!55)/, '55');
  const detalhes = linhasDetalhe(l).map(([k, v]) => `
      <p style="margin:16px 0 2px;font-size:13px;color:#6B6455">${esc(k)}</p>
      <p style="margin:0;font-size:16px;line-height:1.5;color:#111;white-space:pre-wrap">${esc(v)}</p>`).join('');

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#EDEDED;font-family:Arial,Helvetica,sans-serif">
    <div style="max-width:620px;margin:0 auto;padding:28px;background:#FFFFFF;border-top:4px solid #C9A84C">
      <p style="margin:0;font-size:13px;color:#6B6455;letter-spacing:.08em;text-transform:uppercase">Nova aplicação · ${esc(BUSCAS[l.busca])}</p>
      <h1 style="margin:6px 0 6px;font:700 26px Georgia,serif;color:#111">${esc(l.nome)}</h1>
      <p style="margin:0 0 20px;font-size:14px;color:#444">${esc(l.cidade || '')} &nbsp;|&nbsp; ${esc(l.whatsapp)} &nbsp;|&nbsp; ${esc(l.email)}</p>
      ${aviso}
      <p style="margin:0 0 8px"><a href="https://wa.me/${wa}" style="display:inline-block;padding:12px 20px;background:#C9A84C;color:#111;text-decoration:none;font-weight:bold;font-size:14px">Responder no WhatsApp</a></p>
      ${detalhes}
      <p style="margin:28px 0 0;font-size:12px;color:#888">Compromisso: responder em até 48 horas.</p>
    </div></body></html>`;

  const texto = [`Nova aplicação: ${BUSCAS[l.busca]}`, `${l.nome} | ${l.cidade || ''} | ${l.whatsapp} | ${l.email}`,
    salvo.ok ? '' : `ATENÇÃO: não salvou no Supabase (${salvo.motivo}).`]
    .concat(linhasDetalhe(l).map(([k, v]) => `\n${k}:\n${v}`)).filter(Boolean).join('\n');

  return { html, texto };
}

/* ---------- avisos ---------- */

async function enviarEmail(l, salvo) {
  const chave = process.env.RESEND_API_KEY;
  if (!chave) return { ok: false, motivo: 'Resend não configurado no Vercel' };
  const { html, texto } = montarEmail(l, salvo);
  const corpo = {
    from: process.env.EMAIL_REMETENTE || REMETENTE_PADRAO,
    to: [process.env.EMAIL_DESTINO || DESTINO_PADRAO],
    subject: `Nova aplicação: ${BUSCAS[l.busca]} · ${l.nome}${salvo.ok ? '' : ' [não salvou no banco]'}`,
    html, text: texto,
    reply_to: l.email
  };
  try {
    const r = await comPrazo('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${chave}`, 'Content-Type': 'application/json' }, body: JSON.stringify(corpo)
    }, PRAZO_MS);
    if (r.ok) return { ok: true };
    const erro = await r.json().catch(() => ({}));
    return { ok: false, motivo: `Resend respondeu ${r.status}${erro && erro.message ? ': ' + String(erro.message).slice(0, 140) : ''}` };
  } catch (e) {
    return { ok: false, motivo: e && e.name === 'AbortError' ? 'Resend não respondeu a tempo' : 'Falha de rede ao falar com o Resend' };
  }
}

async function enviarWhatsapp(l) {
  const fone = (process.env.CALLMEBOT_PHONE || '').replace(/\D/g, '');
  const chave = process.env.CALLMEBOT_APIKEY || '';
  if (!fone || !chave) return { ok: false, motivo: 'CallMeBot não configurado no Vercel' };
  const url = `https://api.callmebot.com/whatsapp.php?phone=${fone}&apikey=${encodeURIComponent(chave)}&text=${encodeURIComponent(textoWhatsapp(l))}`;
  try {
    const r = await comPrazo(url, { method: 'GET' }, 8000);
    const corpo = await r.text().catch(() => '');
    // o CallMeBot responde 200 mesmo em alguns erros; confere o texto
    if (r.ok && !/error|invalid|not\s+allowed/i.test(corpo)) return { ok: true };
    return { ok: false, motivo: `CallMeBot respondeu ${r.status}: ${resumo(corpo.replace(/<[^>]+>/g, ' '), 140)}` };
  } catch (e) {
    return { ok: false, motivo: e && e.name === 'AbortError' ? 'CallMeBot não respondeu a tempo' : 'Falha de rede ao falar com o CallMeBot' };
  }
}

/* ---------- ping (cron) ---------- */

async function ping(res) {
  const sb = configSupabase();
  if (!sb) return res.status(503).json({ ok: false, erro: 'supabase_nao_configurado' });
  try {
    const r = await comPrazo(`${sb.url}/rest/v1/${TABELA}?select=id&limit=1`, { headers: { apikey: sb.chave, Authorization: `Bearer ${sb.chave}` } }, PRAZO_MS);
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

  let c = req.body;
  if (typeof c === 'string') { try { c = JSON.parse(c); } catch (e) { c = null; } }
  if (!c || typeof c !== 'object' || Array.isArray(c)) return res.status(400).json({ ok: false, erro: 'corpo_invalido' });
  if (JSON.stringify(c).length > TAMANHO_MAXIMO) return res.status(413).json({ ok: false, erro: 'corpo_grande_demais' });

  // campo-isca preenchido ou envio rápido demais = robô. Responde "ok" e descarta.
  if (c.site || (typeof c.tempo_s === 'number' && c.tempo_s < 4)) return res.status(200).json({ ok: true });

  const busca = BUSCAS[c.busca] ? c.busca : null;
  const nome = txt(c.nome, 120);
  const whatsapp = txt(c.whatsapp, 20);
  const email = txt(c.email, 160);
  const emailOk = email && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
  if (!busca || !nome || nome.length < 2 || !whatsapp || whatsapp.replace(/\D/g, '').length < 10 || !emailOk || c.consentimento !== true) {
    return res.status(422).json({ ok: false, erro: 'dados_obrigatorios_ausentes' });
  }

  const empresa = busca === 'mente-blindada';
  const disp = Number(c.disposicao);
  const linha = {
    busca, nome, whatsapp, email,
    cidade: txt(c.cidade, 120),
    consentimento: true,
    origem: txt(c.origem, 200),
    formato: !empresa && FORMATOS[c.formato] ? c.formato : null,
    motivo: !empresa ? txt(c.motivo, 2000) : null,
    disposicao: !empresa && Number.isInteger(disp) && disp >= 0 && disp <= 10 ? disp : null,
    empresa: empresa ? txt(c.empresa, 160) : null,
    cargo: empresa ? txt(c.cargo, 120) : null,
    participantes: empresa && PARTICIPANTES[c.participantes] ? c.participantes : null,
    desafio_equipe: empresa ? txt(c.desafio_equipe, 2000) : null
  };

  const salvo = await salvar(linha);
  const [mail, whats] = await Promise.all([enviarEmail(linha, salvo), enviarWhatsapp(linha)]);
  if (salvo.ok) await marcarAvisos(salvo.id, mail.ok, whats.ok);

  if (!salvo.ok) console.error('[aplicar] não salvou:', salvo.motivo);
  if (!mail.ok) console.error('[aplicar] e-mail não enviado:', mail.motivo);
  if (!whats.ok) console.error('[aplicar] WhatsApp não enviado:', whats.motivo);

  if (!salvo.ok && !mail.ok && !whats.ok) return res.status(502).json({ ok: false, erro: 'indisponivel' });
  return res.status(200).json({ ok: true });
};
