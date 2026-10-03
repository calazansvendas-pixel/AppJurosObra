// Vercel Serverless Function — proxy para a série 226 (TR) do SGS do Banco Central.
// Necessário porque, em produção na Vercel, server.js (Express com app.listen) não roda:
// a Vercel só expõe funções serverless sob /api. Sem este arquivo, a chamada do
// cliente a /api/tr recebia 404 e o simulador caía direto para o valor fixo de fallback.
const BCB_TR_URL = 'https://api.bcb.gov.br/dados/serie/bcdata.sgs.226/dados/ultimos/1?formato=json';

// Timeout curto + poucas tentativas: funções serverless têm limite de execução
// (~10s no plano gratuito da Vercel), então não dá pra repetir tanto quanto no
// server.js local. Mesmo assim cobre blips passageiros de DNS/conexão ao BCB.
async function fetchComRetry(url, { tentativas = 2, timeoutMs = 4000, atrasoMs = 500 } = {}) {
  let ultimoErro = null;
  for (let i = 1; i <= tentativas; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (response.ok) return response;
      ultimoErro = new Error(`HTTP ${response.status} ${response.statusText}`);
    } catch (err) {
      clearTimeout(timer);
      ultimoErro = err;
    }
    console.warn(`TR: tentativa ${i}/${tentativas} falhou (${ultimoErro?.code || ultimoErro?.message || ultimoErro})`);
    if (i < tentativas) await new Promise((r) => setTimeout(r, atrasoMs * i));
  }
  throw ultimoErro;
}

export default async function handler(req, res) {
  try {
    const response = await fetchComRetry(BCB_TR_URL);
    const data = await response.json();
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    res.status(200).json(data);
  } catch (err) {
    console.error('Error proxying TR from BCB:', err?.code || err?.message || err);
    res.status(502).json({ error: 'Failed to fetch TR data', detail: err?.code || err?.message || String(err) });
  }
}
