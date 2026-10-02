// Cria uma preferência de pagamento no Mercado Pago (Checkout Pro).
// Variáveis (Cloudflare Pages > Settings > Variables and secrets):
//   MP_ACCESS_TOKEN  (obrigatória, secreta)  -> Access Token do Mercado Pago (teste ou produção)
// Os preços vêm SEMPRE do precos.json no servidor; o navegador nunca decide o valor.

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

const soDigitos = (v) => String(v || '').replace(/\D/g, '');
const limpa = (v, max = 120) => String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, max);

export async function onRequestPost({ request, env }) {
  if (!env.MP_ACCESS_TOKEN) return json({ erro: 'O pagamento ainda não foi configurado. Fale com a gente pelo WhatsApp.' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ erro: 'Pedido inválido.' }, 400); }

  const origin = new URL(request.url).origin;

  // preços oficiais
  let precos;
  try {
    const r = await env.ASSETS.fetch(new URL('/precos.json', request.url));
    precos = await r.json();
  } catch { return json({ erro: 'Não foi possível carregar os preços.' }, 500); }

  // itens
  const entrada = Array.isArray(body.itens) ? body.itens.slice(0, 40) : [];
  const itens = [];
  for (const it of entrada) {
    const id = limpa(it && it.id, 10);
    const qtd = Number.isInteger(it && it.qtd) ? it.qtd : parseInt(it && it.qtd, 10);
    const p = precos.jogos && precos.jogos[id];
    if (!p || typeof p.valor !== 'number' || !(p.valor > 0)) return json({ erro: 'Um dos jogos do carrinho está indisponível no momento.' }, 400);
    if (!(qtd >= 1 && qtd <= 10)) return json({ erro: 'Quantidade inválida.' }, 400);
    itens.push({ id, nome: p.nome, qtd, valor: Math.round(p.valor * 100) / 100 });
  }
  if (!itens.length) return json({ erro: 'Seu carrinho está vazio.' }, 400);

  // cliente
  const c = body.cliente || {};
  const cliente = {
    nome: limpa(c.nome), email: limpa(c.email), whatsapp: soDigitos(c.whatsapp).slice(0, 11), cep: soDigitos(c.cep).slice(0, 8),
    uf: limpa(c.uf, 2).toUpperCase(), endereco: limpa(c.endereco), numero: limpa(c.numero, 10), complemento: limpa(c.complemento, 60),
    bairro: limpa(c.bairro, 60), cidade: limpa(c.cidade, 60),
  };
  if (!cliente.nome || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cliente.email) || cliente.whatsapp.length < 10 || cliente.cep.length !== 8 ||
      cliente.uf.length !== 2 || !cliente.endereco || !cliente.numero || !cliente.bairro || !cliente.cidade) {
    return json({ erro: 'Confira os dados de contato e de entrega.' }, 400);
  }
  const obs = limpa(body.obs, 300);

  // forma de pagamento escolhida -> tipos excluídos
  const pagamento = limpa(body.pagamento, 30);
  let excluidos = [];
  if (/pix/i.test(pagamento)) excluidos = ['credit_card', 'debit_card', 'ticket', 'prepaid_card'];
  else if (/boleto/i.test(pagamento)) excluidos = ['credit_card', 'debit_card', 'bank_transfer', 'prepaid_card'];
  else if (/cart/i.test(pagamento)) excluidos = ['ticket', 'bank_transfer'];

  const frete = typeof precos.frete === 'number' && precos.frete > 0 ? Math.round(precos.frete * 100) / 100 : 0;
  const subtotal = itens.reduce((a, i) => a + i.valor * i.qtd, 0);
  const total = Math.round((subtotal + frete) * 100) / 100;

  const ref = 'T360-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();

  const mpItens = itens.map((i) => ({ id: i.id, title: i.nome, quantity: i.qtd, unit_price: i.valor, currency_id: 'BRL' }));
  if (frete > 0) mpItens.push({ id: 'frete', title: 'Frete', quantity: 1, unit_price: frete, currency_id: 'BRL' });

  const pref = {
    items: mpItens,
    payer: {
      name: cliente.nome,
      email: cliente.email,
      phone: { area_code: cliente.whatsapp.slice(0, 2), number: cliente.whatsapp.slice(2) },
      address: { zip_code: cliente.cep, street_name: cliente.endereco, street_number: parseInt(cliente.numero, 10) || 0 },
    },
    back_urls: {
      success: origin + '/pedido.html?s=ok',
      pending: origin + '/pedido.html?s=pendente',
      failure: origin + '/pedido.html?s=erro',
    },
    auto_return: 'approved',
    external_reference: ref,
    notification_url: origin + '/api/webhook-mp',
    statement_descriptor: 'TABULEIRO360',
    metadata: {
      ref, obs, frete, subtotal, total,
      cliente,
      itens: itens.map((i) => ({ id: i.id, nome: i.nome, qtd: i.qtd, valor: i.valor })),
    },
  };
  if (excluidos.length) pref.payment_methods = { excluded_payment_types: excluidos.map((id) => ({ id })) };

  let resp, dados;
  try {
    resp = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.MP_ACCESS_TOKEN, 'x-idempotency-key': ref },
      body: JSON.stringify(pref),
    });
    dados = await resp.json();
  } catch { return json({ erro: 'Não conseguimos falar com o Mercado Pago agora. Tente de novo em instantes.' }, 502); }

  if (!resp.ok || !dados.init_point) {
    console.log('Erro Mercado Pago', resp.status, JSON.stringify(dados).slice(0, 500));
    return json({ erro: 'O Mercado Pago recusou o pedido. Confira os dados e tente de novo.' }, 502);
  }

  return json({
    url: dados.init_point, ref, total,
    frete,
    itens: itens.map((i) => ({ nome: i.nome, qtd: i.qtd, valor: i.valor })),
  });
}

export const onRequestGet = () => json({ erro: 'Método não permitido.' }, 405);
