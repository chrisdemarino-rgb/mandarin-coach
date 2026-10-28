import { Router } from 'express';

const ENUMS = {
  chunkMode: ['sentence', 'four', 'paragraph'],
  assessMode: ['close', 'retell'],
  practiceMode: ['listen_repeat', 'fading_cues', 'trouble_word'], // trouble_word = the missed-word drill screen (its own endpoints: /api/drill/*)
};
const bad = (res, message) => res.status(400).json({ ok: false, error: { code: 'invalid_prefs', message } });

export function validatePrefs(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Body must be a JSON object.' };
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (k in ENUMS) {
      if (!ENUMS[k].includes(v)) return { error: `${k} must be one of ${ENUMS[k].join('|')}.` };
      out[k] = v;
    } else if (k === 'voice') {
      if (typeof v !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(v)) return { error: 'voice must be a voice id string.' };
      out[k] = v;
    } else if (k === 'speed') {
      if (typeof v !== 'number' || !(v >= 0.6 && v <= 1.2)) return { error: 'speed must be a number between 0.6 and 1.2.' };
      out[k] = v;
    } else {
      return { error: `Unknown preference "${k}".` };
    }
  }
  return { value: out };
}

export function prefsRouter(db) {
  const r = Router();
  r.get('/prefs', (req, res) => res.json(db.getPrefs()));
  r.put('/prefs', (req, res) => {
    const { value, error } = validatePrefs(req.body);
    if (error) return bad(res, error);
    db.setPrefs(value); // partial update: only provided keys change
    res.json(db.getPrefs());
  });
  return r;
}
