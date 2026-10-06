// CodeQuest Pro: ლიცენზიის კოდის შემოწმება Dodo Payments-თან.
// Dodo-ს API ბრაუზერიდან პირდაპირ არ იძახება (CORS), ამიტომ თამაში ამ Vercel-ის ფუნქციას მიმართავს.
// საიდუმლო გასაღები არ სჭირდება — /licenses/validate საჯარო მეთოდია.
// Vercel → Settings → Environment Variables: DODO_MODE = live (ნამდვილი გადახდები) ან test (სატესტო, ნაგულისხმევი).
const BASE = { live: 'https://live.dodopayments.com', test: 'https://test.dodopayments.com' };

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ valid: false, error: 'method_not_allowed' });
  }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const key = String((body && body.license_key) || '').trim();
  if (!key || key.length > 200) return res.status(400).json({ valid: false, error: 'bad_key' });

  const base = BASE[process.env.DODO_MODE] || BASE.test;
  try {
    const r = await fetch(base + '/licenses/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ license_key: key })
    });
    if (r.status === 404 || r.status === 422) return res.status(200).json({ valid: false });
    if (!r.ok) return res.status(502).json({ valid: false, error: 'upstream_' + r.status });
    const data = await r.json();
    return res.status(200).json({ valid: data.valid === true });
  } catch (e) {
    return res.status(502).json({ valid: false, error: 'upstream_unreachable' });
  }
};
