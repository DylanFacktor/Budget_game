// Vercel serverless function: AI feedback for Scoping Room submissions.
// Reads ANTHROPIC_API_KEY from Vercel env vars. Returns { headline, bullets[] }.

const MODEL = 'claude-haiku-4-5';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_TOKENS = 600;

const SYSTEM_PROMPT = `You are a friendly senior consultant reviewing a teammate's draft staffing plan. The point of the exercise is for the teammate to practice making the budget work by RATE and roughly the right team MIX — not to hit exact hour minimums. Be encouraging and practical, not harsh.

Tone: conversational, supportive, specific where it helps. Acknowledge what's working before suggesting tweaks. No "violations," no "non-negotiable." Use phrases like "you might consider," "one tweak to think about," "this is in good shape — one thing to flag."

You will receive: an engagement brief, the staffing plan (hours per role per deliverable), the staffing-rule issues from an automated check (thresholds are intentionally LOW — they only flag genuinely missing presence, not strict hour amounts), and the final score.

Respond with ONLY a JSON object matching this schema:
{
  "headline": "<one short sentence, supportive but honest>",
  "bullets": ["<2 to 4 strings, each a practical observation or tweak>"]
}

Rules:
- No markdown, no preamble. Just the JSON.
- Reference specific deliverables when calling something out, but only when it adds value.
- Critical issues are worth flagging; expected/nice-to-have are softer suggestions or can be skipped if the plan is broadly fine.
- If the plan scored 75+, lead with what's working — only one or two refinements.
- Never say "you failed" or "this is unacceptable." Even a poor plan is a learning draft.
- No exclamation marks. No marketing speak.
- Team coherence: comment briefly if the plan is fragmented across many roles when fewer would work.
- Specialties (Finance, Compliance, Clinical, etc.) are aspirational — phrase as "you'd want a finance-leaning Director here" when relevant. Don't beat this drum on every bullet.`;

function buildUserMessage(payload) {
  const { engagement, deliverables, issues, outcome } = payload;
  const staffingLines = deliverables.map(d => {
    const staff = d.staffing.map(s => `${s.role}: ${s.hrs}h`).join(', ');
    const spec = (d.specialties && d.specialties.length) ? ` [specialties: ${d.specialties.join(', ')}]` : '';
    return `- ${d.name}${spec} (${d.hrsTotal}h, $${d.cost.toLocaleString()})\n    ${staff || '(unstaffed)'}`;
  }).join('\n');

  const issueLines = issues.length === 0
    ? '(no rule issues flagged)'
    : issues.map(i => `- ${i.deliverable} [${i.severity}]: missing ${i.missing}, gap of ${i.gap}h`).join('\n');

  const teamLine = engagement.teamSize
    ? `Team size cap: ${engagement.teamSize} distinct roles (associate used ${engagement.teamUsed})`
    : '';
  const diffLine = engagement.difficulty && engagement.difficulty !== 'standard'
    ? `Difficulty: ${engagement.difficulty} (budget, ranges, tolerance, and team cap have already been scaled to reflect this)`
    : '';

  return `ENGAGEMENT: ${engagement.name} (${engagement.type})
Budget: $${engagement.budget.toLocaleString()} (tolerance plus/minus ${(engagement.tolerance * 100).toFixed(1)}%)
${teamLine}
${diffLine}
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
