// Recebe o aviso do Mercado Pago, confere o pagamento direto na API deles e avisa você por e-mail.
// Variáveis (Cloudflare Pages > Settings > Variables and secrets):
//   MP_ACCESS_TOKEN     (obrigatória, secreta)
//   MP_WEBHOOK_SECRET   (recomendada, secreta)  -> "Assinatura secreta" do webhook no painel do Mercado Pago
//   RESEND_API_KEY      (opcional, secreta)     -> envio do e-mail de aviso (resend.com)
//   NOTIFY_EMAIL        (opcional)              -> para onde enviar o aviso (padrão: Tabuca360@gmail.com)
//   MAIL_FROM           (opcional)              -> remetente (padrão: Tabuleiro 360 <onboarding@resend.dev>)

const ok = () => new Response('ok', { status: 200 });

async function hmacHex(chave, texto) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(chave), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(texto));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const brl = (n) => Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export async function onRequestPost({ request, env, waitUntil }) {
  if (!env.MP_ACCESS_TOKEN) return ok();
  const url = new URL(request.url);
  let corpo = {};
  try { corpo = await request.json(); } catch {}

  const tipo = corpo.type || url.searchParams.get('type') || url.searchParams.get('topic');
  const id = (corpo.data && corpo.data.id) || url.searchParams.get('data.id') || url.searchParams.get('id');
  if (tipo !== 'payment' || !id) return ok();

  // assinatura (quando a chave secreta estiver configurada)
  if (env.MP_WEBHOOK_SECRET) {
    const cab = request.headers.get('x-signature') || '';
    const ts = (cab.match(/ts=([^,]+)/) || [])[1];
    const v1 = (cab.match(/v1=([^,]+)/) || [])[1];
    const reqId = request.headers.get('x-request-id') || '';
    if (!ts || !v1) return new Response('assinatura ausente', { status: 401 });
    const esperado = await hmacHex(env.MP_WEBHOOK_SECRET, `id:${String(id).toLowerCase()};request-id:${reqId};ts:${ts};`);
    if (esperado !== v1) return new Response('assinatura inválida', { status: 401 });
  }

  // confere o pagamento na fonte
  const r = await fetch('https://api.mercadopago.com/v1/payments/' + encodeURIComponent(id), {
    headers: { authorization: 'Bearer ' + env.MP_ACCESS_TOKEN },
  });
  if (!r.ok) return new Response('pagamento não encontrado', { status: 502 });
  const pg = await r.json();
  if (pg.status !== 'approved') return ok();

  // evita aviso duplicado (melhor esforço)
  const cache = caches.default;
  const chave = new Request('https://t360.invalid/pago/' + pg.id);
  if (await cache.match(chave)) return ok();
  await cache.put(chave, new Response('1', { headers: { 'cache-control': 'max-age=604800' } }));

  const m = pg.metadata || {};
  const cli = m.cliente || {};
  const itens = Array.isArray(m.itens) ? m.itens : [];
  const linhas = itens.map((i) => `<tr><td>${esc(i.nome)}</td><td style="text-align:center">${esc(i.qtd)}</td><td style="text-align:right">${brl(i.valor * i.qtd)}</td></tr>`).join('');
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px">
      <h2>Novo pedido pago — ${esc(pg.external_reference || m.ref)}</h2>
      <p><b>Total pago:</b> ${brl(pg.transaction_amount)} &nbsp;|&nbsp; <b>Forma:</b> ${esc(pg.payment_type_id)} / ${esc(pg.payment_method_id)}</p>
      <table style="width:100%;border-collapse:collapse" border="1" cellpadding="6">
        <tr><th align="left">Jogo</th><th>Qtd</th><th align="right">Valor</th></tr>${linhas}
      </table>
      <p><b>Frete:</b> ${m.frete > 0 ? brl(m.frete) : 'a combinar pelo WhatsApp'}</p>
      <h3>Cliente</h3>
      <p>${esc(cli.nome)}<br>WhatsApp: ${esc(cli.whatsapp)}<br>E-mail: ${esc(cli.email)}</p>
      <h3>Entrega</h3>
      <p>${esc(cli.endereco)}, ${esc(cli.numero)} ${esc(cli.complemento)}<br>${esc(cli.bairro)} — ${esc(cli.cidade)}/${esc(cli.uf)}<br>CEP ${esc(cli.cep)}</p>
      ${m.obs ? `<p><b>Observações:</b> ${esc(m.obs)}</p>` : ''}
      <p style="color:#666;font-size:12px">Pagamento Mercado Pago nº ${esc(pg.id)}</p>
    </div>`;

  if (env.RESEND_API_KEY) {
    const para = env.NOTIFY_EMAIL || 'Tabuca360@gmail.com';
    waitUntil(
      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.RESEND_API_KEY },
        body: JSON.stringify({
          from: env.MAIL_FROM || 'Tabuleiro 360 <onboarding@resend.dev>',
          to: [para],
          subject: `Novo pedido pago ${pg.external_reference || ''} — ${brl(pg.transaction_amount)}`,
          html,
        }),
      }).catch(() => {})
    );
  } else {
    console.log('Pedido pago (sem RESEND_API_KEY, e-mail não enviado):', pg.id, pg.external_reference);
  }
  return ok();
}

export const onRequestGet = () => ok();
