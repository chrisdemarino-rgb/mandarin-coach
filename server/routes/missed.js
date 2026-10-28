// "Words I don't know" list + trouble-word drill queue. Minimal data only (see db.js missed_words): no audio, no transcripts.
import { Router } from 'express';
import { drillTarget } from '../lib/missed.js';

const err = (res, status, code, message) => res.status(status).json({ ok: false, error: { code, message } });
const parseId = (s) => (/^\d{1,12}$/.test(s) ? Number(s) : null);

export function missedRouter({ db, cfg }) {
  const r = Router();
  const needed = cfg.drillGraduateStreak;
  const shape = (w) => ({ id: w.id, text: w.text, pinyin: w.pinyin ?? null, meaning: w.meaning ?? null, missCount: w.missCount, correctStreak: w.correctStreak, needed,
    lastMissedAt: w.lastMissedAt, sourceChunk: w.sourceChunk ?? null, status: w.status });

  r.get('/words/missed', (req, res) => res.json(db.listMissed(req.query.all === '1' || req.query.all === 'true').map(shape)));

  const setStatus = (status) => (req, res) => {
    const id = parseId(req.params.id);
    if (id == null || !db.setMissedStatus(id, status)) return err(res, 404, 'not_found', 'No such missed word.');
    res.status(204).end();
  };
  r.post('/words/missed/:id/known', setStatus('known'));
  r.post('/words/missed/:id/learning', setStatus('learning'));
  r.delete('/words/missed/:id', (req, res) => {
    const id = parseId(req.params.id);
    if (id == null || !db.deleteMissed(id)) return err(res, 404, 'not_found', 'No such missed word.');
    res.status(204).end();
  });

  // Drill queue: learning words, least-practised streak first, then most-missed, then most recent.
  r.get('/drill/next', (req, res) => {
    const n = Math.max(1, Math.min(20, Number.parseInt(req.query.n ?? '5', 10) || 5));
    res.json(db.drillQueue(n).map((w) => ({ wordId: w.id, text: w.text, pinyin: w.pinyin ?? null, meaning: w.meaning ?? null, exampleSentence: w.sourceChunk ?? null,
      promptText: drillTarget(w).promptText, correctStreak: w.correctStreak, needed })));
  });
  return r;
}
