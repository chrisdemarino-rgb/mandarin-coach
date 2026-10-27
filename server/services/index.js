import { createOpenAI } from './openai.js';
import { createTts } from './tts.js';
import { createCues } from './cues.js';
import { createAudioCache } from '../lib/audioCache.js';

/** Provider wiring. `llm` (LLMProvider interface: available, chatStream, chatJson) is OpenAI-only for now. */
export function createServices(cfg) {
  const openai = createOpenAI(cfg);
  const tts = createTts(cfg, openai);
  const audioCache = createAudioCache();
  const cues = createCues({ llm: openai });
  return { llm: openai, stt: openai, tts, audioCache, cues };
}
