import { Router } from 'express';

const err = (res, status, code, message) => res.status(status).json({ ok: false, error: { code, message } });
const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const parseId = (s) => (/^\d{1,12}$/.test(s) ? Number(s) : null);

export function wordsRouter(db) {
  const r = Router();

  r.get('/words', (req, res) => res.json(db.listWords()));

  r.post('/words', (req, res) => {
    const text = str(req.body?.text, 100);
    if (!text) return err(res, 400, 'invalid_word', 'text is required (max 100 chars).');
    const { id, created } = db.addWord({
      text, pinyin: str(req.body.pinyin, 200), meaning: str(req.body.meaning, 300), sourceChunk: str(req.body.sourceChunk, 200),
    });
    res.status(created ? 201 : 200).json({ ...db.getWord(id), created });
  });

  r.delete('/words/:id', (req, res) => {
    const id = parseId(req.params.id);
    if (id == null || !db.deleteWord(id)) return err(res, 404, 'not_found', 'No such saved word.');
    res.status(204).end();
  });

  // Minimal history: {result} is a short label ("ok"|"tone_error"|"uncertain"|"skipped"...) or a small
  // object of numeric scores {toneScore, initialScore, finalScore, mode}. No audio, no transcripts.
  r.post('/words/:id/history', (req, res) => {
    const id = parseId(req.params.id);
    if (id == null || !db.getWord(id)) return err(res, 404, 'not_found', 'No such saved word.');
    let result = req.body?.result;
    if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
      const clean = {};
      for (const k of ['mode', 'outcome']) if (typeof result[k] === 'string') clean[k] = result[k].slice(0, 32);
      for (const k of ['toneScore', 'initialScore', 'finalScore']) if (typeof result[k] === 'number' && Number.isFinite(result[k])) clean[k] = result[k];
      if (!Object.keys(clean).length) return err(res, 400, 'invalid_result', 'result object has no recognised fields.');
      result = JSON.stringify(clean);
    } else if (typeof result === 'string' && /^[\w .:-]{1,64}$/.test(result)) {
      /* ok */
    } else {
      return err(res, 400, 'invalid_result', 'result must be a short string or an object {mode,outcome,toneScore,initialScore,finalScore}.');
    }
    db.addHistory(id, result);
    res.status(201).json({ ok: true, history: db.wordHistory(id) });
  });

  return r;
}
