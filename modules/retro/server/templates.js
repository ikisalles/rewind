// Retrospective templates: the columns a sprint can start with.
// Each column has a short prompt (`hint`) shown in the note box.
// The web asks GET /api/retro/templates, so this file is the single source.

const GREEN = '#22c55e';
const RED = '#ef4444';
const BLUE = '#3b82f6';
const AMBER = '#f59e0b';
const PURPLE = '#a855f7';
const PINK = '#ec4899';

export const TEMPLATES = [
  {
    id: 'start-stop-continue',
    name: 'Start, Stop, Continue',
    description: 'Straight to action: what to begin, what to drop and what to keep.',
    columns: [
      { id: 'start', title: 'Start', color: GREEN, hint: 'What should we begin doing?' },
      { id: 'stop', title: 'Stop', color: RED, hint: "What isn't helping and should end?" },
      { id: 'continue', title: 'Continue', color: BLUE, hint: 'What works and should keep going?' },
    ],
  },
  {
    id: '4ls',
    name: '4Ls',
    description: 'Liked, Learned, Lacked, Longed for: balances what went well with what was missing.',
    columns: [
      { id: 'liked', title: 'Liked', color: GREEN, hint: 'What did you enjoy?' },
      { id: 'learned', title: 'Learned', color: BLUE, hint: 'What did you learn?' },
      { id: 'lacked', title: 'Lacked', color: AMBER, hint: 'What was missing?' },
      { id: 'longed', title: 'Longed for', color: PURPLE, hint: 'What do you wish we had?' },
    ],
  },
  {
    id: 'mad-sad-glad',
    name: 'Mad, Sad, Glad',
    description: 'Starts from feelings: good to surface frustration and team mood.',
    columns: [
      { id: 'mad', title: 'Mad', color: RED, hint: 'What frustrated you?' },
      { id: 'sad', title: 'Sad', color: BLUE, hint: 'What disappointed you?' },
      { id: 'glad', title: 'Glad', color: GREEN, hint: 'What made you happy?' },
    ],
  },
  {
    id: 'sailboat',
    name: 'Sailboat',
    description: 'A metaphor for the goal, what pushes the team, what slows it and the risks ahead.',
    columns: [
      { id: 'wind', title: 'Wind', color: GREEN, hint: 'What pushed us forward?' },
      { id: 'anchors', title: 'Anchors', color: RED, hint: 'What held us back?' },
      { id: 'rocks', title: 'Rocks', color: AMBER, hint: 'What risks are ahead?' },
      { id: 'island', title: 'Island', color: BLUE, hint: 'Where do we want to get to?' },
    ],
  },
  {
    id: 'starfish',
    name: 'Starfish',
    description: 'Five arms for finer adjustments than keep/stop: more of, less of, start, stop, keep.',
    columns: [
      { id: 'keep', title: 'Keep doing', color: GREEN, hint: 'What adds value as it is?' },
      { id: 'more', title: 'More of', color: BLUE, hint: 'What should we do more of?' },
      { id: 'less', title: 'Less of', color: AMBER, hint: 'What should we do less of?' },
      { id: 'stop', title: 'Stop doing', color: RED, hint: 'What should we drop?' },
      { id: 'start', title: 'Start doing', color: PURPLE, hint: 'What new thing should we try?' },
    ],
  },
  {
    id: 'rose-thorn-bud',
    name: 'Rose, Thorn, Bud',
    description: 'Highlights, pain points and the ideas worth growing.',
    columns: [
      { id: 'rose', title: 'Rose', color: PINK, hint: 'What went well?' },
      { id: 'thorn', title: 'Thorn', color: RED, hint: 'What was a pain?' },
      { id: 'bud', title: 'Bud', color: GREEN, hint: 'What has potential to grow?' },
    ],
  },
  {
    id: 'classic',
    name: 'Classic',
    description: "Rewind's original board: what went well, what could be better and ideas.",
    columns: [
      { id: 'good', title: 'What went well', color: GREEN, hint: 'What went well?' },
      { id: 'improve', title: 'What could be better', color: '#f3652b', hint: 'What could be better?' },
      { id: 'ideas', title: 'Ideas', color: BLUE, hint: 'What should we try?' },
    ],
  },
];

export const findTemplate = (id) => TEMPLATES.find((t) => t.id === id) || null;

// Used when an API client creates a sprint without saying how (kept for compatibility).
export const DEFAULT_TEMPLATE = 'classic';
