// @ts-expect-error -- this regression test executes under Vitest's Node runtime; the app tsconfig intentionally omits Node globals.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const repository = readFileSync(new URL('../../src/worker/db/assets-repository.ts', import.meta.url), 'utf8')

function section(start: string, end: string): string {
  const from = repository.indexOf(start)
  const to = repository.indexOf(end, from + start.length)
  expect(from).toBeGreaterThanOrEqual(0)
  expect(to).toBeGreaterThan(from)
  return repository.slice(from, to)
}

describe('upload commit state guards', () => {
  it('does not repair a trashed asset and completes the job only after a stored attachment', () => {
    const repair = section('export async function repairAssetFromActiveStorageObject', 'export async function createDeduplicatedLogicalAsset')
    expect(repair).toContain("status != 'trashed'")
    expect(repair).toContain('db.batch([')
    expect(repair).toContain("status = 'stored' AND storage_object_id = ?")
  })

  it('binds a commit to the exact latest upload-job lease, not only an attempt number', () => {
    const claim = section('export async function claimUploadStarted', 'export interface MarkStoredResult')
    const commit = section('export async function markStored', 'export async function markUploadFailed')
    expect(claim).toContain('RETURNING id, attempts')
    expect(claim).toContain('jobId: row.id')
    expect(commit).toContain("status != 'trashed'")
    expect(commit).toContain('id = ? AND asset_id = ?')
    expect(commit).toContain("status = 'uploading' AND attempts = ?")
    expect(commit).toContain('latest.id !== expectedLease.jobId')
    expect(commit).toContain('staleAttempt: true')
  })

  it('keeps failed-job and failed-asset transitions in one exact-lease batch', () => {
    const failure = section('export async function markUploadFailed', 'export async function markPreviewStored')
    expect(failure).toContain('const [job] = await db.batch([')
    expect(failure).toContain("status = 'failed' AND attempts = ?")
    expect(failure).toContain('id = ? AND asset_id = ?')
    expect(failure).toContain('return job.meta.changes > 0')
  })

  it('compares multi-dot capture stems with the shared normalizer after indexed narrowing', () => {
    const capture = section('export async function getActiveStoredPhotoByCaptureIdentity', 'export interface StorageObjectState')
    expect(capture).toContain('assets.taken_at = ? AND assets.width = ? AND assets.height = ?')
    expect(capture).not.toContain('instr(assets.original_name')
    expect(capture).toContain('normalizedFileStem(candidate.original_name) === stem')
  })
})
