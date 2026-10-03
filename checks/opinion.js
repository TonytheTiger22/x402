// Tier 3: "AI agent opinion" — a plain-English read on top of the
// deterministic signals every other check produces. Deliberately kept
// separate from the scoring logic in ip-trust.js / website-trust.js /
// email-trust.js: those stay zero-LLM, so their output never depends on a
// model's mood. This module's job is only to narrate an already-finished
// result, not to recompute risk.
//
// Needs ANTHROPIC_API_KEY. Degrades the same way the Tor list / RDAP
// lookups do elsewhere in this codebase — no key configured, or the call
// fails, and we say so plainly rather than inventing an opinion.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_OPINION_MODEL || "claude-haiku-4-5-20251001";
const OPINION_TIMEOUT_MS = 15000;

const SYSTEM_PROMPT = `You are a compliance analyst's assistant. You are shown the output of an
automated screening check — signals that have already been computed
deterministically. Do not re-derive, dispute, or second-guess the signals
themselves; reason over them as given.

Respond with strict JSON only, no markdown fences, no text outside the
object, in exactly this shape:
{"recommendation": "clear" | "review" | "escalate",
 "confidence": "low" | "medium" | "high",
 "reasoning": "2-4 plain-English sentences, written for a small-business
 owner with no compliance background, explaining why"}

"clear" = safe to proceed with no further action. "review" = proceed with
caution, a human should glance at it. "escalate" = stop and get a human
compliance decision before doing anything else.`;

function buildPrompt(checkType, subjectLabel, result) {
  const labels = {
    name: "a sanctions name screen",
    address: "a sanctioned crypto-address screen",
    website: "a website trust check",
    email: "an email trust check",
    ip: "an IP address risk check",
  };
  return `This is the result of ${labels[checkType] || "a screening check"} on "${subjectLabel}":\n\n` +
    JSON.stringify(result, null, 2);
}

function parseOpinion(text) {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    const obj = JSON.parse(cleaned);
    const recommendation = ["clear", "review", "escalate"].includes(obj.recommendation)
      ? obj.recommendation : "review";
    const confidence = ["low", "medium", "high"].includes(obj.confidence)
      ? obj.confidence : "medium";
    const reasoning = typeof obj.reasoning === "string" && obj.reasoning.trim()
      ? obj.reasoning.trim() : "The model didn't return readable reasoning for this one.";
    return { recommendation, confidence, reasoning };
  } catch {
    // Model didn't return clean JSON — surface the raw text rather than
    // silently failing, but mark it down as low-confidence.
    return { recommendation: "review", confidence: "low", reasoning: text.trim().slice(0, 500) || "No reasoning returned." };
  }
}

export async function generateOpinion({ checkType, subjectLabel, result }) {
  if (!ANTHROPIC_API_KEY) {
    return {
      ok: false,
      error: "AI opinion isn't live yet on this deployment — it needs an " +
        "ANTHROPIC_API_KEY to be configured.",
    };
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), OPINION_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 400,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildPrompt(checkType, subjectLabel, result) }],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { ok: false, error: `AI opinion request failed (HTTP ${res.status})`, detail: detail.slice(0, 300) };
    }

    const data = await res.json();
    const text = (data.content || []).map((c) => c.text || "").join("").trim();
    const { recommendation, confidence, reasoning } = parseOpinion(text);

    return {
      ok: true,
      recommendation,
      confidence,
      reasoning,
      model: ANTHROPIC_MODEL,
      generatedAt: new Date().toISOString(),
      disclaimer: "AI-generated reasoning over the deterministic signals above — " +
        "a second opinion to help a human move faster, not a compliance decision. " +
        "The underlying signals are the record of what was actually checked.",
    };
  } catch (err) {
    return { ok: false, error: "AI opinion request failed", detail: String(err?.message || err) };
  } finally {
    clearTimeout(t);
  }
}
