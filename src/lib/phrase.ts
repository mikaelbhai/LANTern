/**
 * Six-word pairing phrases, BIP-39 in spirit.
 *
 * Words are visually distinct and easy to say aloud, so a phrase survives being
 * read over the phone or written on a sticky note — the out-of-band channel
 * that makes pairing possible when no shared network path exists.
 */

export const WORDLIST: string[] = [
  'amber', 'anchor', 'apple', 'arbor', 'arrow', 'atlas', 'aurora', 'autumn',
  'basin', 'beacon', 'birch', 'bison', 'blossom', 'bramble', 'brass', 'breeze',
  'bridge', 'bronze', 'brook', 'burrow', 'cabin', 'canvas', 'canyon', 'cedar',
  'cinder', 'circuit', 'cliff', 'clover', 'cobalt', 'comet', 'compass', 'copper',
  'coral', 'cotton', 'crater', 'crescent', 'crimson', 'crystal', 'cypress', 'dagger',
  'dawn', 'delta', 'dune', 'dusk', 'eagle', 'ember', 'engine', 'estuary',
  'falcon', 'fathom', 'fern', 'fjord', 'flame', 'flint', 'forest', 'fossil',
  'foxglove', 'fresco', 'frost', 'gable', 'galley', 'garnet', 'gateway', 'geyser',
  'ginger', 'glacier', 'glimmer', 'granite', 'gravel', 'grotto', 'grove', 'harbor',
  'harvest', 'hazel', 'heather', 'hemlock', 'heron', 'hollow', 'horizon', 'ibis',
  'indigo', 'inlet', 'iris', 'island', 'ivory', 'jasper', 'jetty', 'juniper',
  'kelp', 'kestrel', 'keystone', 'kindle', 'lagoon', 'lantern', 'lark', 'lattice',
  'laurel', 'ledger', 'lichen', 'lighthouse', 'lilac', 'linen', 'lodge', 'lotus',
  'lumen', 'lunar', 'lyric', 'magnet', 'mahogany', 'mallow', 'maple', 'marble',
  'marina', 'marsh', 'meadow', 'meridian', 'mesa', 'mica', 'midnight', 'mineral',
  'mirage', 'mist', 'monsoon', 'moraine', 'mosaic', 'moss', 'nectar', 'needle',
  'nimbus', 'north', 'nova', 'oasis', 'obsidian', 'ocean', 'ochre', 'olive',
  'onyx', 'opal', 'orbit', 'orchard', 'osprey', 'otter', 'outpost', 'oxide',
  'pagoda', 'palm', 'papyrus', 'parapet', 'pasture', 'pebble', 'pelican', 'pepper',
  'petal', 'pewter', 'pigeon', 'pillar', 'pine', 'pivot', 'plateau', 'plume',
  'pollen', 'poplar', 'portal', 'prairie', 'prism', 'pueblo', 'pulsar', 'pumice',
  'quarry', 'quartz', 'quiet', 'quill', 'radiant', 'rafter', 'rapids', 'raven',
  'reed', 'reef', 'relay', 'ridge', 'rill', 'ripple', 'river', 'rivet',
  'rowan', 'rudder', 'ruby', 'runner', 'saffron', 'sage', 'sandbar', 'sapphire',
  'satchel', 'savanna', 'scarlet', 'seaside', 'sepia', 'shale', 'shelter', 'shore',
  'signal', 'silica', 'silver', 'sitka', 'slate', 'sleet', 'socket', 'solstice',
  'sonar', 'spindle', 'spire', 'spruce', 'stanza', 'starling', 'station', 'steppe',
  'stone', 'stratus', 'stream', 'sumac', 'summit', 'sunset', 'switch', 'sycamore',
  'talon', 'tamarind', 'tandem', 'tangle', 'tapestry', 'teal', 'tempo', 'tendril',
  'terrace', 'thicket', 'thistle', 'thunder', 'tidal', 'timber', 'tinder', 'topaz',
  'torrent', 'tower', 'trellis', 'tributary', 'trillium', 'tundra', 'tunnel', 'turret',
  'umber', 'valley', 'vector', 'velvet', 'verdant', 'vertex', 'vessel', 'vineyard',
  'violet', 'vista', 'walnut', 'warren', 'willow', 'window', 'winter', 'zephyr',
];

const INDEX = new Map(WORDLIST.map((w, i) => [w, i]));

/** Derives a stable six-word phrase from a device fingerprint. */
export function phraseFromFingerprint(fingerprint: string): string {
  let h = 2166136261;
  const words: string[] = [];
  for (let i = 0; i < 6; i++) {
    for (const ch of `${fingerprint}:${i}`) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 16777619);
    }
    words.push(WORDLIST[(h >>> 0) % WORDLIST.length]);
  }
  return words.join(' ');
}

export interface PhraseCheck {
  valid: boolean;
  reason?: string;
  unknownWords: string[];
}

export function validatePhrase(input: string): PhraseCheck {
  const words = input.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length !== 6) {
    return {
      valid: false,
      reason: `Expected 6 words, got ${words.length}`,
      unknownWords: [],
    };
  }
  const unknown = words.filter((w) => !INDEX.has(w));
  if (unknown.length) {
    return {
      valid: false,
      reason: 'Contains words outside the pairing list',
      unknownWords: unknown,
    };
  }
  return { valid: true, unknownWords: [] };
}
