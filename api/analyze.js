// api/analyze.js
// Handles: POST /api/analyze
// Proxies requests to Anthropic API — keeps API key server-side only
// Supports: text messages, URLs, and image screenshots (base64)

const Anthropic = require('@anthropic-ai/sdk');
const { handleOptions, success, error } = require('./_lib/helpers');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are PhishGuard+, an expert cybersecurity AI that analyzes messages, URLs, and screenshots for scams, phishing, and social engineering attacks. You specialize in detecting threats from WhatsApp, Facebook Messenger, SMS, email, and other platforms.

Analyze the provided input and return ONLY a valid JSON object (no markdown, no backticks, no preamble) with this exact structure:
{
  "threatScore": <number 0-100>,
  "riskLevel": <"CRITICAL" | "HIGH" | "MEDIUM" | "LOW">,
  "verdict": <string: 2-3 sentence plain-language verdict>,
  "threatTypes": <array from: "PHISHING_URL", "ROMANCE_SCAM", "FINANCIAL_FRAUD", "IMPERSONATION", "SUSPICIOUS_LINK", "SAFE">,
  "redFlags": [
    {
      "type": <short category label>,
      "icon": <single emoji>,
      "description": <clear explanation of this specific red flag>
    }
  ],
  "advice": [<string: specific actionable step>]
}

For URL analysis: check protocol (http vs https), domain spelling vs known brands (paypa1, g00gle, arnazon), URL shorteners (bit.ly, tinyurl, t.co), suspicious TLDs, excessive subdomains, numeric IPs, deceptive path names, suspicious query parameters.

Rules:
- threatScore: 0-20=LOW, 21-50=MEDIUM, 51-75=HIGH, 76-100=CRITICAL
- redFlags: 0 if safe, 2-6 if suspicious
- advice: 3-5 concrete steps
- Be specific to the actual content provided
- Nigerian-specific threats: GTBank, Access Bank, Zenith, CBN, INEC, EFCC impersonation`;

module.exports = async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return error(res, 'Method not allowed', 405);

  const { type, content, base64, mediaType } = req.body || {};

  if (!type || !['text', 'link', 'image'].includes(type)) {
    return error(res, 'Invalid type. Must be "text", "link", or "image"');
  }

  // ── Build messages array ─────────────────────────────────
  let messages;

  if (type === 'text') {
    if (!content || content.trim().length < 3) {
      return error(res, 'Please provide a message to analyze');
    }
    messages = [{
      role: 'user',
      content: `Analyze this message for scams and phishing:\n\n"${content.trim()}"`
    }];
  }

  else if (type === 'link') {
    if (!content || content.trim().length < 4) {
      return error(res, 'Please provide a URL to analyze');
    }
    messages = [{
      role: 'user',
      content: `Analyze this URL for phishing, scams, or suspicious indicators. Perform a thorough check on domain, protocol, structure, and patterns:\n\n${content.trim()}`
    }];
  }

  else if (type === 'image') {
    if (!base64 || !mediaType) {
      return error(res, 'Image data (base64) and mediaType are required');
    }
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowedTypes.includes(mediaType)) {
      return error(res, 'Unsupported image type. Use JPEG, PNG, WEBP, or GIF');
    }
    messages = [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: base64 }
        },
        {
          type: 'text',
          text: 'Analyze this screenshot of a message for scams, phishing, or social engineering threats. Read all text visible in the image.'
        }
      ]
    }];
  }

  // ── Call Anthropic ───────────────────────────────────────
  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages,
    });

    const raw = response.content.map(b => b.text || '').join('');
    const clean = raw.replace(/```json|```/g, '').trim();
    const result = JSON.parse(clean);

    // Validate required fields
    if (typeof result.threatScore !== 'number' || !result.riskLevel) {
      throw new Error('Invalid response structure from AI');
    }

    return success(res, { result });

  } catch (err) {
    console.error('Analyze error:', err.message);

    // Return a graceful fallback so the frontend doesn't crash
    return success(res, {
      result: {
        threatScore: 0,
        riskLevel: 'LOW',
        verdict: 'Analysis could not be completed at this time. Please try again in a moment.',
        threatTypes: [],
        redFlags: [],
        advice: ['Please try again', 'Check your internet connection', 'Contact support if the issue persists']
      }
    });
  }
};
