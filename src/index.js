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

app.get('/', (req, res) => {
  res.send('ShopPilot is running! 🚀');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ShopPilot running on port ${PORT}`);
});