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

  const response = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: 'You are an ecommerce analyst. Write a concise weekly performance report with insights and recommendations.' },
      { role: 'user', content: `Write a weekly report for ${storeName}. Orders: ${totalOrders || 0}, Revenue: $${totalRevenue || 0}, Top product: ${topProduct || 'unknown'}` }
    ]
  });

  res.json({ report: response.choices[0].message.content });
});
app.use(express.static('src/public'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ShopPilot running on port ${PORT}`);
});