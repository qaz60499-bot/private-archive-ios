import { describe, expect, it } from 'vitest'
import { classifyVisionFacts, parseVisionFacts, type VisionFacts } from '../../src/worker/services/analysis/classifier'

const base: VisionFacts = {
  capture: 'camera',
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

describe('structured archive classifier', () => {
  it('keeps true digital screenshots separate from camera photos', () => {
    expect(classifyVisionFacts({ ...base, capture: 'screenshot', people: 'portrait' })).toBe('screenshot')
  })

  it('classifies active group dining or play as gathering', () => {
    expect(classifyVisionFacts({ ...base, mainSubject: 'social', people: 'social', groupSize: '3+', socialActivity: true, food: 'strong' })).toBe('gathering')
  })

  it('classifies a road or in-transit scene as travel when a person is only incidental', () => {
    expect(classifyVisionFacts({ ...base, mainSubject: 'journey', people: 'incidental', groupSize: '1-2', journey: 'strong', nature: 'strong' })).toBe('travel')
  })

  it('keeps a genuine portrait in people even when scenery is present', () => {
    expect(classifyVisionFacts({ ...base, mainSubject: 'people', people: 'portrait', groupSize: '1-2', nature: 'strong', urban: 'weak' })).toBe('people')
  })

  it('classifies tourist landmarks as travel instead of other', () => {
    expect(classifyVisionFacts({ ...base, landmark: true, urban: 'strong' })).toBe('travel')
  })

  it('keeps dominant generic urban architecture in city', () => {
    expect(classifyVisionFacts({ ...base, mainSubject: 'urban', urban: 'strong', journey: 'weak' })).toBe('city')
  })

  it('keeps pure natural scenery in nature', () => {
    expect(classifyVisionFacts({ ...base, mainSubject: 'nature', nature: 'strong' })).toBe('nature')
  })

  it('uses people only for genuine portrait-style composition', () => {
    expect(classifyVisionFacts({ ...base, mainSubject: 'people', people: 'portrait', groupSize: '1-2' })).toBe('people')
  })

  it('does not treat a person in a journey scene as people unless the photo is actually about the person', () => {
    expect(classifyVisionFacts({ ...base, mainSubject: 'journey', people: 'portrait', journey: 'strong', landmark: true })).toBe('travel')
  })

  it('keeps other as the final fallback only', () => {
    expect(classifyVisionFacts(base)).toBe('other')
  })

  it('parses a structured fact line even with extra whitespace', () => {
    const facts = parseVisionFacts('CAPTURE=camera; PEOPLE=incidental; GROUP=1-2; SOCIAL=no; JOURNEY=strong; LANDMARK=no; URBAN=weak; NATURE=strong; FOOD=none')
    expect(facts.journey).toBe('strong')
    expect(facts.people).toBe('incidental')
    expect(classifyVisionFacts(facts)).toBe('travel')
  })
})
