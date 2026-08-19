import { normalizeTags } from '../../domain/policy'
import type { AssetRow } from '../../domain/types'
import type { Env } from '../../env'
import type { AnalysisResult } from '../../db/analysis-repository'
import type { StorageAdapter } from '../storage/storage-adapter'
import { fetchPreviewCached } from '../storage/preview-cache'
import { classifyVisionFacts, coerceVisionFacts, type VisionFacts } from './classifier'

const VISION_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct'
const STRUCTURE_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast'

const FACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    capture: { type: 'string', enum: ['camera', 'screenshot', 'unknown'] },
    mainSubject: { type: 'string', enum: ['people', 'social', 'journey', 'urban', 'nature', 'food', 'other'] },
    people: { type: 'string', enum: ['none', 'incidental', 'portrait', 'social'] },
    groupSize: { type: 'string', enum: ['0', '1-2', '3+'] },
    socialActivity: { type: 'boolean' },
    journey: { type: 'string', enum: ['none', 'weak', 'strong'] },
    landmark: { type: 'boolean' },
    urban: { type: 'string', enum: ['none', 'weak', 'strong'] },
    nature: { type: 'string', enum: ['none', 'weak', 'strong'] },
    food: { type: 'string', enum: ['none', 'weak', 'strong'] },
  },
  required: ['capture', 'mainSubject', 'people', 'groupSize', 'socialActivity', 'journey', 'landmark', 'urban', 'nature', 'food'],
} as const

const VISION_DESCRIPTION_PROMPT = `Describe this image for a private photo-archive classifier. Do not assign a category. Give a compact but concrete visual description and explicitly cover, when visible:
- whether this is a direct digital screenshot or a camera photograph;
- what the photograph is deliberately ABOUT: a person/portrait, a shared social activity, a journey/destination, an urban environment, natural scenery, food, or something else;
- how many people are visible and whether they are the main portrait subject, incidental, or actively socializing;
- whether people are eating together, chatting, celebrating, playing, partying, or doing a shared group activity;
- roads, driving, car interiors/windows, trains, planes, stations, airports, vehicles, route/roadside or in-transit cues;
- tourist attractions, sightseeing landmarks, scenic attraction entrances, monuments, museums or obvious travel destinations;
- whether generic city buildings/streets/urban architecture dominate;
- whether pure natural scenery such as mountains, forest, sea, lake, river, plants or landscape dominates;
- whether food or drink itself is the visual subject.
Do not identify people. Do not infer an exact address. Do not output an archive category slug.`

const STRUCTURE_SYSTEM_PROMPT = `You convert a visual description into archival visual facts. Do not choose a final archive category. Follow the requested JSON schema exactly.

Rules for the fields:
- capture=screenshot ONLY for a direct pixel-native phone/computer/tablet/app/website/chat/system capture. A camera photo of a screen, sign, poster, printed page, artwork, architecture or text is camera.
- mainSubject means what the photographer is primarily trying to show, not every object visible in the frame. Use people only when this is specifically a human portrait/selfie/posed-human photograph; social for a shared group activity; journey for being on the road/in transit/at an obvious sightseeing destination; urban for built city space; nature for scenery itself; food for food/drink itself; otherwise other.
- people=portrait ONLY when the image is deliberately framed as a person photo: a portrait, selfie, posed photo, or clearly human-dominant composition. A person standing somewhere in a road, scenic, landmark, museum, attraction or travel photo is incidental unless the composition is unmistakably centered on photographing that person.
- people=incidental when people exist but road, vehicle, city, scenery, attraction, food or another scene is the real subject.
- people=social when a group is visibly interacting in a shared activity.
- groupSize=3+ for three or more visible people or a clearly larger group.
- socialActivity=true only for visible shared social behavior: eating together, chatting, celebrating, playing, partying or participating in an event. A posed group photo without shared activity is false.
- journey=strong for driving/on-road scenes, car interiors/window views, trains, planes, airports, stations, vehicles in transit, route/roadside scenes or obvious travel-in-progress. Obvious sightseeing destinations/attraction entrances can also make mainSubject=journey. journey=weak for plausible travel context without a strong transit cue.
- landmark=true for an obvious sightseeing attraction, tourist landmark, scenic attraction entrance, monument, museum/attraction destination or clear tourist-destination scene. Ordinary generic buildings are not landmarks.
- urban=strong when generic city buildings, streets, commercial areas, architecture or skyline dominate; weak when secondary.
- nature=strong when mountains, forests, sea, lakes, rivers, plants, flowers, grassland or natural landscape dominate. The travel/nature boundary is intentionally soft: a scenic destination may reasonably be journey while a scenery-only image may be nature. Do not force a precise distinction when both are plausible.
- food=strong when food/drink itself is the visual subject. If several people eating together are the main event, people should be social and socialActivity should be true even if food is also strong.

Conflict discipline:
- A road/travel/attraction scene does not become a portrait merely because a person appears in it. Recent owner corrections repeatedly moved such photos out of people and into travel, so be conservative about mainSubject=people.
- A genuine portrait does not become nature/city merely because scenery is behind the subject.
- A generic city building does not become travel merely because it might have been photographed on a trip.
- A pure natural landscape does not become travel unless there is road/vehicle/transit/landmark or clear journey-process evidence.
- A多人聚餐/共同活动 description should map to people=social and socialActivity=true.`

