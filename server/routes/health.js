import { Router } from 'express';
import { services } from '../config.js';

export function healthRouter(cfg, engine) {
  const r = Router();
  r.get('/health', (req, res) => {
    res.json({ ok: true, engine: engine.name, mock: !!engine.mock, services: services(cfg) });
  });
  return r;
}
