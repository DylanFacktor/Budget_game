// Vercel serverless function: AI feedback for Scoping Room submissions.
// Reads ANTHROPIC_API_KEY from Vercel env vars. Returns { headline, bullets[] }.

const MODEL = 'claude-haiku-4-5';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_TOKENS = 600;

const SYSTEM_PROMPT = `You are a senior consulting partner reviewing an associate's staffing plan for a healthcare consulting engagement. Tone: direct, specific, no generic praise. Reference specific deliverables and tiers, suggest concrete adjustments. Use the voice of a real reviewer — phrases like "the senior coverage on X is light," "consider flexing Y to associate hours," "the mix on Z is right."

You will receive: an engagement brief, the associate's staffing plan (hours per role per deliverable), the staffing-rule issues flagged by an automated rule engine, and the final score.

Respond with ONLY a JSON object matching this schema:
{
  "headline": "<one sentence summarizing how the plan reads to a reviewer>",
  "bullets": ["<3 to 5 strings, each a specific actionable improvement>"]
}

Rules:
- No markdown, no preamble, no closing remarks. Just the JSON.
- Bullets must reference SPECIFIC deliverables and tiers from the plan.
- Do not just restate the rule issues — translate them into improvement language.
- If the plan scored 90+, bullets can be 2-3 entries and acknowledge what's working, but include at least one refinement.
- Never use exclamation marks or marketing speak.`;

function buildUserMessage(payload) {
  const { engagement, deliverables, issues, outcome } = payload;
  const staffingLines = deliverables.map(d => {
    const staff = d.staffing.map(s => `${s.role}: ${s.hrs}h`).join(', ');
    return `- ${d.name} (${d.hrsTotal}h, $${d.cost.toLocaleString()})\n    ${staff || '(unstaffed)'}`;
  }).join('\n');

  const issueLines = issues.length === 0
    ? '(no rule issues flagged)'
    : issues.map(i => `- ${i.deliverable} [${i.severity}]: missing ${i.missing}, gap of ${i.gap}h`).join('\n');

  return `ENGAGEMENT: ${engagement.name} (${engagement.type})
Budget: $${engagement.budget.toLocaleString()} (tolerance plus/minus ${(engagement.tolerance * 100).toFixed(0)}%)
Brief: ${engagement.brief}

STAFFING PLAN:
${staffingLines}

RULE ENGINE FLAGGED:
${issueLines}

OUTCOME:
- Total fees: $${outcome.totalFees.toLocaleString()}
- Variance: ${outcome.variancePct}%
- Score: ${outcome.score}/100

Provide your review as JSON.`;
}

function parseJsonResponse(text) {
  try {
    return JSON.parse(text);
  } catch {}
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function validatePayload(body) {
  if (!body || typeof body !== 'object') return 'Missing body';
  const { engagement, deliverables, outcome } = body;
  if (!engagement || typeof engagement.name !== 'string') return 'Missing engagement';
  if (!Array.isArray(deliverables)) return 'Missing deliverables';
  if (!outcome || typeof outcome.score !== 'number') return 'Missing outcome';
  return null;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'API key not configured' });
    return;
  }

  const validationError = validatePayload(req.body);
  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserMessage(req.body) }]
      })
    });

    if (!upstream.ok) {
      res.status(502).json({ error: 'Upstream error' });
      return;
    }

    const data = await upstream.json();
    const text = data && data.content && data.content[0] && data.content[0].text;
    if (!text) {
      res.status(502).json({ error: 'Empty response' });
      return;
    }

    const parsed = parseJsonResponse(text);
    if (!parsed || typeof parsed.headline !== 'string' || !Array.isArray(parsed.bullets)) {
      res.status(502).json({ error: 'Bad response shape' });
      return;
    }

    res.status(200).json({
      headline: parsed.headline,
      bullets: parsed.bullets.filter(b => typeof b === 'string').slice(0, 6)
    });
  } catch (err) {
    res.status(502).json({ error: 'Request failed' });
  }
};