type JsonAiRunner = {
  run(model: string, input: Record<string, unknown>): Promise<unknown>
}

function resultForCategory(primaryCategory: string, confidence = 0.9): AnalysisResult {
  const tagCandidates = primaryCategory === 'gathering' ? ['gathering', 'people'] : [primaryCategory]
  const tags = normalizeTags(tagCandidates)
  const personCount = ['people', 'gathering'].includes(primaryCategory) ? 1 : 0
  const scene = ['city', 'nature', 'travel'].includes(primaryCategory)
    ? 'outdoor'
    : ['food', 'screenshot', 'gathering'].includes(primaryCategory)
      ? 'indoor'
      : 'unknown'
  return { primaryCategory, tags, personCount, scene, confidence }
}

function mockFacts(asset: AssetRow): VisionFacts {
  const name = asset.original_name.toLowerCase()
  if (/screen|capture/.test(name)) return { capture: 'screenshot', mainSubject: 'other', people: 'none', groupSize: '0', socialActivity: false, journey: 'none', landmark: false, urban: 'none', nature: 'none', food: 'none' }
  if (/party|gather|dinner|celebration|event/.test(name)) return { capture: 'camera', mainSubject: 'social', people: 'social', groupSize: '3+', socialActivity: true, journey: 'none', landmark: false, urban: 'none', nature: 'none', food: /dinner/.test(name) ? 'strong' : 'none' }
  if (/road|drive|train|airport|window|travel|trip/.test(name)) return { capture: 'camera', mainSubject: 'journey', people: 'incidental', groupSize: '1-2', socialActivity: false, journey: 'strong', landmark: false, urban: 'weak', nature: 'weak', food: 'none' }
  if (/portrait|selfie|people|friend|group/.test(name)) return { capture: 'camera', mainSubject: 'people', people: 'portrait', groupSize: /group/.test(name) ? '3+' : '1-2', socialActivity: false, journey: 'none', landmark: false, urban: 'none', nature: 'weak', food: 'none' }
  if (/city|street|metro|architecture|building/.test(name)) return { capture: 'camera', mainSubject: 'urban', people: 'none', groupSize: '0', socialActivity: false, journey: 'none', landmark: false, urban: 'strong', nature: 'none', food: 'none' }
  if (/nature|garden|mountain|lake|coast|forest|sea/.test(name)) return { capture: 'camera', mainSubject: 'nature', people: 'none', groupSize: '0', socialActivity: false, journey: 'none', landmark: false, urban: 'none', nature: 'strong', food: 'none' }
  if (/food|coffee/.test(name)) return { capture: 'camera', mainSubject: 'food', people: 'none', groupSize: '0', socialActivity: false, journey: 'none', landmark: false, urban: 'none', nature: 'none', food: 'strong' }
  return { capture: 'camera', mainSubject: 'other', people: 'none', groupSize: '0', socialActivity: false, journey: 'none', landmark: false, urban: 'none', nature: 'none', food: 'none' }
}

function bytesToDataUrl(bytes: Uint8Array, mimeType: string): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  return `data:${mimeType};base64,${btoa(binary)}`
}

function textResponse(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (!raw || typeof raw !== 'object') return ''
  const response = (raw as Record<string, unknown>).response
  return typeof response === 'string' ? response : ''
}

function structuredResponse(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return null
  const response = (raw as Record<string, unknown>).response
  if (response && typeof response === 'object') return response
  if (typeof response === 'string') {
    try { return JSON.parse(response) } catch { return null }
  }
  return null
}

export async function analyzeAsset(env: Env, storage: StorageAdapter, asset: AssetRow): Promise<AnalysisResult | null> {
  if (asset.media_type === 'file' && !asset.preview_file_id) return null
  if (env.MOCK_TELEGRAM === 'true') return resultForCategory(classifyVisionFacts(mockFacts(asset)))
  if (!asset.preview_file_id) return null

  const preview = await fetchPreviewCached(storage, asset.preview_file_id)
  if (!preview.ok) throw new Error(`PREVIEW_FETCH_FAILED:${preview.status}`)
  const bytes = new Uint8Array(await preview.arrayBuffer())
  if (bytes.byteLength > 2 * 1024 * 1024) throw new Error('PREVIEW_TOO_LARGE_FOR_ANALYSIS')
  const contentType = preview.headers.get('content-type')
  const image = bytesToDataUrl(bytes, contentType?.startsWith('image/') ? contentType : 'image/jpeg')
  const ai = env.AI as unknown as JsonAiRunner

  const visionRaw = await ai.run(VISION_MODEL, {
    prompt: VISION_DESCRIPTION_PROMPT,
    image,
    stream: false,
    temperature: 0,
    max_tokens: 220,
  })
  const description = textResponse(visionRaw)
  if (!description) throw new Error('VISION_DESCRIPTION_EMPTY')

  const structuredRaw = await ai.run(STRUCTURE_MODEL, {
    messages: [
      { role: 'system', content: STRUCTURE_SYSTEM_PROMPT },
      { role: 'user', content: description },
    ],
    stream: false,
    temperature: 0,
    max_tokens: 160,
    response_format: {
      type: 'json_schema',
      json_schema: FACT_SCHEMA,
    },
  })

  const facts = coerceVisionFacts(structuredResponse(structuredRaw))
  const category = classifyVisionFacts(facts)
  return resultForCategory(category, category === 'other' ? 0.72 : 0.93)
}
