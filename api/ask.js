import { requireSession } from './_auth.js';

export default async function handler(req, res) {
  // Fix 2026-10-01: endpoint não tinha NENHUMA verificação de acesso --
  // qualquer um que descobrisse a URL usava o proxy da Anthropic de graça,
  // na conta da Suno, sem passar pela tela de login. Mesmo gate de sessão
  // de api/data.js (ver api/_auth.js).
  if (await requireSession(req, res)) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const apiKey = process.env.ANTHROPIC_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_KEY não configurada no servidor.' });
  }
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
