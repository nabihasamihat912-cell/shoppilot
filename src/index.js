require('dotenv').config();
const Groq = require('groq-sdk');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const express = require('express');
const { shopifyApi, ApiVersion, Session } = require('@shopify/shopify-api');
const { nodeAdapter } = require('@shopify/shopify-api/adapters/node');

const app = express();
app.use(express.json());

const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  scopes: process.env.SHOPIFY_SCOPES.split(','),
  hostName: process.env.HOST.replace('https://', ''),
  apiVersion: ApiVersion.July25,
  isEmbeddedApp: false,
  adapter: nodeAdapter,
});

app.get('/auth', async (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).send('Missing shop parameter');
  await shopify.auth.begin({
    shop,
    callbackPath: '/auth/callback',
    isOnline: false,
    rawRequest: req,
    rawResponse: res,
  });
});

app.get('/auth/callback', async (req, res) => {
  try {
    const callback = await shopify.auth.callback({
      rawRequest: req,
      rawResponse: res,
    });
    console.log('✅ Store connected:', callback.session.shop);
    res.send(`✅ ShopPilot connected to ${callback.session.shop}! We are live!`);
  } catch (error) {
    console.error('Auth error:', error);
    res.status(500).send('Authentication failed: ' + error.message);
  }
});

app.post('/chat', async (req, res) => {
  const { message, storeContext } = req.body;
  if (!message) return res.status(400).json({ error: 'Missing message' });
  const response = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: `You are a helpful customer support assistant for a Shopify store. ${storeContext || ''}` },
      { role: 'user', content: message }
    ]
  });
  res.json({ reply: response.choices[0].message.content });
});
app.post('/generate-description', async (req, res) => {
  const { productName, details } = req.body;
  if (!productName) return res.status(400).json({ error: 'Missing productName' });

  const response = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: 'You are an expert ecommerce copywriter. Write compelling, SEO-friendly product descriptions.' },
      { role: 'user', content: `Write a product description for: ${productName}. Details: ${details || 'none provided'}` }
    ]
  });

  res.json({ description: response.choices[0].message.content });
});
app.post('/generate-caption', async (req, res) => {
  const { productName, platform } = req.body;
  if (!productName) return res.status(400).json({ error: 'Missing productName' });

  const response = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: `You are a social media expert. Write engaging captions for ${platform || 'Instagram'}.` },
      { role: 'user', content: `Write a social media caption for this product: ${productName}` }
    ]
  });

  res.json({ caption: response.choices[0].message.content });
});
app.post('/weekly-report', async (req, res) => {
  const { storeName, totalOrders, totalRevenue, topProduct } = req.body;
  if (!storeName) return res.status(400).json({ error: 'Missing storeName' });

  const orders = parseInt(totalOrders) || 0;
  const revenue = parseFloat(totalRevenue) || 0;
  const avgOrderValue = orders > 0 ? (revenue / orders).toFixed(2) : 0;

  const systemPrompt = `You are ShopPilot, an expert ecommerce analyst AI. You produce weekly store performance reports.

CRITICAL RULES — follow every single one:
1. NEVER use placeholder text like [insert value], [X%], [number], (specific value), or any bracketed/parenthetical estimates. If you don't know a value, omit that sentence entirely.
2. NEVER use markdown symbols like **, *, ##, or --- in your output. Plain text only.
3. All numbers you reference must come directly from the data provided. Do not invent percentages or metrics.
4. Be specific, concrete, and actionable. No vague generalities.
5. Respond ONLY with a valid JSON object — no preamble, no explanation, no markdown fences.

Return this exact JSON structure:
{
  "summary": "2-3 sentence plain-text executive summary using only the real numbers provided",
  "highlights": ["highlight 1", "highlight 2", "highlight 3"],
  "insights": [
    { "title": "short title", "body": "2-3 sentence insight using real data" },
    { "title": "short title", "body": "2-3 sentence insight using real data" },
    { "title": "short title", "body": "2-3 sentence insight using real data" }
  ],
  "recommendations": [
    { "title": "action title", "body": "specific, concrete recommendation" },
    { "title": "action title", "body": "specific, concrete recommendation" },
    { "title": "action title", "body": "specific, concrete recommendation" }
  ],
  "nextSteps": [
    "Concrete action item 1",
    "Concrete action item 2",
    "Concrete action item 3",
    "Concrete action item 4"
  ]
}`;

  const userPrompt = `Generate a weekly report for this Shopify store:
- Store name: ${storeName}
- Total orders this week: ${orders}
- Total revenue this week: $${revenue}
- Average order value: $${avgOrderValue}
- Top selling product: ${topProduct || 'Not specified'}

Use only these exact numbers. Do not invent any other metrics or percentages.`;

  try {
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.4
    });

    const raw = response.choices[0].message.content;
    const reportData = JSON.parse(raw);
    res.json({ success: true, reportData, meta: { storeName, orders, revenue, avgOrderValue, topProduct } });
  } catch (err) {
    console.error('Report generation error:', err);
    res.status(500).json({ error: 'Failed to generate report', details: err.message });
  }
});
app.use(express.static('src/public'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ShopPilot running on port ${PORT}`);
});