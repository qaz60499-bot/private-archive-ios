export type Strength = 'none' | 'weak' | 'strong'
export type PeopleFocus = 'none' | 'incidental' | 'portrait' | 'social'
export type GroupSize = '0' | '1-2' | '3+'
export type MainSubject = 'people' | 'social' | 'journey' | 'urban' | 'nature' | 'food' | 'other'

export interface VisionFacts {
  capture: 'camera' | 'screenshot' | 'unknown'
  mainSubject: MainSubject
  people: PeopleFocus
  groupSize: GroupSize
  socialActivity: boolean
  journey: Strength
  landmark: boolean
  urban: Strength
  nature: Strength
  food: Strength
}

export const EMPTY_VISION_FACTS: VisionFacts = {
  capture: 'unknown',
  mainSubject: 'other',
  people: 'none',
  groupSize: '0',
  socialActivity: false,
  journey: 'none',
  landmark: false,
  urban: 'none',
  nature: 'none',
  food: 'none',
}

const FACT_PATTERN = /\b(CAPTURE|PEOPLE|GROUP|SOCIAL|JOURNEY|LANDMARK|URBAN|NATURE|FOOD)\s*=\s*([^;\n]+)/gi

function strength(value: unknown): Strength {
  return value === 'strong' || value === 'weak' ? value : 'none'
}

export function coerceVisionFacts(value: unknown): VisionFacts {
  if (!value || typeof value !== 'object') return { ...EMPTY_VISION_FACTS }
  const record = value as Record<string, unknown>
  const mainSubject: MainSubject = ['people', 'social', 'journey', 'urban', 'nature', 'food', 'other'].includes(String(record.mainSubject))
    ? record.mainSubject as MainSubject
    : 'other'
  return {
    capture: record.capture === 'camera' || record.capture === 'screenshot' ? record.capture : 'unknown',
    mainSubject,
    people: record.people === 'incidental' || record.people === 'portrait' || record.people === 'social' ? record.people : 'none',
    groupSize: record.groupSize === '1-2' || record.groupSize === '3+' ? record.groupSize : '0',
    socialActivity: record.socialActivity === true,
    journey: strength(record.journey),
    landmark: record.landmark === true,
    urban: strength(record.urban),
    nature: strength(record.nature),
    food: strength(record.food),
  }
}

export function parseVisionFacts(answer: string): VisionFacts {
  const values = new Map<string, string>()
  for (const match of answer.matchAll(FACT_PATTERN)) values.set(match[1].toUpperCase(), match[2].trim().toLowerCase())
  return coerceVisionFacts({
    capture: values.get('CAPTURE'),
    mainSubject: 'other',
    people: values.get('PEOPLE'),
    groupSize: values.get('GROUP'),
    socialActivity: values.get('SOCIAL') === 'yes',
    journey: values.get('JOURNEY'),
    landmark: values.get('LANDMARK') === 'yes',
    urban: values.get('URBAN'),
    nature: values.get('NATURE'),
    food: values.get('FOOD'),
  })
}

export function classifyVisionFacts(facts: VisionFacts): string {
  // Capture method is orthogonal to scene semantics and must be resolved first.
  if (facts.capture === 'screenshot') return 'screenshot'

  // A real shared social activity is a gathering, not merely a photo that contains several people.
  if (facts.mainSubject === 'social' || (facts.socialActivity && (facts.groupSize === '3+' || facts.people === 'social'))) return 'gathering'

  // "People" is deliberately narrow: the photograph must actually be about the person/people.
  // A person merely standing in a travel, landmark or environmental scene must not steal the category.
  if (facts.mainSubject === 'people' && facts.people === 'portrait') return 'people'

  // Journey is about the trip/process/destination. This may overlap softly with nature; either can be reasonable
  // when scenery is ambiguous, but explicit transit or attraction cues should stay travel.
  if (facts.mainSubject === 'journey' || facts.journey === 'strong' || facts.landmark) return 'travel'

  // Generic built environments stay city; they do not become travel just because they were photographed on a trip.
  if (facts.mainSubject === 'urban' || facts.urban === 'strong') return 'city'

  // Pure natural scenery is nature when there is no strong journey cue.
  if (facts.mainSubject === 'nature' || facts.nature === 'strong') return 'nature'

  // Food is used when food/drink is the actual subject, after gathering and portrait have been ruled out.
  if (facts.mainSubject === 'food' || facts.food === 'strong') return 'food'

  // A portrait-like cue without an explicit main-subject decision is only a fallback, never a reason to
  // override a stronger journey/city/nature interpretation.
  if (facts.people === 'portrait') return 'people'

  // Weak cues resolve otherwise ambiguous scenes; `other` is never chosen before them.
  if (facts.journey === 'weak') return 'travel'
  if (facts.urban === 'weak') return 'city'
  if (facts.nature === 'weak') return 'nature'
  if (facts.food === 'weak') return 'food'
  if (facts.socialActivity) return 'gathering'

  return 'other'
}
