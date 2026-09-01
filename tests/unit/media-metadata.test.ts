import { describe, expect, it } from 'vitest'
import { validateReserveInput } from '../../src/worker/domain/policy'

describe('photo metadata reserve contract', () => {
  it('preserves normalized capture time, GPS and bounded camera metadata', () => {
    const input = validateReserveInput({
      originalName: 'iphone-photo.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 923,
      mediaType: 'photo',
      takenAt: '2024-05-06T07:08:09.000Z',
      fileCreatedAt: '2026-08-31T12:00:00.000Z',
      latitude: 37.775,
      longitude: -122.419444,
      storageBackend: 'telegram_bot',
      metadata: { cameraMake: 'Apple', cameraModel: 'iPhone 15 Pro', gpsAltitude: 15 },
    })

    expect(input.takenAt).toBe('2024-05-06T07:08:09.000Z')
    expect(input.latitude).toBeCloseTo(37.775, 4)
    expect(input.longitude).toBeCloseTo(-122.419444, 4)
    expect(input.metadata).toMatchObject({ cameraMake: 'Apple', cameraModel: 'iPhone 15 Pro', gpsAltitude: 15 })
  })
})
