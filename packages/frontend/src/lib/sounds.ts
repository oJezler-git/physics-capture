import { defineSound } from '@web-kits/audio';

/**
 * Tactical UI sounds for the physics-capture interface.
 * Designed to feel premium and responsive.
 */

export const sounds = {
  // Standard interaction
  click: defineSound({
    source: { type: 'sine', frequency: { start: 450, end: 380 } },
    envelope: { decay: 0.08 },
    gain: 0.25,
  }),

  hover: defineSound({
    source: { type: 'sine', frequency: 220 },
    envelope: { decay: 0.04 },
    gain: 0.08,
  }),

  // State changes
  success: defineSound({
    source: { type: 'sine', frequency: { start: 300, end: 600 } },
    envelope: { decay: 0.15 },
    gain: 0.2,
  }),

  error: defineSound({
    source: { type: 'square', frequency: { start: 150, end: 100 } },
    envelope: { decay: 0.2 },
    gain: 0.15,
  }),

  // Action specific
  start: defineSound({
    source: { type: 'sine', frequency: { start: 400, end: 800 } },
    envelope: { decay: 0.1 },
    gain: 0.3,
  }),

  stop: defineSound({
    source: { type: 'sine', frequency: { start: 800, end: 400 } },
    envelope: { decay: 0.1 },
    gain: 0.3,
  }),
};
