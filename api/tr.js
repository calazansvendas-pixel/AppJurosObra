// Vercel Serverless Function — proxy para a série 226 (TR) do SGS do Banco Central.
// Necessário porque, em produção na Vercel, server.js (Express com app.listen) não roda:
// a Vercel só expõe funções serverless sob /api. Sem este arquivo, a chamada do
// cliente a /api/tr recebia 404 e o simulador caía direto para o valor fixo de fallback.
export default async function handler(req, res) {
  try {
    const response = await fetch('https://api.bcb.gov.br/dados/serie/bcdata.sgs.226/dados/ultimos/1?formato=json');
    if (!response.ok) {
      throw new Error(`BCB API error: ${response.statusText}`);
    }
    const data = await response.json();
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    res.status(200).json(data);
  } catch (err) {
    console.error('Error proxying TR from BCB:', err);
    res.status(500).json({ error: 'Failed to fetch TR data' });
  }
}
